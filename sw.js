const SW_VERSION="20261006-1";
self.addEventListener("install",function(e){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim());});
self.addEventListener("fetch",function(e){
  if(e.request.mode!=="navigate")return;
  const url=new URL(e.request.url);
  if(url.pathname.endsWith("/control-public.html")||url.pathname.endsWith("/control-new.html")||url.pathname.endsWith("/index.html")||url.pathname.endsWith("/")){
    e.respondWith(fetch(e.request,{cache:"no-store"}));
  }
});