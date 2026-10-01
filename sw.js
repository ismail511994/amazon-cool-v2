const CACHE='amazon-cool-hvac-v14';
const CORE=['./','./index.html','./manifest.webmanifest','./icon.svg'];
const NETWORK_ONLY_HOSTS=['supabase.co','supabase.in','paymob.com','fawry.com'];
function isNetworkOnly(req){
  const u=new URL(req.url);
  if(NETWORK_ONLY_HOSTS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))) return true;
  if(u.pathname.includes('/functions/v1/')) return true;
  if(u.pathname.includes('/auth/v1/')) return true;
  if(u.pathname.includes('/rest/v1/')) return true;
  if(u.pathname.includes('/realtime/v1/')) return true;
  return false;
}
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  if(isNetworkOnly(e.request)) return;
  const u=new URL(e.request.url);
  const sameOrigin=u.origin===self.location.origin;
  const isNavigation=e.request.mode==='navigate';
  if(isNavigation){
    e.respondWith(fetch(e.request).then(r=>{const x=r.clone();caches.open(CACHE).then(c=>c.put('./index.html',x));return r}).catch(()=>caches.match('./index.html')));
    return;
  }
  if(!sameOrigin) return;
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{
    if(r.ok && (e.request.url.endsWith('.css')||e.request.url.endsWith('.js')||e.request.url.endsWith('.svg')||e.request.url.endsWith('.webmanifest')||e.request.url.endsWith('.png')||e.request.url.endsWith('.jpg')||e.request.url.endsWith('.jpeg')||e.request.url.endsWith('.webp'))){const x=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,x));}
    return r;
  })));
});
self.addEventListener('push',e=>{let d={title:'أمازون كول',body:'لديك إشعار جديد'};try{d={...d,...e.data.json()}}catch(_){}e.waitUntil(self.registration.showNotification(d.title,{body:d.body,icon:d.icon||'./icon.svg',badge:d.badge||'./icon.svg',data:d.data||{}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{if(cs[0])return cs[0].focus();return clients.openWindow('./')}))});
