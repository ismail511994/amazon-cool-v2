import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const ALLOWED = (Deno.env.get('APP_ALLOWED_ORIGINS') || '').split(',').map(x=>x.trim()).filter(Boolean)
function cors(origin:string|null){
  const allow = origin && ALLOWED.includes(origin) ? origin : (ALLOWED[0] || '')
  return {'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}
}
function json(body:unknown,status=200,origin:string|null=null){return new Response(JSON.stringify(body),{status,headers:{...cors(origin),'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
serve(async req=>{
 const origin=req.headers.get('origin')
 if(req.method==='OPTIONS') return new Response('ok',{headers:cors(origin)})
 if(req.method!=='POST') return json({error:'method_not_allowed'},405,origin)
 const auth=req.headers.get('authorization')||''
 if(!auth.startsWith('Bearer ')) return json({error:'unauthorized'},401,origin)
 const supa=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}})
 const {data:{user},error}=await supa.auth.getUser()
 if(error||!user) return json({error:'unauthorized'},401,origin)
 const {data:profile}=await supa.from('users_profile').select('role').eq('id',user.id).maybeSingle()
 if(!profile || !['admin','supervisor'].includes(profile.role)) return json({error:'forbidden'},403,origin)
 const key=Deno.env.get('CALLMEBOT_APIKEY')
 const phone=Deno.env.get('CALLMEBOT_PHONE')
 if(!key||!phone) return json({error:'whatsapp_not_configured'},503,origin)
 let body:any={}; try{body=await req.json()}catch{ return json({error:'invalid_json'},400,origin) }
 const text=String(body.text||'').slice(0,1500)
 if(!text) return json({error:'empty_message'},400,origin)
 const url='https://api.callmebot.com/whatsapp.php?phone='+encodeURIComponent(phone)+'&text='+encodeURIComponent(text)+'&apikey='+encodeURIComponent(key)
 const r=await fetch(url,{method:'GET'})
 const out=await r.text()
 return json({ok:r.ok,provider_status:r.status,message:r.ok?'sent':'failed'},r.ok?200:502,origin)
})
