const fs=require('fs'),vm=require('vm'),assert=require('assert');
for(const path of fs.readdirSync('.').filter(p=>p.endsWith('.html'))){const s=fs.readFileSync(path,'utf8');if(!s.includes('environmental-alerts.js'))continue;for(const m of s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1],{filename:path});}
(async()=>{
let enabled='false',notifications=[],fail=false,items=[],button={parentElement:{appendChild(){}},cloneNode(){return this},replaceWith(){}},timers=[];
const context={window:null,location:{href:'https://example.org/control-new.html'},Notification:{permission:'granted'},localStorage:{getItem(){return enabled},setItem(k,v){enabled=v}},document:{getElementById(){return button},createElement(){return {setAttribute(){}}},addEventListener(){}},navigator:{serviceWorker:{register:async()=>{},ready:Promise.resolve({showNotification:async(title,data)=>{if(fail)throw Error('failed');notifications.push({title,...data});}})}},setInterval(fn){timers.push(fn)},setTimeout(){},console};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync('environmental-alerts.js','utf8'),context);
const api=context.TOCAlerts,r=api.reading;
for(const [v,want] of [[4.999,false],[5,true],[5.001,true]])assert.equal(r('r','river',v,5,'>=','').breach,want);
assert.equal(r('s','sal',26.9,27,'<','').breach,true);assert.equal(r('s','sal',27,27,'<','').breach,false);
for(const v of ['',null,undefined,NaN])assert.equal(r('s','sal',v,27,'<','').breach,null);
items=[r('r','river',5,5,'>=','')];let alerts=api.create({key:'test',scope:'test',read:()=>items});await alerts.check();assert.equal(notifications.length,0);
await button.onclick();assert.equal(notifications.length,2,'test plus existing breach');await alerts.check();assert.equal(notifications.length,2,'no duplicates');
items=[r('r','river',NaN,5,'>=','')];await alerts.check();items=[r('r','river',5.1,5,'>=','')];await alerts.check();assert.equal(notifications.length,2,'unknown does not rearm');
items=[r('r','river',4.9,5,'>=','')];await alerts.check();items=[r('r','river',5,5,'>=','')];fail=true;await alerts.check();assert.equal(notifications.length,2);fail=false;await alerts.check();assert.equal(notifications.length,3,'failed delivery retried');
console.log('PASS: all changed page scripts parse; threshold equality, salinity minimum, missing data, enabling during breach, deduplication, recovery/re-crossing and retry.');
})();
