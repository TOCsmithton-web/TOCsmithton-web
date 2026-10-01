const KEY="toc-smithton-control-v3";
const DB_NAME="toc-smithton-control";
const DB_VERSION=1;
const SITES=["Boomer Bay","Pittwater","LSP","Pipeclay","SCL"];
const WEATHER={lat:-40.84,lon:145.12};
const DEFAULT={salinity:null,salinityMin:null,salinityMax:null,rainThreshold:null,rain7Threshold:null,movements:[],forecast:[]};
let state={...DEFAULT};
let dbReady=null;
const $=id=>document.getElementById(id);
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains("state"))r.result.createObjectStore("state")};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function loadState(){try{dbReady=dbReady||openDB();const db=await dbReady;const tx=db.transaction("state","readonly");const req=tx.objectStore("state").get("main");return await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result?{...DEFAULT,...req.result}:null);req.onerror=()=>reject(req.error)})}catch(e){try{const raw=localStorage.getItem(KEY);return raw?{...DEFAULT,...JSON.parse(raw)}:null}catch(_){return null}}}
async function save(){try{dbReady=dbReady||openDB();const db=await dbReady;await new Promise((resolve,reject)=>{const tx=db.transaction("state","readwrite");tx.objectStore("state").put(state,"main");tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});try{localStorage.setItem(KEY,JSON.stringify(state))}catch(_){};return true}catch(e){try{localStorage.setItem(KEY,JSON.stringify(state));return true}catch(_){return false}}}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function flashSaved(ok=true){let el=$("saveStatus");if(!el)return;el.textContent=ok?"Saved to this device":"Save failed";el.className=ok?"save-ok":"save-error";setTimeout(()=>{el.textContent="";el.className=""},2500)}
function init(){
 $("sites").innerHTML=SITES.map(s=>'<div class="site">'+esc(s)+'</div>').join("");
 $("siteInput").innerHTML=SITES.map(s=>'<option>'+esc(s)+'</option>').join("");
 $("rainThreshold").value=state.rainThreshold??"";
 $("rain7Threshold").value=state.rain7Threshold??"";
 $("salinityInput").value=state.salinity??"";
 $("salinityMin").value=state.salinityMin??"";
 $("salinityMax").value=state.salinityMax??"";
 $("salinityForm").addEventListener("submit",e=>{e.preventDefault();state.salinity=Number($("salinityInput").value);state.salinityMin=$("salinityMin").value===""?null:Number($("salinityMin").value);state.salinityMax=$("salinityMax").value===""?null:Number($("salinityMax").value);flashSaved(save());renderStatus();checkAlerts()});
 $("rainForm").addEventListener("submit",e=>{e.preventDefault();state.rainThreshold=Number($("rainThreshold").value);state.rain7Threshold=$("rain7Threshold").value===""?null:Number($("rain7Threshold").value);flashSaved(save());renderStatus();checkAlerts()});
 $("stockForm").addEventListener("submit",e=>{e.preventDefault();state.movements.unshift({date:new Date().toISOString(),site:$("siteInput").value,size:$("sizeInput").value.trim(),qty:Number($("qtyInput").value),movement:$("movementInput").value});flashSaved(save());renderMovements();e.target.reset()});
 $("clearMovements").addEventListener("click",()=>{if(confirm("Clear locally stored stock movements?")){state.movements=[];flashSaved(save());renderMovements()}});
 $("refreshWeather").addEventListener("click",loadWeather);
 $("notifyBtn").addEventListener("click",enableAlerts);
 renderStatus();renderMovements();renderForecast();loadWeather();
 if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js?v=2").catch(()=>{});
}
function renderStatus(){
 $("salinityValue").textContent=state.salinity==null?"—":state.salinity.toFixed(1);
 $("rainValue").textContent=state.forecast.length?state.forecast.reduce((a,b)=>a+b.rain,0).toFixed(1):"—";
 $("rain24Value").textContent=state.forecast.length?state.forecast[0].rain.toFixed(1):"—";
 const issues=[];
 if(state.salinity!=null&&state.salinityMin!=null&&state.salinity<state.salinityMin)issues.push("Salinity below limit");
 if(state.salinity!=null&&state.salinityMax!=null&&state.salinity>state.salinityMax)issues.push("Salinity above limit");
 if(state.forecast.length&&state.rainThreshold!=null&&state.forecast[0].rain>=state.rainThreshold)issues.push("24h rainfall threshold");
 const total7=state.forecast.reduce((a,b)=>a+b.rain,0);
 if(state.forecast.length&&state.rain7Threshold!=null&&total7>=state.rain7Threshold)issues.push("7-day rainfall threshold");
 $("statusText").textContent=issues.length?issues.join(" • "):((state.salinity==null&&!state.forecast.length)?"Awaiting readings":"Within configured limits");
 $("statusDot").className="status-dot "+(issues.length?"alert":"ok");
 $("lastUpdated").textContent="Last checked "+new Date().toLocaleString("en-AU");
}
async function loadWeather(){
 $("forecast").innerHTML='<div class="loading">Loading Smithton forecast…</div>';
 try{
  const url="https://api.open-meteo.com/v1/forecast?latitude="+WEATHER.lat+"&longitude="+WEATHER.lon+"&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=Australia%2FHobart&forecast_days=7";
  const r=await fetch(url,{cache:"no-store"});if(!r.ok)throw Error("weather");
  const d=await r.json();
  state.forecast=d.daily.time.map((date,i)=>({date,rain:Number(d.daily.precipitation_sum[i]||0),max:d.daily.temperature_2m_max[i],min:d.daily.temperature_2m_min[i]}));
  save();renderForecast();renderStatus();checkAlerts();
 }catch(e){renderForecast();$("forecast").insertAdjacentHTML("beforeend",'<div class="loading">Forecast refresh failed. Check connection and tap Refresh.</div>')}
}
function renderForecast(){$("forecast").innerHTML=state.forecast.length?state.forecast.map(x=>'<div class="day"><div class="date">'+new Date(x.date+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric"})+'</div><div class="rain">'+x.rain.toFixed(1)+' mm</div><div class="range">'+Math.round(x.min)+"° / "+Math.round(x.max)+"°C</div></div>').join(""):'<div class="loading">No forecast loaded yet.</div>'}
function renderMovements(){$("movementTable").innerHTML=state.movements.length?state.movements.slice(0,50).map(x=>'<tr><td>'+new Date(x.date).toLocaleString("en-AU")+'</td><td>'+esc(x.site)+'</td><td>'+esc(x.size)+'</td><td>'+x.qty.toLocaleString()+'</td><td>'+esc(x.movement)+'</td></tr>').join(""):'<tr><td colspan="5" class="muted">No movements entered.</td></tr>'}
async function enableAlerts(){if(!("Notification"in window)){alert("Notifications are not supported on this browser.");return}const p=await Notification.requestPermission();$("notifyBtn").textContent=p==="granted"?"Alerts enabled":"Alerts blocked";if(p==="granted")checkAlerts()}
function checkAlerts(){if(!("Notification"in window)||Notification.permission!=="granted")return;const alerts=[];if(state.forecast.length&&state.rainThreshold!=null&&state.forecast[0].rain>=state.rainThreshold)alerts.push("Smithton rainfall is at or above your 24h threshold.");const total7=state.forecast.reduce((a,b)=>a+b.rain,0);if(state.forecast.length&&state.rain7Threshold!=null&&total7>=state.rain7Threshold)alerts.push("Smithton 7-day rainfall is at or above your threshold.");if(state.salinity!=null&&state.salinityMin!=null&&state.salinity<state.salinityMin)alerts.push("Manual salinity is below your configured minimum.");if(state.salinity!=null&&state.salinityMax!=null&&state.salinity>state.salinityMax)alerts.push("Manual salinity is above your configured maximum.");const sig=alerts.join("|");if(sig&&sig!==localStorage.getItem("toc-last-alert")){new Notification("TOC Smithton Control",{body:alerts.join(" ")});localStorage.setItem("toc-last-alert",sig)}}
(async()=>{state=await loadState()||{...DEFAULT};init()})();