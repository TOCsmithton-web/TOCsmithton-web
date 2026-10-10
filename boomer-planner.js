(function(root){
'use strict';
const TZ='Australia/Hobart',HOUR=3600;
const valid=x=>typeof x==='number'&&Number.isFinite(x);
const dateKey=t=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t*1000));
const clock=t=>new Intl.DateTimeFormat('en-AU',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(t*1000));
const direction=x=>valid(x)?['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(x/22.5)%16]+' '+Math.round(x)+'°':'Unavailable';
function lowTides(data){
 if(data.tides&&Array.isArray(data.tides.extremes))return data.tides.extremes.filter(x=>x.type==='Low'&&valid(x.dt)&&valid(x.height)).map(x=>({t:x.dt,h:x.height,local:!(data.tides.station&&data.tides.station.reference_only),reference:!!(data.tides.station&&data.tides.station.reference_only)}));
 if(data.tide_mode==='bom')return [];
 const m=data.marine&&data.marine.hourly;if(!m)return [];
 const lows=[];
 for(let i=1;i<m.time.length-1;i++){
  const a=m.sea_level_height_msl[i-1],b=m.sea_level_height_msl[i],c=m.sea_level_height_msl[i+1];
  if(![a,b,c].every(valid)||!(b<a&&b<=c)||m.time[i]-m.time[i-1]!==HOUR||m.time[i+1]-m.time[i]!==HOUR)continue;
  // Parabolic interpolation estimates the trough within hourly model samples.
  const delta=Math.max(-.5,Math.min(.5,(a-c)/(2*(a-2*b+c))));
  lows.push({t:m.time[i]+delta*HOUR,h:b-(a-c)*delta/4,local:false});
 }
 return lows;
}
function forecast(data,now=Date.now()/1000){
 const w=data.weather&&data.weather.hourly,d=data.weather&&data.weather.daily;
 if(!w||!d)return [];
 const lows=lowTides(data),today=dateKey(now),days=d.time.map((t,i)=>({start:t,date:dateKey(t),sunrise:d.sunrise[i],sunset:d.sunset[i]})).filter(x=>x.date>=today).slice(0,14);
 return days.map((day,dayIndex)=>{
  const candidates=lows.filter(x=>dateKey(x.t)===day.date).map(low=>{
   const start=Math.max(low.t-5400,day.sunrise,now),end=Math.min(low.t+5400,day.sunset);
   if(low.t<day.sunrise||low.t>day.sunset||end-start<1800)return null;
   const indices=w.time.map((t,i)=>({t,i})).filter(x=>x.t>=Math.floor(start/HOUR)*HOUR&&x.t<=Math.ceil(end/HOUR)*HOUR);
   if(!indices.length||indices[0].t>start||indices[indices.length-1].t<end)return null;
   const complete=indices.every(x=>['wind_speed_10m','wind_gusts_10m','pressure_msl','wind_direction_10m'].every(k=>valid(w[k][x.i])));
   if(!complete)return {low,start,end,missing:true,score:Infinity};
   const near=indices.reduce((a,b)=>Math.abs(a.t-low.t)<Math.abs(b.t-low.t)?a:b).i;
   const wind=Math.max(...indices.map(x=>w.wind_speed_10m[x.i])),gust=Math.max(...indices.map(x=>w.wind_gusts_10m[x.i]));
   const pressure=w.pressure_msl[near],prev=w.pressure_msl[near-3],trend=valid(prev)?pressure-prev:null;
   // Pressure carries substantial weight following the farm's experience.
   // 1013.25 hPa is the reference; bands below are provisional planning bands.
   const pPenalty=Math.max(-12,Math.min(30,(1013.25-pressure)*1.5));
   const score=wind*2+gust+pPenalty+(valid(trend)?Math.max(0,-trend)*3:0);
   return {low,start,end,wind,gust,pressure,trend,direction:w.wind_direction_10m[near],score,poor:wind>15||gust>20,lowPressure:pressure<1005,falling:valid(trend)&&trend<=-2};
  }).filter(Boolean).sort((a,b)=>(Number(!!a.missing)-Number(!!b.missing))||(Number(!!a.poor)-Number(!!b.poor))||(a.score-b.score));
  return {...day,index:dayIndex,allLows:lows.filter(x=>dateKey(x.t)===day.date),allTides:data.tides?(data.tides.extremes||[]).filter(x=>dateKey(x.dt)===day.date):[],candidates,best:candidates[0]||null};
 });
}
if(typeof module!=='undefined'&&module.exports)module.exports={forecast,lowTides,dateKey,direction};
if(typeof document==='undefined')return;
const el=id=>document.getElementById(id),escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const metric=(label,value)=>'<div><small>'+label+'</small><strong>'+value+'</strong></div>';
function graph(data,day){
 if(data.tides){
  const rows=day.allTides||[];if(rows.length<2)return '';
  const min=Math.min(...rows.map(x=>x.height))-.15,max=Math.max(...rows.map(x=>x.height))+.15;
  const start=day.start,end=start+86400;
  const x=t=>35+(t-start)/(end-start)*290,y=h=>10+(max-h)/(max-min)*75;
  let marks='';for(let i=0;i<=2;i++){const v=min+(max-min)*i/2;marks+='<line x1="35" y1="'+y(v)+'" x2="325" y2="'+y(v)+'" stroke="#dce6eb"/><text x="30" y="'+(y(v)+4)+'" text-anchor="end" font-size="10">'+v.toFixed(1)+'</text>';}
  rows.forEach(r=>{marks+='<circle cx="'+x(r.dt)+'" cy="'+y(r.height)+'" r="4" fill="'+(r.type==='Low'?'#087bc1':'#b7791f')+'"><title>'+r.type+' '+clock(r.dt)+' '+r.height.toFixed(2)+' m</title></circle>';});
  return '<div class="plot"><svg viewBox="0 0 340 110" role="img" aria-label="BOM Pirates Bay high and low tide heights"><title>BOM Pirates Bay reference tides</title>'+marks+'<text x="35" y="103" font-size="10">12 am</text><text x="180" y="103" text-anchor="middle" font-size="10">12 pm</text><text x="325" y="103" text-anchor="end" font-size="10">12 am</text></svg><small>BOM reference heights • blue: low • amber: high • no interpolation</small></div>';
 }
 const m=data.marine&&data.marine.hourly;if(!m||data.tides)return '';
 const rows=m.time.map((t,i)=>({t,h:m.sea_level_height_msl[i]})).filter(x=>dateKey(x.t)===day.date&&valid(x.h));
 if(rows.length<3)return '';
 const min=Math.min(...rows.map(x=>x.h))-.1,max=Math.max(...rows.map(x=>x.h))+.1;
 const x=t=>35+(t-rows[0].t)/(rows[rows.length-1].t-rows[0].t)*290,y=h=>10+(max-h)/(max-min)*75;
 let lines='';for(let i=0;i<=2;i++){let v=min+(max-min)*i/2;lines+='<line x1="35" y1="'+y(v)+'" x2="325" y2="'+y(v)+'" stroke="#dce6eb"/><text x="30" y="'+(y(v)+4)+'" text-anchor="end" font-size="10">'+v.toFixed(1)+'</text>';}
 const pts=rows.map(a=>x(a.t)+','+y(a.h)).join(' ');
 return '<div class="plot"><svg viewBox="0 0 340 110" role="img" aria-label="Provisional sea level in metres above mean sea level"><title>Provisional coastal sea-level model, MSL</title>'+lines+'<polyline fill="none" stroke="#087bc1" stroke-width="2.5" points="'+pts+'"/><text x="35" y="103" font-size="10">'+clock(rows[0].t)+'</text><text x="325" y="103" text-anchor="end" font-size="10">'+clock(rows[rows.length-1].t)+'</text></svg><small>Coastal model • metres MSL • gaps remain unfilled</small></div>';
}
function render(data){
 const now=Date.now()/1000,age=now-Date.parse(data.updated_at)/1000,stale=!valid(age)||age>3*HOUR;
 const days=forecast(data,now);
 el('updated').textContent='Forecast retrieved '+new Date(data.updated_at).toLocaleString('en-AU',{timeZone:TZ})+' • Page checks every 15 minutes • '+(stale?'OUTDATED — refresh required':'Forecast refreshes with app deployment, normally every 15 minutes');
 el('tideSource').textContent=data.tides?'Tides: '+data.tides.source+' • Heights in metres above '+data.tides.datum+'. Two BOM seven-day tables provide 14 days. Pirates Bay is a nearby reference, not a Boomer Bay lease prediction. Wind and pressure effects are not included in these tide heights.':'BOM reference tide feed unavailable. Work windows are unconfirmed; no other tide source is substituted.';
 const usable=days.filter(x=>x.best&&!x.best.missing&&!x.best.poor);
 const best=usable.slice().sort((a,b)=>a.best.score-b.best.score)[0];
 el('assessment').textContent=stale?'Forecast is outdated. Work recommendations are withheld until fresh data is available.':best?'Most promising BOM reference window: '+best.date+' '+clock(best.best.start)+'–'+clock(best.best.end)+'. Ranked using calmer wind and higher or steadier pressure. Confirm lease water level before relying on it.':'No complete, suitable daylight low-tide window can currently be identified from the available data.';
 if(data.ai&&data.ai.status==='available'&&!stale){el('ai').textContent='AI forecast commentary: '+data.ai.summary;}
 else el('ai').textContent='AI commentary '+(data.ai&&data.ai.status==='unavailable'?'temporarily unavailable':'not connected yet')+'. The daily assessment below uses the forecast data and provisional planning rules.';
 el('days').innerHTML=days.map(day=>{
  const b=stale?null:day.best,unknown=!b||b.missing,bad=b&&!unknown&&(b.poor||b.lowPressure);
  let tag=unknown?'UNCONFIRMED':bad?'POOR / WATER-LEVEL RISK':'BOM REFERENCE WINDOW';
  let reason=stale?'Outdated forecast. Refresh before planning.':!b?day.allLows.length?'No remaining daylight low-tide window today.':'Tide prediction unavailable for this day; no work time is guessed.':b.missing?'Required wind or pressure readings are missing; no recommendation.':
  (b.poor?'Wind or gusts exceed the provisional screening setting. ':'Wind and gusts are within the provisional screening settings. ')+(b.lowPressure?'Low pressure: higher risk of water staying on the lease. ':b.pressure>=1020?'Higher pressure favours a lower water level. ':'Pressure is near the reference range. ')+(b.falling?'Pressure is falling quickly; watch for the tide not dropping as expected. ':'')+'BOM times and heights are for Pirates Bay. Lease timing, height and wind setup are not calibrated.';
  const display=b&&!b.missing?b:null;
  const w=data.weather.hourly,dayIndices=w.time.map((t,i)=>({t,i})).filter(x=>dateKey(x.t)===day.date&&x.t>=day.sunrise&&x.t<=day.sunset);
  const ref=dayIndices.length?dayIndices[Math.floor(dayIndices.length/2)].i:-1;
  const maximum=k=>{const values=dayIndices.map(x=>w[k][x.i]).filter(valid);return values.length?Math.max(...values):null;};
  const weatherDisplay=display||(!stale&&ref>=0?{wind:maximum('wind_speed_10m'),gust:maximum('wind_gusts_10m'),pressure:w.pressure_msl[ref],direction:w.wind_direction_10m[ref],trend:valid(w.pressure_msl[ref])&&valid(w.pressure_msl[ref-3])?w.pressure_msl[ref]-w.pressure_msl[ref-3]:null}:null);
  const noon=day.sunrise;
  return '<article class="day-card '+(unknown?'unknown':bad?'poor':'')+'"><h3>'+escape(new Intl.DateTimeFormat('en-AU',{timeZone:TZ,weekday:'long',day:'numeric',month:'short'}).format(new Date(noon*1000)))+'</h3><span class="pill">'+tag+'</span><div class="window">'+(display?clock(display.start)+'–'+clock(display.end):'No confirmed work time')+'</div><p class="forecast-meta">'+(day.index>=7?'Week 2 • tentative forecast':'Week 1 • recheck each day')+'</p><div class="metrics">'+
  metric('Low tide'+(display&&display.low.reference?' • Pirates Bay':display&&!display.low.local?' (estimated)':''),display?clock(display.low.t):'Unavailable')+
  metric('Low height • '+(data.tides?escape(data.tides.datum):'MSL'),display?display.low.h.toFixed(2)+' m':'Unavailable')+
  metric(display?'Max wind in window':'Max daylight wind',weatherDisplay&&valid(weatherDisplay.wind)?weatherDisplay.wind.toFixed(1)+' kn':'Unavailable')+
  metric(display?'Max gust in window':'Max daylight gust',weatherDisplay&&valid(weatherDisplay.gust)?weatherDisplay.gust.toFixed(1)+' kn':'Unavailable')+
  metric(display?'Wind from at low tide':'Wind from near midday',weatherDisplay?direction(weatherDisplay.direction):'Unavailable')+
  metric(display?'Pressure at low tide':'Pressure near midday',weatherDisplay&&valid(weatherDisplay.pressure)?weatherDisplay.pressure.toFixed(0)+' hPa':'Unavailable')+
  metric('Pressure change / 3 h',weatherDisplay&&valid(weatherDisplay.trend)?(weatherDisplay.trend>0?'+':'')+weatherDisplay.trend.toFixed(1)+' hPa':'Unavailable')+
  metric('Daylight',clock(day.sunrise)+'–'+clock(day.sunset))+'</div><p class="reason">'+escape(reason)+'</p>'+graph(data,day)+
  '<details><summary>All BOM tides and daily weather</summary><p>'+escape(day.allTides.map(l=>l.type+' '+clock(l.dt)+' · '+l.height.toFixed(2)+' m').join(' / ')||'No BOM tide coverage')+'</p>'+hourlyTable(data,day)+'</details></article>';
 }).join('')||'<p>Weather forecast unavailable. Refresh to try again.</p>';
}
function hourlyTable(data,day){const w=data.weather.hourly;let rows='';w.time.forEach((t,i)=>{if(dateKey(t)!==day.date||i%3!==0)return;rows+='<tr><td>'+clock(t)+'</td><td>'+direction(w.wind_direction_10m[i])+'</td><td>'+(valid(w.wind_speed_10m[i])?w.wind_speed_10m[i].toFixed(0):'—')+' kn</td><td>'+(valid(w.pressure_msl[i])?w.pressure_msl[i].toFixed(0):'—')+' hPa</td></tr>';});return '<table><thead><tr><th>Time</th><th>Wind from</th><th>Wind</th><th>Pressure</th></tr></thead><tbody>'+rows+'</tbody></table>';}
let last=null,busy=false;
async function refresh(){if(busy)return;busy=true;el('refresh').disabled=true;try{const r=await fetch('boomer-planner.json?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('feed');last=await r.json();render(last);}catch(e){el('updated').textContent='Forecast feed unavailable — cannot confirm work windows.';el('assessment').textContent='Refresh to retry the forecast feed.';el('days').innerHTML='<div class="card">Forecast data unavailable.</div>';}finally{busy=false;el('refresh').disabled=false;}}
el('refresh').onclick=refresh;refresh();setInterval(refresh,900000);
})(typeof window==='undefined'?globalThis:window);
