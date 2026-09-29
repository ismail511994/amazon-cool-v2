// Amazon Cool HVAC Pro — auto-assign
// نسخة من منطق التعيين التلقائي (assignNext الموجود في index.html) لكن على الخادم،
// عشان يشتغل حتى لو مفيش عميل أو أدمن فاتح المتصفح.
//
// المطلوب: جدولتها للعمل كل دقيقة تقريبًا عبر Supabase Cron (Dashboard → Edge Functions →
// اختر الدالة → Cron Jobs → كل دقيقة)، أو عبر pg_cron + pg_net من داخل قاعدة البيانات:
//
//   select cron.schedule(
//     'auto-assign-every-minute', '* * * * *',
//     $$ select net.http_post(
//          url:='https://<project-ref>.supabase.co/functions/v1/auto-assign',
//          headers:=jsonb_build_object('Authorization','Bearer <SERVICE_ROLE_KEY>')
//        ); $$
//   );
//
// الدالة بتعمل شيئين في كل تشغيلة:
//  1) العروض المنتهية (assignment_status='offered' ومر عليها وقت الانتظار): تتحول
//     تلقائيًا للفني التالي الأقرب، أو تتحول لـ admin_required لو مفيش فني متاح.
//  2) الطلبات الجديدة (status='pending' وبدون assignment_status ولها إحداثيات عميل)
//     واللي عدى على إنشائها أكتر من 20 ثانية (فترة سماح لمحاولة العميل نفسه): بيتم
//     البحث لها عن أقرب فني وعرض الطلب عليه.
//
// الدالة تستخدم صلاحية الخادم الكاملة (Service Role) لأنها مش مربوطة بمستخدم معيّن.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

const OFFER_SECONDS = 60
const ASSIGN_LIMIT = 5
const NEW_ORDER_GRACE_SECONDS = 20

function distanceKm(a: number, b: number, c: number, d: number) {
  const R = 6371, rad = Math.PI / 180
  const dLat = (c - a) * rad, dLon = (d - b) * rad
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)

    async function nearestTechs(lat: number, lng: number, excludePhones: string[]) {
      try {
        const r = await admin.rpc('find_nearest_techs', { lat, lng, limit: ASSIGN_LIMIT })
        if (!r.error && Array.isArray(r.data) && r.data.length) {
          return r.data.filter((t: any) => !excludePhones.includes(t.phone))
        }
      } catch (_e) { /* fallback بالأسفل */ }
      const r2 = await admin.from('tech_apps')
        .select('phone,name,availability,status,current_lat,current_lng')
        .eq('status', 'approved')
      return (r2.data || [])
        .filter((t: any) => t.availability === 'available'
          && Number.isFinite(Number(t.current_lat)) && Number.isFinite(Number(t.current_lng))
          && !excludePhones.includes(t.phone))
        .map((t: any) => ({ ...t, distance_km: distanceKm(lat, lng, Number(t.current_lat), Number(t.current_lng)) }))
        .sort((a: any, b: any) => a.distance_km - b.distance_km)
        .slice(0, ASSIGN_LIMIT)
    }

    async function offerToNext(order: any) {
      const rejectedBy: string[] = Array.isArray(order.rejected_by) ? order.rejected_by : []
      const candidates = await nearestTechs(Number(order.customer_lat), Number(order.customer_lng), rejectedBy)
      const timeline = Array.isArray(order.timeline) ? order.timeline : []
      if (!candidates.length) {
        await admin.from('orders').update({ assignment_status: 'admin_required' }).eq('id', order.id)
        return 'admin_required'
      }
      const c = candidates[0]
      const phone = c.phone || c.tech_phone
      const expires = new Date(Date.now() + OFFER_SECONDS * 1000).toISOString()
      timeline.push({ status: 'assignment_offered', at: new Date().toISOString(), tech_phone: phone, expires_at: expires, by: 'auto-assign' })
      await admin.from('orders').update({
        assigned_tech_phone: phone,
        assignment_status: 'offered',
        assignment_expires_at: expires,
        status: 'assigned',
        timeline,
      }).eq('id', order.id)
      return 'offered'
    }

    // 1) العروض المنتهية
    const nowIso = new Date().toISOString()
    const { data: expired, error: expErr } = await admin
      .from('orders')
      .select('*')
      .eq('assignment_status', 'offered')
      .lt('assignment_expires_at', nowIso)
    if (expErr) return json({ error: expErr.message }, 500)

    let expiredHandled = 0
    for (const order of expired || []) {
      const rejectedBy: string[] = Array.isArray(order.rejected_by) ? order.rejected_by : []
      if (order.assigned_tech_phone && !rejectedBy.includes(order.assigned_tech_phone)) {
        rejectedBy.push(order.assigned_tech_phone)
      }
      const timeline = Array.isArray(order.timeline) ? order.timeline : []
      timeline.push({ status: 'assignment_expired', at: nowIso, tech_phone: order.assigned_tech_phone, by: 'auto-assign' })
      await admin.from('orders').update({
        rejected_by: rejectedBy, assigned_tech_phone: null, assignment_status: 'searching', status: 'pending', timeline,
      }).eq('id', order.id)
      await offerToNext({ ...order, rejected_by: rejectedBy })
      expiredHandled++
    }

    // 2) الطلبات الجديدة بدون تعيين
    const graceCutoff = new Date(Date.now() - NEW_ORDER_GRACE_SECONDS * 1000).toISOString()
    const { data: fresh, error: freshErr } = await admin
      .from('orders')
      .select('*')
      .eq('status', 'pending')
      .is('assignment_status', null)
      .not('customer_lat', 'is', null)
      .not('customer_lng', 'is', null)
      .lt('created_at', graceCutoff)
    if (freshErr) return json({ error: freshErr.message }, 500)

    let newHandled = 0
    for (const order of fresh || []) {
      await offerToNext(order)
      newHandled++
    }

    return json({ ok: true, expired_handled: expiredHandled, new_handled: newHandled })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
