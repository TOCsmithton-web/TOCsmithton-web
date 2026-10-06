const SW_VERSION="20261006-3";
self.addEventListener("install",function(e){self.skipWaiting();});
self.addEventListener("activate",function(e){
  e.waitUntil((async function(){
    const keys=await caches.keys();
    await Promise.all(keys.map(function(k){return caches.delete(k);}));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch",function(e){
  if(e.request.mode!=="navigate")return;
  const url=new URL(e.request.url);
  if(url.pathname.endsWith("/control-public.html")||url.pathname.endsWith("/control-new.html")||url.pathname.endsWith("/index.html")||url.pathname.endsWith("/")){
    e.respondWith(fetch(e.request,{cache:"no-store"}));
  }
});