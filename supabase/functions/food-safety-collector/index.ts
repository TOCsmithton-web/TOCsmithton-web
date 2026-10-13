import {createClient} from 'npm:@supabase/supabase-js@2.95.3';
import {cycleFor,dateKey,queuedRecord,snapshotFor} from './transform.ts';
const URL=Deno.env.get('SUPABASE_URL')!,KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb=createClient(URL,KEY,{auth:{persistSession:false,autoRefreshToken:false}}),BUCKET='smithton-food-safety';
const cors={'Access-Control-Allow-Origin':'https://tocsmithton-web.github.io','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
function result(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});}
function check(r:any){if(r.error)throw Error(r.error.message);return r.data;}
function same(a:string,b:string){if(!a||!b||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
async function hash(value:string|Uint8Array){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function jsonText(value:any):string{const order=(v:any):any=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;return JSON.stringify(order(value),null,2);}
async function json(url:string){const r=await fetch(url+(url.includes('?')?'&':'?')+'ts='+Date.now(),{signal:AbortSignal.timeout(20000),cache:'no-store'});if(!r.ok)throw Error('Source unavailable');return r.json();}
async function pdf(){
 const source=await json('https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-classification.json');
 const urls=source.documentSha256?['https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-current-classification.pdf','https://nre.tas.gov.au/SiteAssets/ShellMAP%20Current%20Harvest%20Status.pdf']:['https://nre.tas.gov.au/SiteAssets/ShellMAP%20Current%20Harvest%20Status.pdf'];
 let failure='Official notice unavailable';
 for(const url of urls){try{
  const r=await fetch(url,{signal:AbortSignal.timeout(25000),cache:'no-store'});if(!r.ok)throw Error('Official notice HTTP '+r.status);
  const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>20*1024*1024||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('Invalid official notice file');
  const sha256=await hash(bytes);if(source.documentSha256&&sha256!==source.documentSha256)throw Error('Classification PDF hash does not match checker output');
  return {bytes,sha256,classification:source,download_url:url};
 }catch(e){failure=e instanceof Error?e.message:'Official notice unavailable';}}
 throw Error(failure);
}

async function archiveFile(record:any,name:string,content:Uint8Array|string,mime:string){
 const path=record.cycle_id+'/'+record.record_id+'/'+name;
 if(check(await sb.from('fs_attachments').select('id').eq('object_path',path).maybeSingle()))return false;
 const bytes=typeof content==='string'?new TextEncoder().encode(content):content;
 const uploaded=await sb.storage.from(BUCKET).upload(path,bytes,{contentType:mime,upsert:false});
 if(uploaded.error){
  // A previous upload may have completed before metadata was written. Verify the existing bytes before linking it.
  const existing=check(await sb.storage.from(BUCKET).download(path));
  if(await hash(new Uint8Array(await existing.arrayBuffer()))!==await hash(bytes))throw Error('Existing evidence file differs; upload was not overwritten');
 }
 check(await sb.from('fs_attachments').insert({record_id:record.record_id,object_path:path,file_name:name,mime_type:mime,size_bytes:bytes.length,origin:'app_import'}));return true;
}
async function importOne(item:any){const rows=check(await sb.rpc('fs_import_app_records',{p_records:[item]}));return rows[0];}
async function collect(){
 const now=new Date().toISOString();
 const lock=check(await sb.from('fs_auto_collection_status').update({lock_until:new Date(Date.now()+140000).toISOString(),last_started_at:now}).eq('id',1).lt('lock_until',now).select('id'));
 if(!lock.length)return {busy:true};
 const summary:any={imported:0,existing:0,filesAdded:0,queueProcessed:0,queueSkipped:0,queueDeferred:0,errors:0,unavailableSources:[],unavailableDetails:[]};
 try{
  const cycles=check(await sb.from('fs_audit_cycles').select('*').order('start_date',{ascending:false}));
  const queue=check(await sb.from('fs_app_evidence_queue').select('*').is('processed_at',null).order('last_error',{ascending:true,nullsFirst:true}).order('captured_at').order('id').limit(30));
  for(const q of queue){try{
   const item=queuedRecord(q,cycles);
   if(!item){check(await sb.from('fs_app_evidence_queue').update({last_error:'Audit cycle or source date needs review; evidence retained for retry.'}).eq('id',q.id));summary.queueDeferred++;summary.errors++;continue;}
   const record=await importOne(item);summary[record.inserted?'imported':'existing']++;
   const text=q.source_table==='toc_nre_sms_events'?q.source_data.message:'TOC app source evidence\n\n'+jsonText(record.source_payload);
   if(await archiveFile(record,q.source_table==='toc_nre_sms_events'?'ShellMAP_SMS.txt':'App_source_record.txt',text,'text/plain'))summary.filesAdded++;
   check(await sb.from('fs_app_evidence_queue').update({processed_at:new Date().toISOString(),record_id:record.record_id,last_error:null}).eq('id',q.id));summary.queueProcessed++;
  }catch(e){summary.errors++;await sb.from('fs_app_evidence_queue').update({last_error:e instanceof Error?e.message:'Collection failed; retry pending'}).eq('id',q.id);}}
  const sources=await Promise.allSettled([
   json('https://tocsmithton-web.github.io/TOCsmithton-web/smithton-rainfall.json'),
   json('https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/river.json'),
   json('https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-classification.json'),pdf()
  ]);
  const names=['Smithton observed rainfall','Duck River readings','NRE classification data','Official NRE PDF'];
  sources.forEach((r,i)=>{if(r.status==='rejected'){summary.unavailableSources.push(names[i]);summary.unavailableDetails.push({source:names[i],reason:r.reason instanceof Error?r.reason.message:'Source unavailable'});}});
  const value=(i:number)=>sources[i].status==='fulfilled'?(sources[i] as PromiseFulfilledResult<any>).value:null;
  const bays=check(await sb.from('bay_settings').select('bay_name,salinity_min,salinity_max,rainfall_7d_limit,river_flow_limit').in('bay_name',['Duck Bay','Kemps Bay']).eq('active',true));
  const manuals=check(await sb.from('manual_control_readings').select('id,zone,salinity,reading_time,updated_by').eq('location','Smithton').order('reading_time',{ascending:false,nullsFirst:false}));
  for(const bay of bays){try{
   const item=snapshotFor(bay,manuals.find((x:any)=>x.zone===bay.bay_name),value(0),value(1),cycles,Date.now());if(!item)continue;
   const p:any=item.source_payload,r=p.rainfall,s=p.salinity;
   const state={bay:bay.bay_name,rain_known:r.known,rain3:bay.bay_name==='Duck Bay'&&r.known?r.live_3>=25:null,rain7:r.known?r.live_7>=Number(bay.rainfall_7d_limit):null,river:p.river?(p.river.fresh?p.river.flow>=Number(bay.river_flow_limit):'unavailable'):null,salinity_low:s&&bay.salinity_min!==null?s.value<Number(bay.salinity_min):null,salinity_high:s&&bay.salinity_max!==null?s.value>Number(bay.salinity_max):null};
   item.source_payload.collection_threshold_state=state;
   const prior=check(await sb.from('fs_records').select('id,cycle_id,source_key,source_payload,created_at').eq('cycle_id',item.cycle_id).eq('source_type','app_environment_snapshot').contains('source_payload',{bay:bay.bay_name}).order('created_at',{ascending:false}).limit(1))[0];
   const hour=Math.floor(Date.now()/3600000),sameState=prior&&Math.floor(Date.parse(prior.created_at)/3600000)===hour&&Object.keys(state).every(k=>prior.source_payload.collection_threshold_state?.[k]===(state as any)[k]);
   let record,payload;
   if(sameState){record={record_id:prior.id,cycle_id:prior.cycle_id};payload=prior.source_payload;summary.existing++;}
   else{item.source_key='environment-hour:'+hour+':'+(prior?.id||'first')+':'+await hash(JSON.stringify(item.source_payload));record=await importOne(item);payload=record.source_payload;summary[record.inserted?'imported':'existing']++;}
   if(await archiveFile(record,'Environmental_snapshot.txt','TOC app observed environmental snapshot\n\n'+jsonText(payload),'text/plain'))summary.filesAdded++;

  }catch{summary.errors++;}}
  const notice=value(3),classification=notice?.classification||value(2),cycle=cycleFor(cycles,dateKey(Date.now()));
  if(classification&&notice&&cycle&&classification.area==='Duck Bay Harvest Area'){try{
   const status=classification.statusLabel==='OPEN (CONDITIONAL)'?'CONDITIONAL':['OPEN','CLOSED'].includes(classification.statusLabel)?classification.statusLabel:'UNKNOWN';
   const semantic={notice:classification.classificationNotice,status,effective:classification.effectiveFrom,conditions:classification.details||'',pdf_sha256:notice.sha256};
   const item={cycle_id:cycle.id,requirement_id:'nre-notices',record_date:dateKey(Date.now()),title:'Official NRE classification snapshot — Duck Bay '+status,details:{area:'Duck Bay',reported_status:status,effective_at:classification.effectiveFrom||'',notice_number:classification.classificationNotice||'',conditions:classification.details||''},notes:'Official PDF archived as retrieved, alongside the app classification checker output. Inspect the saved PDF before review sign-off; no harvest or audit approval is implied.',source_key:'classification:'+await hash(JSON.stringify(semantic)),source_type:'official_nre_classification',source_observed_at:classification.checkedAt||new Date().toISOString(),source_payload:{classification,document_sha256:notice.sha256,document_url:classification.sourceUrl,archive_download_url:notice.download_url,retrieved_at:new Date().toISOString()}};
   const record=await importOne(item);summary[record.inserted?'imported':'existing']++;
   if(await archiveFile(record,'Official_NRE_classification.pdf',notice.bytes,'application/pdf'))summary.filesAdded++;
   if(await archiveFile(record,'Classification_source.txt',jsonText(record.source_payload),'text/plain'))summary.filesAdded++;
  }catch{summary.errors++;}}
  const pending=await sb.from('fs_app_evidence_queue').select('id',{count:'exact',head:true}).is('processed_at',null);
  if(pending.error)throw Error('Unable to verify collection backlog');summary.pending=pending.count;
  check(await sb.from('fs_auto_collection_status').update({last_finished_at:new Date().toISOString(),last_result:summary,last_error:summary.errors||summary.unavailableSources.length?'Some sources need retrying; review collection status.':null}).eq('id',1));
  return summary;
 }catch(e){await sb.from('fs_auto_collection_status').update({last_error:e instanceof Error?e.message:'Collection failed'}).eq('id',1);throw e;}
 finally{await sb.from('fs_auto_collection_status').update({lock_until:'1970-01-01T00:00:00Z'}).eq('id',1);}
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 if(req.method!=='POST')return result({error:'POST required'},405);
 try{
  const origin=req.headers.get('origin');if(origin&&origin!=='https://tocsmithton-web.github.io')return result({error:'Origin not allowed'},403);
  const config=check(await sb.from('toc_push_config').select('scheduler_secret').eq('id',1).single());
  let authorised=same(req.headers.get('x-scheduler-secret')||'',config.scheduler_secret);
  if(!authorised){const bearer=req.headers.get('authorization')||'';if(!bearer.startsWith('Bearer '))return result({error:'Unauthorised'},401);
   const auth=await sb.auth.getUser(bearer.slice(7));if(auth.error||!auth.data.user)return result({error:'Unauthorised'},401);
   authorised=!!check(await sb.from('admin_users').select('user_id').eq('user_id',auth.data.user.id).maybeSingle());
  }
  if(!authorised)return result({error:'Administrator access required'},403);
  return result(await collect());
 }catch{return result({error:'Automatic evidence collection failed; retry pending.'},503);}
});
