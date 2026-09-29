// Amazon Cool HVAC Pro — push-notify
// يرسل إشعارات Push حقيقية للمستخدمين المشتركين (جدول push_subscriptions)
// باستخدام مفاتيح VAPID. لا يوجد أي مفتاح داخل الكود — كله من Secrets.
//
// طريقة الاستدعاء من الفرونت إند (نفس نمط rapid-responder):
//   await db.functions.invoke('push-notify', { body: {
//     user_id: '...',            // إشعار لمستخدم واحد
//     // أو user_ids: ['...','...'], // إشعار لعدة مستخدمين (أدمن فقط)
//     // أو broadcast: true,         // إشعار لكل المشتركين (أدمن فقط)
//     title: 'عنوان الإشعار',
//     body: 'نص الإشعار',
//     url: '/',                   // الرابط اللي يتفتح عند الضغط (اختياري)
//     data: {}                    // بيانات إضافية (اختياري)
//   }});
//
// Secrets المطلوبة على المشروع (Supabase Dashboard → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (مثال: mailto:you@example.com)
// ملاحظة: SUPABASE_URL و SUPABASE_ANON_KEY و SUPABASE_SERVICE_ROLE_KEY متاحة تلقائيًا
// كمتغيرات بيئة داخل أي Edge Function من Supabase، مفيش داعي تضيفها يدويًا.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import webpush from 'npm:web-push@3.6.7'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'غير مصرح — يلزم تسجيل الدخول' }, 401)

    // عميل بهوية المتصل نفسه: نستخدمه للتأكد من هويته وصلاحياته (RLS/RPC)
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    // عميل بصلاحية الخادم الكاملة: لقراءة كل الاشتراكات وحذف التالف منها
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)

    const { data: userData, error: userErr } = await callerClient.auth.getUser(jwt)
    const callerId = userData?.user?.id || null
    if (userErr || !callerId) return json({ error: 'جلسة غير صالحة' }, 401)

    const body = await req.json().catch(() => ({}))
    const title = String(body.title || 'أمازون كول').slice(0, 120)
    const message = String(body.body || '').slice(0, 500)
    const url = String(body.url || '/')
    const extra = (body.data && typeof body.data === 'object') ? body.data : {}

    async function isAdmin() {
      const { data } = await callerClient.rpc('is_admin')
      return !!data
    }

    let targetUserIds: string[] = []
    if (body.broadcast === true) {
      if (!(await isAdmin())) return json({ error: 'البث الجماعي للإدارة فقط' }, 403)
      const { data: subs, error } = await admin.from('push_subscriptions').select('user_id')
      if (error) return json({ error: error.message }, 500)
      targetUserIds = [...new Set((subs || []).map((s: any) => s.user_id).filter(Boolean))]
    } else if (Array.isArray(body.user_ids) && body.user_ids.length) {
      if (!(await isAdmin())) return json({ error: 'إرسال لمستخدمين متعددين للإدارة فقط' }, 403)
      targetUserIds = body.user_ids.map(String)
    } else if (body.user_id) {
      if (String(body.user_id) !== callerId && !(await isAdmin())) {
        return json({ error: 'غير مصرح بإرسال إشعار لمستخدم آخر' }, 403)
      }
      targetUserIds = [String(body.user_id)]
    } else {
      return json({ error: 'حدد user_id أو user_ids أو broadcast:true' }, 400)
    }

    if (!targetUserIds.length) return json({ sent: 0, failed: 0, removed: 0, targets: 0 })

    const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY')
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com'
    if (!vapidPublic || !vapidPrivate) {
      return json({ error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY غير مضبوطة على Edge Function', sent: 0 }, 503)
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

    const { data: subs, error: subErr } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, subscription, user_id')
      .in('user_id', targetUserIds)
    if (subErr) return json({ error: subErr.message }, 500)

    const payload = JSON.stringify({
      title,
      body: message,
      icon: extra.icon || '',
      badge: extra.badge || '',
      data: { url, ...extra },
    })

    let sent = 0, failed = 0, removed = 0
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.subscription, payload)
        sent++
      } catch (e: any) {
        failed++
        const status = e?.statusCode
        // 404/410 يعني الاشتراك مات (المستخدم مسح المتصفح أو ألغى الإذن) — نحذفه عشان منحاولش تاني
        if (status === 404 || status === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id)
          removed++
        }
      }
    }

    return json({ sent, failed, removed, targets: (subs || []).length })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
