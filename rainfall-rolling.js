/* BOM reporting dates retain the 9am convention; projections are planning estimates. */
(function(root){
'use strict';
function shift(key,n){var d=new Date(key+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function valid(v){return typeof v==='number'&&isFinite(v)&&v>=0;}
function calculate(bom,fc,today){
  var latest=bom.latest_date,records=bom.daily||{}, forecasts={};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(latest)||latest>today||latest<shift(today,-1))throw Error('Stale BOM rainfall');
  function recorded(n){var total=0;for(var k=0;k<n;k++){var v=records[shift(latest,-k)];if(!valid(v))throw Error('Missing recorded day');total+=v;}return total;}
  if(!fc.daily||!Array.isArray(fc.daily.time))throw Error('Missing forecast');
  fc.daily.time.forEach(function(d,i){forecasts[d]=fc.daily.precipitation_sum[i];});
  function projected(day,n){var total=forecasts[day],observed=0;if(!valid(total))throw Error('Missing forecast day');
    for(var k=1;k<n;k++){var date=shift(day,-k),value=records[date];if(valid(value))observed++;else if(date>latest)value=forecasts[date];if(!valid(value))throw Error('Missing rainfall day');total+=value;}
    return {total:total,recorded:observed,forecast:n-observed};
  }
  var future=fc.daily.time.map(function(d,i){return {date:d,rain:forecasts[d],seven:projectedIfFuture(d,7),three:projectedIfFuture(d,3),min:fc.daily.temperature_2m_min[i],max:fc.daily.temperature_2m_max[i]};}).filter(function(x){return x.date>=today;}).slice(0,7);
  function projectedIfFuture(d,n){return d>=today?projected(d,n):null;}
  if(future.length!==7)throw Error('Incomplete forecast');
  return {latest:latest,start:shift(latest,-6),one:recorded(1),three:recorded(3),seven:recorded(7),future:future};
}
async function load(path,url){
  var parts=Object.fromEntries(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Hobart',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(function(p){return p.type!=='literal';}).map(function(p){return [p.type,p.value];}));
  var rs=await Promise.all([fetch(path+'?ts='+Date.now(),{cache:'no-store'}),fetch(url,{cache:'no-store'})]);
  if(rs.some(function(r){return !r.ok;}))throw Error('Rainfall unavailable');
  var data=await Promise.all(rs.map(function(r){return r.json();}));
  return calculate(data[0],data[1],parts.year+'-'+parts.month+'-'+parts.day);
}
function render(box,data,limits){
  box.innerHTML="<div class='day observed-summary'><div class='date'>Previous 7 days to 9am</div><div class='range'>"+data.start+' to '+data.latest+"</div><div class='rain'>"+data.seven.toFixed(1)+" mm</div><div class='range'>BOM recorded rainfall<br>Previous 3 days: "+data.three.toFixed(1)+" mm<br>Previous 24h: "+data.one.toFixed(1)+" mm</div></div>"+data.future.map(function(x){
    var over=x.seven.total>=limits.seven||(limits.three!=null&&x.three.total>=limits.three);
    var colour=over?'#c62828':x.seven.total>=31?'#ffb3b3':x.seven.total>=21?'#ff9800':x.seven.total>=11?'#90ee90':'#39ff14';
    var text=over?'#fff':'#17384a';
    return "<div class='day forecast-day' style='background:"+colour+';color:'+text+';border:2px solid '+colour+"'><div class='date'>"+new Date(x.date+'T12:00:00Z').toLocaleDateString('en-AU',{timeZone:'Australia/Hobart',weekday:'short',day:'numeric'})+"</div><div class='rain'>"+x.rain.toFixed(1)+" mm</div><div class='range'>"+Math.round(x.min)+'° / '+Math.round(x.max)+"°C</div><div class='range'>"+x.seven.recorded+' recorded + '+x.seven.forecast+" forecast days</div><div class='seven-day-total'>Projected 7-day total: <strong>"+x.seven.total.toFixed(1)+" mm</strong></div>"+(limits.three!=null?"<div class='range'>Projected 3-day total: <strong>"+x.three.total.toFixed(1)+" mm</strong></div>":'')+'</div>';
  }).join('')+"<p class='hint'>BOM records cover 24 hours to 9am on the stated date. Forecasts cover calendar days; combined totals are planning estimates.</p>";
}
root.TOCRainfall={load:load,calculate:calculate,render:render};
})(typeof window!=='undefined'?window:globalThis);
