/* Farm-calibrated planning estimate; not an observed or trained hydrodynamic model. */
(function(root){
'use strict';
const H=3600, finite=Number.isFinite;
function correction(speedKmh,from,pressure){
 if(![speedKmh,from,pressure].every(finite)||speedKmh<0)return null;
 const r=from*Math.PI/180;
 const wind=.4*(speedKmh/35)*Math.max(-1,Math.min(1,Math.cos(r)+Math.sin(r)));
 return {wind,pressure:(1013.25-pressure)*.01,total:wind+(1013.25-pressure)*.01};
}
function model(data){
 const tides=(data.tides?.extremes||[]).filter(x=>finite(x.dt)&&finite(x.height)).sort((a,b)=>a.dt-b.dt);
 const w=data.weather?.hourly,units=data.weather?.hourly_units?.wind_speed_10m;
 const factor=units==='kn'?1.852:units==='km/h'?1:units==='m/s'?3.6:null;
 function base(t){const i=tides.findIndex(x=>x.dt>=t);if(i<0)return null;if(tides[i].dt===t)return tides[i].height;if(i===0)return null;const a=tides[i-1],b=tides[i];if(b.dt-a.dt>9*H)return null;return (a.height+b.height)/2+(a.height-b.height)/2*Math.cos(Math.PI*(t-a.dt)/(b.dt-a.dt));}
 function weather(t){
  if(!w||factor===null)return null;
  const j=w.time.findIndex(x=>x>=t);if(j<0)return null;const i=w.time[j]===t?j:j-1;if(i<0||w.time[j]-w.time[i]>H)return null;
  if(![i,j].every(k=>['wind_speed_10m','wind_direction_10m','pressure_msl','wind_gusts_10m'].every(v=>finite(w[v]?.[k]))))return null;
  const f=i===j?0:(t-w.time[i])/(w.time[j]-w.time[i]);
  const mix=k=>w[k][i]*(1-f)+w[k][j]*f;
  // Interpolate the effect, avoiding a false 180-degree wind at the north wrap.
  const a=correction(w.wind_speed_10m[i]*factor,w.wind_direction_10m[i],w.pressure_msl[i]);
  const b=correction(w.wind_speed_10m[j]*factor,w.wind_direction_10m[j],w.pressure_msl[j]);
  return {total:a.total*(1-f)+b.total*f,wind:a.wind*(1-f)+b.wind*f,pressure:a.pressure*(1-f)+b.pressure*f,speed:mix('wind_speed_10m')*factor,gust:mix('wind_gusts_10m')*factor};
 }
 function point(t){const h=base(t),c=weather(t);return {t,base:h,adjusted:h!==null&&c?h+c.total:null,c};}
 function plan(low){
  const nominal=low.dt-4*H,b=base(nominal);if(b===null)return null;
  // Normalise this cycle to the farmer's ideal 1 m low, then match its -4 h height.
  const target=b+(1-low.height),prev=tides.filter(x=>x.dt<low.dt&&x.type==='High').pop();if(!prev)return null;
  let last=point(prev.dt),start=null;
  for(let t=prev.dt+300;t<=low.dt;t=Math.min(t+300,low.dt)){
   const p=point(t);
   if(last.adjusted!==null&&p.adjusted!==null&&last.adjusted>=target&&p.adjusted<=target&&last.adjusted>p.adjusted){start=last.t+(t-last.t)*(last.adjusted-target)/(last.adjusted-p.adjusted);break;}
   if(t===low.dt)break;last=p;
  }
  if(start===null)return null;
  const end=start+4*H,rows=[];for(let t=start;t<=end;t+=300)rows.push(point(t));rows.push(point(end));
  if(rows.some(x=>x.adjusted===null))return null;
  const atLow=point(low.dt);if(atLow.adjusted===null)return null;
  return {start,end,low,atLow,target,shift:(start-nominal)/60,maxWind:Math.max(...rows.map(x=>x.c.speed)),maxGust:Math.max(...rows.map(x=>x.c.gust))};
 }
 return {point,plan,tides};
}
const api={correction,model};if(typeof module!=='undefined')module.exports=api;root.SmithtonTides=api;
})(typeof window==='undefined'?globalThis:window);
