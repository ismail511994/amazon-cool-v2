// Amazon Cool HVAC Pro — payment-webhook
// يستقبل Webhook من بوابة الدفع (Paymob أو Fawry)، يتحقق من التوقيع،
// وبعد التأكد فقط يحدّث حالة الدفع في جدول orders ويسجل الحدث في payment_events.
//
// روابط الـ Webhook اللي تحطها في لوحة تحكم بوابة الدفع:
//   Paymob: https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=paymob
//   Fawry : https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=fawry
//
// Secrets المطلوبة (Supabase Dashboard → Edge Functions → Secrets):
//   PAYMOB_HMAC_SECRET   (من لوحة Paymob → Settings → Account Info)
//   FAWRY_SECURE_KEY     (من لوحة تاجر Fawry)
//
// مهم جدًا: هذه الدالة تربط الطلب بالمعاملة عن طريق merchant_order_id (Paymob)
// أو merchantRefNumber (Fawry) — لازم يكون هو نفسه معرّف الطلب (orders.id) عندك
// وقت إنشاء عملية الدفع، وإلا مش هيقدر يلاقي الطلب المطلوب تحديثه.
//
// تنبيه أمان: قبل أي إطلاق حقيقي (production)، اختبر التوقيع في بيئة الـ sandbox
// الخاصة بكل بوابة، لأن بعض تفاصيل ترتيب الحقول (خصوصًا عند Fawry) قد تختلف
// حسب نوع التكامل (V1/V2) — راجعها مع وثائق حسابك التجاري قبل الاعتماد الكامل.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowed = (Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',').map(x=>x.trim()).filter(Boolean)
  return {'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),'Vary':'Origin','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','X-Content-Type-Options':'nosniff'}
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', enc)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function getPath(obj: any, path: string) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj)
}

// ترتيب الحقول الرسمي حسب وثائق Paymob لـ Transaction Processed Callback (HMAC-SHA512)
const PAYMOB_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
  'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
  'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
]

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })

  const url = new URL(req.url)
  const provider = (url.searchParams.get('provider') || '').toLowerCase()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(SUPABASE_URL, SERVICE_KEY)

  async function logEvent(p: string, orderId: string | null, raw: any, status: string, amount: number | null = null, txnRef = '') {
    try {
      const safe = raw && typeof raw === 'object' ? {...raw} : {}
      delete safe.hmac
      delete safe.messageSignature
      if (safe.obj && typeof safe.obj === 'object') {
        safe.obj = {...safe.obj}
        delete safe.obj.source_data
        delete safe.obj.hmac
      }
      await admin.from('payment_events').insert({
        provider: p, order_id: orderId, status, amount, txn_ref: txnRef, raw_payload: safe,
      })
    } catch (_e) { /* لا نفشل الطلب بسبب خطأ في اللوج */ }
  }


  async function alreadyProcessed(provider:string, txnRef:string){
    if(!txnRef) return false
    const {data}=await admin.from('payment_events').select('id').eq('provider',provider).eq('txn_ref',txnRef).limit(1).maybeSingle()
    return !!data
  }

  async function settleOrder(orderId: string | null, method: string, amount: number | null, txnRef: string, raw: unknown) {
    if (!orderId) { await logEvent(method, null, raw, 'paid_no_order_match', amount, txnRef); return }
    if (txnRef) {
      const existing = await admin.from('payment_events').select('id').eq('provider',method).eq('txn_ref',txnRef).limit(1).maybeSingle()
      if (existing.data?.id) return
    }
    if (amount == null || !Number.isFinite(amount)) {
      await logEvent(method, orderId, raw, 'paid_rejected_missing_amount', amount, txnRef)
      return
    }
    const result = await admin.rpc('settle_online_payment', {
      p_order_id: String(orderId), p_provider: method, p_reference: txnRef, p_amount: Number(amount)
    })
    if (result.error || result.data !== true) {
      await logEvent(method, orderId, raw, 'paid_rejected_amount_or_order_mismatch', amount, txnRef)
      return
    }
    await logEvent(method, orderId, raw, 'paid', amount, txnRef)
  }

  try {
    if (provider !== 'paymob' && provider !== 'fawry') {
      return json({ error: 'أضف ?provider=paymob أو ?provider=fawry في رابط الـ Webhook' }, 400)
    }

    const rawText = await req.text()
    let payload: any = {}
    try { payload = JSON.parse(rawText) } catch (_e) {
      payload = Object.fromEntries(new URLSearchParams(rawText))
    }

    if (provider === 'paymob') {
      const secret = Deno.env.get('PAYMOB_HMAC_SECRET')
      if (!secret) return json({ error: 'PAYMOB_HMAC_SECRET غير مضبوط على Edge Function' }, 503)

      const obj = payload.obj || payload
      const providedHmac = url.searchParams.get('hmac') || payload.hmac || ''
      const concatStr = PAYMOB_FIELDS.map((f) => {
        const v = getPath(obj, f)
        return v === undefined || v === null ? '' : String(v)
      }).join('')
      // Paymob: HMAC-SHA512 باستخدام السر كمفتاح، عبر Web Crypto
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
      )
      const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(concatStr))
      const hmacHex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('')

      const verified = !!providedHmac && hmacHex.toLowerCase() === String(providedHmac).toLowerCase()
      const orderId = obj?.special_reference || obj?.merchant_order_id || obj?.order?.merchant_order_id || null
      const amount = obj?.amount_cents != null ? Number(obj.amount_cents) / 100 : null
      const txnRef = String(obj?.id || '')

      if (!verified) {
        await logEvent('paymob', orderId, payload, 'invalid_signature', amount, txnRef)
        return json({ ok: false, verified: false }, 400)
      }
      if (obj?.success === true && !obj?.error_occured) {
        if(await alreadyProcessed('paymob',txnRef)) return json({ok:true,verified:true,duplicate:true})
        await settleOrder(orderId ? String(orderId) : null, 'paymob', amount, txnRef, payload)
      } else {
        await logEvent('paymob', orderId ? String(orderId) : null, payload, 'failed_or_pending', amount, txnRef)
      }
      return json({ ok: true, verified: true })
    }

    if (provider === 'fawry') {
      const secret = Deno.env.get('FAWRY_SECURE_KEY')
      if (!secret) return json({ error: 'FAWRY_SECURE_KEY غير مضبوط على Edge Function' }, 503)

      const {
        fawryRefNumber = '', merchantRefNumber = '', paymentAmount, orderAmount,
        orderStatus = '', paymentMethod = '', paymentRefrenceNumber = '', messageSignature = '',
      } = payload

      const amountStr = paymentAmount != null ? Number(paymentAmount).toFixed(2) : ''
      const orderAmountStr = orderAmount != null ? Number(orderAmount).toFixed(2) : ''
      const concat = `${fawryRefNumber}${merchantRefNumber}${amountStr}${orderAmountStr}${orderStatus}${paymentMethod}${paymentRefrenceNumber}${secret}`
      const computed = await sha256Hex(concat)
      const verified = !!messageSignature && computed.toLowerCase() === String(messageSignature).toLowerCase()

      const orderId = merchantRefNumber || null
      const amount = paymentAmount != null ? Number(paymentAmount) : null

      if (!verified) {
        await logEvent('fawry', orderId, payload, 'invalid_signature', amount, String(fawryRefNumber))
        return json({ ok: false, verified: false }, 400)
      }
      if (String(orderStatus).toUpperCase() === 'PAID') {
        if(await alreadyProcessed('fawry',String(fawryRefNumber))) return json({ok:true,verified:true,duplicate:true})
        await settleOrder(orderId, 'fawry', amount, String(fawryRefNumber), payload)
      } else {
        await logEvent('fawry', orderId, payload, `status_${orderStatus}`, amount, String(fawryRefNumber))
      }
      return json({ ok: true, verified: true })
    }

    return json({ error: 'مزود غير مدعوم' }, 400)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
