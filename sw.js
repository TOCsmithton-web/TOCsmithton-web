// TOC Smithton service-worker retirement build 2026-10-06
self.addEventListener("install",function(e){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil((async function(){try{const keys=await caches.keys();await Promise.all(keys.map(function(k){return caches.delete(k);}));}catch(e){}try{await self.registration.unregister();}catch(e){}try{const cs=await self.clients.matchAll({type:"window"});cs.forEach(function(c){try{c.navigate(c.url);}catch(e){}});}catch(e){}})());});
