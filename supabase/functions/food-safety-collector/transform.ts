export function dateKey(value: string|number|Date){const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Hobart',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):null;}
export function cycleFor(cycles:any[],date:string|null){return date?cycles.find(c=>c.start_date<=date&&c.end_date>=date):null;}
export function number(value:any){if(value===null||value===undefined||typeof value==='boolean'||String(value).trim()==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}
export function hobartISO(value:string){
 if(!value)return null;if(/Z$|[+-]\d{2}:\d{2}$/.test(value))return Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);if(!m)return null;
 const wall=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)),guess=wall-10*3600000;
 const parts:any={};new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Hobart',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).forEach(x=>parts[x.type]=x.value);
 return new Date(wall-(Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second)-guess)).toISOString();
}
export function parseNotes(value:any){try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}}
export function queuedRecord(q:any,cycles:any[]){
 const s=q.source_data,meta=parseNotes(s.notes);let requirement,details:any={},observed=s.reading_time||s.effective_at||s.created_at||s.received_at||q.captured_at;
 let day=q.source_table==='meat_test_results'?s.test_date:dateKey(observed),title='';
 if(q.source_table==='toc_nre_sms_events'){
  if(s.source!=='forwarded_sms'||s.bay!=='Duck Bay')return null;
  requirement='nre-notices';title='ShellMAP SMS — Duck Bay '+s.reported_status;
  details={area:s.bay,reported_status:['OPEN','CLOSED','CONDITIONAL'].includes(s.reported_status)?s.reported_status:'UNKNOWN',effective_at:s.effective_at||'',notice_number:'SMS report; no classification number supplied',conditions:s.message};
  day=dateKey(s.received_at); // Evidence receipt date; the exact status-effective date remains attached.
 }else if(q.source_table==='manual_control_readings'){
  if(s.location!=='Smithton'||!['Duck Bay','Kemps Bay'].includes(s.zone)||number(s.salinity)===null)return null;
  requirement='environment-check';title=s.zone+' manual salinity source reading';details={area:s.zone,observed_at:s.reading_time||'',salinity:number(s.salinity),decision:'Awaiting verification',limits_source:'Source app salinity entry; confirm with the approved management plan'};
 }else if(q.source_table==='meat_test_results'){
  if(/^Duck Bay Salinity T(0|24|48)$/.test(s.bay_name)){
   requirement='salinity-reopening';const stage=s.bay_name.match(/T(0|24|48)$/)[0];title='Duck Bay '+stage+' salinity source record';
   observed=hobartISO(meta.salinityTime)||s.created_at;
   details={stage,salinity:number(s.result),reading_at:meta.salinityTime||'',low_tide_at:meta.lowTideTime&&meta.salinityTime?meta.salinityTime.slice(0,10)+'T'+meta.lowTideTime:'',submission_reference:''};
  }else if(s.bay_name==='Duck Bay Salinity Reopening Status'){
   requirement='salinity-reopening';title='Duck Bay reopening status — '+s.result;observed=meta.resetAt||s.created_at;
   const stage=s.result==='RESET AFTER CLOSURE'?'Reset after closure':s.result==='COMPLETED AND SUBMITTED TO NRE'?'Submitted to NRE':'In progress';
   details={stage,reading_at:observed,submission_reference:''};
  }else if(s.bay_name==='Duck Bay NRE Classification'){
   requirement='nre-notices';title='Historic app NRE verification entry';details={area:'Duck Bay',reported_status:'UNKNOWN',notice_number:meta.noticeNumber||'',conditions:'Historic administrator verification entry. Confirm against the original official classification.'};
  }else if(['Duck Bay','Kemps Bay'].includes(s.bay_name)){
   requirement='shellmap-lab';title=s.bay_name+' app meat-test result';details={area:s.bay_name,result:s.result,report_ref:'App meat_test_results source '+s.id};
  }else return null;
 }else return null;
 const cycle=cycleFor(cycles,day);if(!cycle)return null;
 return {cycle_id:cycle.id,requirement_id:requirement,record_date:day,title,details,notes:'Automatically archived from '+q.source_table+'. Source entries are evidence of what the app recorded; original lab reports, required details and operational sign-off still need review.',source_key:q.source_table+':'+q.source_pk+':'+q.source_version,source_type:q.source_table,source_observed_at:observed||null,source_payload:{row:s,queue_captured_at:q.captured_at,source_actor:q.source_actor||null}};
}
export function rainfall(data:any,now:number){
 const x=data?.live;if(!x)return {known:false};const obs=Date.parse(x.observed_at),end=Date.parse(x.period_end),v=number(x.rain_since_9am),start=x.period_start?.slice(0,10);
 const sum=(n:number)=>{let total=0;for(let i=0;i<n;i++){const d=new Date(start+'T12:00:00Z');if(!Number.isFinite(d.getTime()))return null;d.setUTCDate(d.getUTCDate()-i);const value=number(data.daily?.[d.toISOString().slice(0,10)]);if(value===null||value<0)return null;total+=value;}return total;};
 const six=sum(6),two=sum(2),one=sum(1);const known=Number.isFinite(obs)&&now>=obs&&now-obs<=90*60000&&Number.isFinite(end)&&now<=end+30*60000&&v!==null&&v>=0&&six!==null&&two!==null&&one!==null;
 return {known,previous_24:one,live_3:two!==null&&v!==null?two+v:null,live_7:six!==null&&v!==null?six+v:null,observed_at:x.observed_at,period_start:x.period_start,rain_since_9am:v};
}
export function snapshotFor(bay:any,manual:any,rain:any,river:any,cycles:any[],now:number){
 const cycle=cycleFor(cycles,dateKey(now));if(!cycle)return null;
 const rt=rainfall(rain,now),riverStamp=Date.parse(river?.timestamp),riverFresh=Number.isFinite(riverStamp)&&riverStamp<=now+60000&&now-riverStamp<=2*3600000;
 const data={bay:bay.bay_name,rainfall:rt,river:bay.river_flow_limit!==null?{flow:number(river?.flow),timestamp:river?.timestamp||null,fresh:riverFresh}:null,salinity:manual?{value:number(manual.salinity),reading_time:manual.reading_time,source_id:manual.id}:null,app_limits:bay};
 const details:any={area:bay.bay_name,observed_at:new Date(now).toISOString(),decision:'Awaiting verification',limits_source:'App-configured criteria captured with source readings; confirm approved management plan'};
 if(rt.known){details.rain_24=rt.previous_24;details.rain_3=rt.live_3;details.rain_7=rt.live_7;}
 if(manual&&number(manual.salinity)!==null)details.salinity=number(manual.salinity);
 if(bay.river_flow_limit!==null&&riverFresh)details.river_flow=number(river.flow);
 return {cycle_id:cycle.id,requirement_id:'environment-check',record_date:dateKey(now),title:bay.bay_name+' automatic environmental snapshot',details,notes:'Automatic observed-data snapshot. Forecast rainfall is excluded. Missing or stale source inputs are retained as unavailable and do not prove safe harvest conditions.',source_type:'app_environment_snapshot',source_observed_at:new Date(now).toISOString(),source_payload:data};
}
