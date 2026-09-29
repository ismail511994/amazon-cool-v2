// Amazon Cool HVAC Pro — create-payment
// Paymob Unified Checkout. Secret credentials remain server-side.
// Production credentials are supplied as Supabase Edge Function Secrets.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

function allowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowed = (Deno.env.get('APP_ALLOWED_ORIGINS') || 'https://ismail511994.github.io').split(',').map(x=>x.trim()).filter(Boolean)
  return allowed.includes(origin) ? origin : allowed[0] || ''
}
const json=(b:unknown,s=200,origin='')=>new Response(JSON.stringify(b),{status:s,headers:{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json','X-Content-Type-Options':'nosniff'}})

serve(async req=>{
  const origin=allowedOrigin(req)
  if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'}})
  try{
    const url=new URL(req.url)
    const supa=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{
      global:{headers:{Authorization:req.headers.get('Authorization')||''}}
    })
    const {data:{user},error:ue}=await supa.auth.getUser()
    if(ue||!user)return json({error:'يجب تسجيل الدخول'},401,origin)
    const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body=await req.json()
    const orderId=String(body.order_id||'')
    const idempotencyKey=String(body.idempotency_key||'').trim()
    if(!/^[A-Za-z0-9._:-]{12,120}$/.test(idempotencyKey)) return json({error:'مفتاح عملية الدفع غير صالح'},400,origin)
    if(!orderId)return json({error:'order_id مطلوب'},400,origin)
    const rl=await supa.rpc('check_user_rate_limit',{p_action:'create-payment',p_limit:5,p_window_seconds:600})
    if(rl.error || rl.data!==true) return json({error:'محاولات دفع كثيرة. حاول مرة أخرى بعد قليل.'},429,origin)

    const {data:order,error:oe}=await supa.from('orders').select('*').eq('id',orderId).eq('client_id',user.id).maybeSingle()
    if(oe||!order)return json({error:'الطلب غير موجود'},404,origin)
    if(!['report_approved','confirmed','pending','assigned','on_way','arrived'].includes(String(order.status||''))) return json({error:'الطلب غير جاهز للدفع'},409,origin)
    if(order.payment_status==='paid')return json({error:'الطلب مدفوع بالفعل'},409,origin)

    const {data:activeAttempt}=await admin.from('payment_attempts').select('id,status,reference,expires_at,idempotency_key').eq('order_id',orderId).eq('provider','paymob').in('status',['created','pending']).order('created_at',{ascending:false}).limit(1).maybeSingle()
    if(activeAttempt){
      if(activeAttempt.idempotency_key===idempotencyKey && activeAttempt.expires_at && new Date(activeAttempt.expires_at).getTime()>Date.now()) return json({error:'هناك عملية دفع جارية لهذا الطلب. أكمل نافذة الدفع الحالية.',code:'PAYMENT_ALREADY_IN_PROGRESS',attempt_id:activeAttempt.id},409,origin)
      if(activeAttempt.expires_at && new Date(activeAttempt.expires_at).getTime()<=Date.now()){
        await admin.from('payment_attempts').update({status:'expired',updated_at:new Date().toISOString()}).eq('id',activeAttempt.id)
      } else return json({error:'هناك عملية دفع جارية لهذا الطلب. لا تبدأ عملية أخرى قبل انتهائها.',code:'PAYMENT_ALREADY_IN_PROGRESS',attempt_id:activeAttempt.id},409,origin)
    }
    const secret=Deno.env.get('PAYMOB_SECRET_KEY')
    const publicKey=Deno.env.get('PAYMOB_PUBLIC_KEY')
    const integrationRaw=Deno.env.get('PAYMOB_INTEGRATION_ID')
    const base=Deno.env.get('PAYMOB_BASE_URL')||'https://accept.paymob.com'
    if(!secret||!publicKey||!integrationRaw)return json({error:'إعدادات Paymob غير مكتملة: PAYMOB_SECRET_KEY / PAYMOB_PUBLIC_KEY / PAYMOB_INTEGRATION_ID'},503,origin)
    const integrationId=Number(integrationRaw)
    if(!Number.isInteger(integrationId))return json({error:'PAYMOB_INTEGRATION_ID يجب أن يكون رقمًا'},500,origin)

    const amountPiasters=Math.round(Number(order.total_amount||0)*100)
    if(amountPiasters<=0)return json({error:'قيمة الطلب غير صالحة'},400,origin)
    const d=order.details||{}
    const customerName=String(order.client_name||'عميل أمازون كول')
    const parts=customerName.trim().split(/\s+/);const first=parts.shift()||'عميل';const last=parts.join(' ')||'Amazon'
    const phone=String(order.client_phone||d.phone||user.phone||'').replace(/^00/,'+')
    if(!phone)return json({error:'رقم الهاتف مطلوب للدفع'},400,origin)

    const items=(Array.isArray(d.items)&&d.items.length)
      ? d.items.map((x:any)=>({name:String(x.name||'خدمة أمازون كول').slice(0,50),amount:Math.round(Number(x.price||0)*100),description:String(x.name||'').slice(0,255),quantity:Number(x.qty||1)}))
      : [{name:'خدمة أمازون كول',amount:amountPiasters,description:String(order.service_type||'HVAC Service'),quantity:1}]
    const sum=items.reduce((s:any,x:any)=>s+x.amount*x.quantity,0)
    if(sum!==amountPiasters){
      // For service orders, force one line item to the exact total.
      items.splice(0,items.length,{name:'خدمة أمازون كول',amount:amountPiasters,description:String(order.service_type||'HVAC Service'),quantity:1})
    }

    const appUrl=Deno.env.get('APP_URL')||req.headers.get('origin')||''
    const webhook=`${Deno.env.get('SUPABASE_URL')}/functions/v1/payment-webhook?provider=paymob`

    // Reserve the payment attempt BEFORE contacting Paymob. This closes the
    // concurrency window where two browser requests could create two intentions.
    const reservation=await admin.from('payment_attempts').insert({
      order_id:orderId,provider:'paymob',amount:Number(order.total_amount),status:'created',
      idempotency_key:idempotencyKey,expires_at:new Date(Date.now()+3600*1000).toISOString(),
      updated_at:new Date().toISOString()
    }).select('id').single()
    if(reservation.error){
      if(String(reservation.error.code||'')==='23505') return json({error:'تم بدء عملية دفع أخرى لهذا الطلب. استخدم العملية الحالية.',code:'PAYMENT_ALREADY_IN_PROGRESS'},409,origin)
      return json({error:'تعذر حجز عملية الدفع الآمنة'},500,origin)
    }
    const attemptId=reservation.data.id
    const payload={
      amount:amountPiasters,currency:'EGP',payment_methods:[integrationId],items,
      billing_data:{first_name:first,last_name:last,email:user.email||'customer@amazoncool.local',phone_number:phone,apartment:String(d.apartment||'NA'),floor:String(d.floor||'NA'),street:String(d.street||'NA'),building:String(d.building||'NA'),city:String(d.city||'Egypt'),state:String(d.city||'Egypt'),country:'EGY',postal_code:'NA',shipping_method:'NA'},
      special_reference:orderId,expiration:3600,notification_url:webhook,redirection_url:appUrl||undefined,
      extras:{internal_order_id:orderId,source:'amazon-cool'}
    }
    const r=await fetch(`${base}/v1/intention/`,{method:'POST',headers:{Authorization:`Token ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const data=await r.json()
    if(!r.ok){
      await admin.from('payment_attempts').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',attemptId)
      return json({error:data?.detail||data?.message||'فشل إنشاء عملية الدفع'},r.status,origin)
    }
    const clientSecret=data.client_secret
    if(!clientSecret){
      await admin.from('payment_attempts').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',attemptId)
      return json({error:'Paymob لم يُرجع client_secret'},502,origin)
    }
    const checkout=`${base}/unifiedcheckout/?publicKey=${encodeURIComponent(publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`
    const paymentRef=String(data.id||data.intention_order_id||orderId)
    const attemptUpdate=await admin.from('payment_attempts').update({reference:paymentRef,status:'pending',updated_at:new Date().toISOString()}).eq('id',attemptId)
    if(attemptUpdate.error){
      await admin.from('payment_attempts').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',attemptId)
      return json({error:'تعذر تثبيت مرجع عملية الدفع'},500,origin)
    }
    const upd=await admin.from('orders').update({payment_status:'pending',payment_method:'online',payment_provider:'paymob',payment_reference:paymentRef,updated_at:new Date().toISOString()}).eq('id',orderId)
    if(upd.error){
      await admin.from('payment_attempts').update({status:'failed',updated_at:new Date().toISOString()}).eq('id',attemptId)
      return json({error:'تعذر تثبيت حالة الدفع'},500,origin)
    }
    return json({checkout_url:checkout,intention_id:data.id,client_secret:clientSecret},200,origin)
  }catch(e){return json({error:String(e?.message||e)},500,origin)}
})
