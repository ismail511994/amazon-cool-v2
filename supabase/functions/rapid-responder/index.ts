import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'}
serve(async req => {
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors})
  try{
    const body=await req.json();
    const prompt=String(body.prompt||'').slice(0,20000);
    const key=Deno.env.get('GEMINI_API_KEY');
    if(!key) return new Response(JSON.stringify({error:'GEMINI_API_KEY غير مضبوط على Edge Function'}),{status:503,headers:{...cors,'Content-Type':'application/json'}})
    const model=Deno.env.get('GEMINI_MODEL')||'gemini-2.5-flash';
    const system=`أنت مهندس تكييف وتبريد محترف. حلل الأعطال بشكل محافظ وآمن. لا تؤكد قطعة تالفة دون فحص. فرّق بين الاحتمال والدليل. عند وجود كود خطأ اذكر أن معناه قد يختلف حسب الموديل. أعط ترتيب فحص عملي للفني، واذكر مخاطر الكهرباء والضغط والغاز. الرد بالعربية المصرية المبسطة.`;
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.2,maxOutputTokens:1800}})});
    const data=await r.json();
    if(!r.ok) return new Response(JSON.stringify({error:data}),{status:r.status,headers:{...cors,'Content-Type':'application/json'}})
    return new Response(JSON.stringify(data),{headers:{...cors,'Content-Type':'application/json'}})
  }catch(e){return new Response(JSON.stringify({error:String(e)}),{status:500,headers:{...cors,'Content-Type':'application/json'}})}
})
