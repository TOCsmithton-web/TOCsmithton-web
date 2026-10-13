(function(){
'use strict';
const $=id=>document.getElementById(id), sb=window.supabase.createClient(window.TOC_SUPABASE_URL,window.TOC_SUPABASE_PUBLISHABLE_KEY);
const BUCKET='smithton-food-safety', batchRequired=new Set(['harvest-record','stock-movements','relay-record','dispatch-label','stock-ledger','cold-chain','vibrio-control','depuration-run','harvest-hold']);
let cycles=[],requirements=[],records=[],attachments=[],reviews=[],cycle=null,user=null,allowed=false,authGeneration=0,pendingRecord=null,openedRecord=null,uploadFinished=new Set();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Hobart',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const stamp=s=>s?new Date(s).toLocaleString('en-AU',{timeZone:'Australia/Hobart',dateStyle:'medium',timeStyle:'short'}):'—';
const message=(text,error=false)=>{$('message').textContent=text;$('message').className=error?'error':'';};
function check(result){if(result.error)throw Error(result.error.message);return result.data;}
function selectedRecords(){const replaced=new Set(records.map(r=>r.supersedes_id).filter(Boolean));return records.filter(r=>!replaced.has(r.id));}
function latestReview(id){return reviews.find(r=>r.requirement_id===id);}
function stateFor(req){
 const rows=selectedRecords().filter(r=>r.requirement_id===req.id), review=latestReview(req.id);
 const last=rows.reduce((v,r)=>r.created_at>v?r.created_at:v,'');
 const missingFiles=rows.some(r=>r.needs_completion)||(req.attachment_required&&rows.some(r=>!r.evidence_reference&&!attachments.some(a=>a.record_id===r.id)));
 const due=!!(review?.next_due_on&&review.next_due_on<today());
 let state=!rows.length?'missing':'collected',label=!rows.length?'Missing evidence':'Evidence collected';
 if(review?.status==='not_applicable'){state='not_applicable';label='Not applicable';}
 else if(due||review?.status==='needs_action'){state='action';label=due?'Collection / review overdue':'Needs action';}
 else if(review?.status==='reviewed'&&review.created_at>=last&&!missingFiles){state='reviewed';label='Reviewed';}
 return {state,label,rows,review,missingFiles};
}
async function pageAll(table,configure){
 let result=[];
 for(let start=0;;start+=500){let q=sb.from(table).select('*');if(configure)q=configure(q);const rows=check(await q.range(start,start+499));result.push(...rows);if(rows.length<500)return result;}
}
async function refresh(){
 if(!allowed||!cycle)return false;
 const selected=cycle.id,generation=authGeneration;message('Loading private evidence…');
 try{
  const [r,v,collection]=await Promise.all([pageAll('fs_records',q=>q.eq('cycle_id',selected).order('created_at',{ascending:false}).order('id')),pageAll('fs_reviews',q=>q.eq('cycle_id',selected).order('created_at',{ascending:false}).order('id')),sb.from('fs_auto_collection_status').select('last_started_at,last_finished_at,last_result,last_error').eq('id',1).maybeSingle()]);
  let a=[];const ids=r.map(x=>x.id);
  for(let i=0;i<ids.length;i+=100)a.push(...await pageAll('fs_attachments',q=>q.in('record_id',ids.slice(i,i+100)).order('created_at')));
  if(generation!==authGeneration||cycle?.id!==selected)return;
  records=r;reviews=v;attachments=a;renderCollection(collection);render();message('Evidence loaded. '+records.length+' saved records in this cycle.');return true;
 }catch(e){records=[];attachments=[];reviews=[];render();message('Could not load evidence: '+e.message,true);return false;}
}
async function authorise(session){
 const generation=++authGeneration;allowed=false;user=null;cycles=[];records=[];reviews=[];attachments=[];requirements=[];cycle=null;
 $('workspace').hidden=true;$('evidenceList').replaceChildren();$('recordList').replaceChildren();$('traceResults').replaceChildren();$('recordDetail').replaceChildren();
 document.querySelectorAll('dialog[open]').forEach(d=>d.close());pendingRecord=null;
 $('loginCard').hidden=false;$('signOut').hidden=!session;$('signIn').hidden=!!session;
 if(!session){$('loginStatus').textContent='Sign in with your existing approved TOC administrator account.';return;}
 $('loginStatus').textContent='Checking administrator access…';
 try{
  const member=check(await sb.from('admin_users').select('user_id').eq('user_id',session.user.id).maybeSingle());
  if(generation!==authGeneration)return;
  if(!member){$('loginStatus').textContent='This account is not a registered TOC administrator. Food safety records remain private.';return;}
  user=session.user;allowed=true;
  [cycles,requirements]=await Promise.all([pageAll('fs_audit_cycles',q=>q.order('start_date',{ascending:false})),pageAll('fs_requirements',q=>q.order('sort_order'))]);
  if(generation!==authGeneration)return;
  $('cycleSelect').innerHTML=cycles.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.title)+'</option>').join('');
  $('category').innerHTML='<option value="">All categories</option>'+[...new Set(requirements.map(r=>r.category))].map(c=>'<option>'+esc(c)+'</option>').join('');
  cycle=cycles.find(c=>c.start_date<=today()&&c.end_date>=today())||cycles[0];
  if(!cycle)throw Error('No audit cycle is configured.');$('cycleSelect').value=cycle.id;
  $('account').textContent='Signed in: '+(user.email||user.id);$('loginCard').hidden=true;$('workspace').hidden=false;
  await refresh();
 }catch(e){allowed=false;$('workspace').hidden=true;$('loginCard').hidden=false;$('loginStatus').textContent='Access could not be confirmed: '+e.message;}
}
function matching(req){return (!$('category').value||req.category===$('category').value)&&(!$('search').value||JSON.stringify(req).toLowerCase().includes($('search').value.toLowerCase()))&&(!$('statusFilter').value||stateFor(req).state===$('statusFilter').value);}
function render(){
 if(!allowed)return;
 const states=requirements.map(stateFor);$('totalCount').textContent=requirements.length;$('reviewCount').textContent=states.filter(x=>x.state==='reviewed').length;$('missingCount').textContent=states.filter(x=>x.state==='missing'||x.missingFiles).length;$('dueCount').textContent=states.filter(x=>x.state==='action').length;
 $('cycleDates').textContent=cycle.start_date+' to '+cycle.end_date+' · Audit due '+cycle.audit_due_on;
 $('evidenceList').innerHTML=requirements.filter(matching).map(req=>{
  const s=stateFor(req),last=s.rows[0];return '<article class="card fs-evidence-card"><div class="card-head"><h2>'+esc(req.title)+'</h2><span class="fs-status '+s.state+'">'+esc(s.label)+'</span></div><p class="fs-meta">'+esc(req.category)+' · '+esc(req.frequency)+'</p><ul>'+req.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul><p class="fs-meta">'+s.rows.length+' current records · '+attachments.filter(a=>s.rows.some(r=>r.id===a.record_id)).length+' files'+(last?' · Latest '+esc(last.record_date):'')+'</p>'+(s.missingFiles?'<p class="fs-meta" style="color:#9d2727">Source details or supporting documents still need completion.</p>':'')+(s.review?'<p class="fs-meta">'+esc(s.review.owner_name||'Review')+(s.review.next_due_on?' · Next due '+esc(s.review.next_due_on):'')+' · '+esc(s.review.reason)+'</p>':'')+'<div class="fs-actions"><button class="button" data-add="'+esc(req.id)+'">Add evidence</button><button class="button secondary" data-filter="'+esc(req.id)+'">View records</button><button class="button secondary" data-review="'+esc(req.id)+'">Review / due date</button></div></article>';
 }).join('')||'<p class="fs-empty">No evidence requirements match these filters.</p>';
 renderRecords();
}
function recordMarkup(r){const req=requirements.find(x=>x.id===r.requirement_id),superseded=records.some(x=>x.supersedes_id===r.id);return '<article class="fs-record"><div><h3>'+esc(r.title)+'</h3><p>'+esc(r.record_date)+' · '+esc(req?.title||r.requirement_id)+' · '+esc(r.performed_by)+'</p><p>'+esc(r.outcome)+(r.origin==='app_import'?' · Automatically collected':'')+(r.needs_completion?' · Needs completion':'')+(r.batch_ref?' · Batch '+esc(r.batch_ref):'')+(r.run_ref?' · Run '+esc(r.run_ref):'')+(superseded?' · Original — correction saved':'')+'</p></div><div class="fs-actions"><button class="button secondary" data-record="'+r.id+'">View / files</button>'+(!superseded?'<button class="button secondary" data-correct="'+r.id+'">Save correction</button>':'')+'</div></article>';}
let requirementFilter='';
function renderRecords(){const search=$('search').value.toLowerCase();const rows=records.filter(r=>(!requirementFilter||r.requirement_id===requirementFilter)&&(!$('category').value||requirements.find(x=>x.id===r.requirement_id)?.category===$('category').value)&&(!search||JSON.stringify(r).toLowerCase().includes(search)));$('recordList').innerHTML=rows.map(recordMarkup).join('')||'<p class="fs-empty">No records yet. Add dated evidence using the checklist.</p>';}
function showTab(name){for(const key of ['evidence','records','trace']){$(key+'Panel').hidden=key!==name;$(key+'Tab').className='button'+(key!==name?' secondary':'');$(key+'Tab').setAttribute('aria-selected',String(key===name));}}
function openEntry(id,original){
 pendingRecord=null;uploadFinished.clear();$('entryForm').reset();$('entryStatus').textContent='';$('entryForm').querySelectorAll('input,select,textarea').forEach(x=>x.disabled=false);$('saveEntry').disabled=false;
 const req=requirements.find(x=>x.id===id);if(!req)return;
 $('entryTitle').textContent=(original?'Save correction · ':'Add evidence · ')+req.title;$('entryRequirement').value=id;$('correctionId').value=original?.id||'';
 $('entryGuide').textContent=req.evidence.join(' · ');$('recordDate').value=original?.record_date||today();$('recordDate').min=cycle.start_date;$('recordDate').max=cycle.end_date<today()?cycle.end_date:today();
 $('recordTitle').value=original?.title||req.title;$('batchRef').required=batchRequired.has(id);
 $('detailFields').innerHTML=req.fields.map(f=>'<label class="'+(f.type==='textarea'?'fs-wide':'')+'">'+esc(f.label)+(f.type==='textarea'?'<textarea rows="3"':f.type==='select'?'<select':'<input type="'+esc(f.type)+'"')+' data-field="'+esc(f.key)+'"'+(f.required?' required':'')+(f.type==='number'?' step="any"':'')+'>'+(f.type==='select'?'<option value="">Choose…</option>'+f.options.map(o=>'<option>'+esc(o)+'</option>').join('')+'</select>':f.type==='textarea'?'</textarea>':'')+'</label>').join('');
 if(original){for(const [element,key] of [['performedBy','performed_by'],['outcome','outcome'],['batchRef','batch_ref'],['runRef','run_ref'],['equipmentRef','equipment_ref'],['notes','notes'],['correctiveAction','corrective_action'],['evidenceReference','evidence_reference']])$(element).value=original[key]||'';document.querySelectorAll('[data-field]').forEach(el=>el.value=original.details[el.dataset.field]??'');}
 $('entryDialog').showModal();
}
function typedDetails(){const req=requirements.find(x=>x.id===$('entryRequirement').value),details={};for(const f of req.fields){const input=document.querySelector('[data-field="'+f.key+'"]'),value=input.value.trim();details[f.key]=f.type==='number'&&value!==''?Number(value):value;}return details;}
const mimeByExt={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',heic:'image/heic',heif:'image/heif',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',csv:'text/csv',txt:'text/plain',zip:'application/zip'};
function validateFiles(files){for(const file of files){const ext=file.name.split('.').pop().toLowerCase();if(!mimeByExt[ext])throw Error('Unsupported file type: '+file.name);if(!file.size||file.size>20*1024*1024)throw Error('File must be 1 byte to 20 MB: '+file.name);}}
async function uploadFiles(record,files,done=new Set()){
 validateFiles(files);
 for(const file of files){const signature=file.name+':'+file.size+':'+file.lastModified;if(done.has(signature))continue;
  const ext=file.name.split('.').pop().toLowerCase(),path=record.cycle_id+'/'+record.id+'/'+crypto.randomUUID()+'.'+ext,mime=mimeByExt[ext];
  check(await sb.storage.from(BUCKET).upload(path,file,{contentType:mime,upsert:false}));
  try{check(await sb.from('fs_attachments').insert({record_id:record.id,object_path:path,file_name:file.name,mime_type:mime,size_bytes:file.size}));done.add(signature);}
  catch(e){await sb.storage.from(BUCKET).remove([path]);throw e;}
 }
}
async function saveEntry(event){
 event.preventDefault();$('saveEntry').disabled=true;$('entryStatus').textContent='Saving evidence…';
 try{
  const files=[...$('evidenceFiles').files];validateFiles(files);
  if(!pendingRecord){
   const ref=$('evidenceReference').value.trim();if(ref&&!ref.startsWith('https://'))throw Error('Use a secure https:// evidence link.');
   const record={cycle_id:cycle.id,requirement_id:$('entryRequirement').value,record_date:$('recordDate').value,title:$('recordTitle').value.trim(),performed_by:$('performedBy').value.trim(),outcome:$('outcome').value,batch_ref:$('batchRef').value.trim(),run_ref:$('runRef').value.trim(),equipment_ref:$('equipmentRef').value.trim(),details:typedDetails(),notes:$('notes').value,corrective_action:$('correctiveAction').value,evidence_reference:ref,supersedes_id:$('correctionId').value||null};
   pendingRecord=check(await sb.from('fs_records').insert(record).select().single());
   $('entryForm').querySelectorAll('input,select,textarea').forEach(x=>{if(x.id!=='evidenceFiles')x.disabled=true;});
  }
  await uploadFiles(pendingRecord,files,uploadFinished);pendingRecord=null;$('entryDialog').close();await refresh();message('Evidence saved. Original records and attached files are retained.');
 }catch(e){$('entryStatus').textContent=(pendingRecord?'The record is saved. Some files need retrying; select files and click Save again. ':'')+e.message;}
 finally{$('saveEntry').disabled=false;}
}
function openReview(id){const req=requirements.find(x=>x.id===id),review=latestReview(id);$('reviewForm').reset();$('reviewRequirement').value=id;$('reviewTitle').textContent='Review · '+req.title;$('reviewStatus').value=review?.status||'collecting';$('reviewReason').value=review?.reason||'';$('reviewOwner').value=review?.owner_name||'';$('reviewDue').value=review?.next_due_on||'';$('reviewMessage').textContent='';$('reviewDialog').showModal();}
async function saveReview(event){event.preventDefault();const button=event.submitter;button.disabled=true;try{
 const status=$('reviewStatus').value,reason=$('reviewReason').value.trim();if(status==='reviewed'&&!$('reviewConfirm').checked)throw Error('Confirm you have checked the complete evidence before signing off.');if(status==='not_applicable'&&reason.length<8)throw Error('Explain why this requirement does not apply this cycle.');
 check(await sb.from('fs_reviews').insert({cycle_id:cycle.id,requirement_id:$('reviewRequirement').value,status,reason,owner_name:$('reviewOwner').value.trim(),next_due_on:$('reviewDue').value||null}));$('reviewDialog').close();await refresh();
 }catch(e){$('reviewMessage').textContent=e.message;}finally{button.disabled=false;}}
function openRecord(id){const r=records.find(x=>x.id===id),req=requirements.find(x=>x.id===r.requirement_id);openedRecord=r;$('extraFiles').value='';$('attachmentMessage').textContent='';
 const pairs=[['Evidence requirement',req?.title],['Date',r.record_date],['Performed by',r.performed_by],['Outcome',r.outcome],['Batch',r.batch_ref],['Run',r.run_ref],['Equipment',r.equipment_ref],...Object.entries(r.details).map(([k,v])=>[req?.fields.find(f=>f.key===k)?.label||k,v]),['Notes',r.notes],['Corrective action',r.corrective_action],['Recorded at',stamp(r.created_at)],['Recorder account',r.created_by||(r.origin==='app_import'?'Automatic app collector':'')],['Evidence source',r.source_type||'Manual entry'],['Source observed at',r.source_observed_at?stamp(r.source_observed_at):''],['Completion needed',r.needs_completion?'Complete required fields and original reports before sign-off':''],['Correction of',r.supersedes_id||'']];
 $('recordDetail').innerHTML='<h3>'+esc(r.title)+'</h3><dl class="fs-detail">'+pairs.filter(x=>x[1]!==''&&x[1]!=null).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl>'+(r.evidence_reference?'<p><a href="'+esc(r.evidence_reference)+'" target="_blank" rel="noopener noreferrer">Open existing evidence link</a></p>':'')+'<h3>Supporting files</h3>'+attachments.filter(a=>a.record_id===r.id).map(a=>'<p><button class="button secondary" data-file="'+a.id+'">'+esc(a.file_name)+'</button> · '+Math.round(a.size_bytes/1024)+' KB</p>').join('');$('recordDialog').showModal();
}
async function downloadAttachment(id){try{const a=attachments.find(x=>x.id===id),blob=check(await sb.storage.from(BUCKET).download(a.object_path));download(blob,a.file_name);}catch(e){message('File could not be downloaded: '+e.message,true);}}
function download(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function massBalance(rows){let received=0,dispatched=0,lost=0;for(const r of rows.filter(x=>x.requirement_id==='stock-ledger')){const n=Number(r.details.quantity);if(!Number.isFinite(n))continue;if(['Opening balance','Receipt'].includes(r.details.movement))received+=n;else if(r.details.movement==='Dispatch')dispatched+=n;else if(r.details.movement==='Loss / disposal')lost+=n;}return {received,dispatched,lost,balance:received-dispatched-lost};}
function trace(){const ref=$('traceBatch').value.trim(),rows=selectedRecords().filter(r=>r.batch_ref===ref);if(!ref){$('traceResults').textContent='Enter an exact batch reference.';return;}const m=massBalance(rows),hasLedger=rows.some(r=>r.requirement_id==='stock-ledger');$('traceResults').innerHTML=(hasLedger?'<div class="fs-balance'+(m.balance<0?' fs-alert':'')+'"><strong>Ledger balance: '+m.balance.toLocaleString()+' oysters</strong><p>In / opening: '+m.received.toLocaleString()+' · Out: '+m.dispatched.toLocaleString()+' · Loss: '+m.lost.toLocaleString()+'</p><p>Compare this balance with physical stock and your source stock system.</p></div>':'<p class="hint">No stock ledger entries yet for this batch. Add stock in, dispatch and loss entries to calculate its balance.</p>')+rows.map(recordMarkup).join('');if(!rows.length)$('traceResults').innerHTML='<p class="fs-empty">No evidence records match this batch reference.</p>';}
async function snapshot(){
 $('snapshot').disabled=true;try{
  const files=await Promise.all(['./smithton-rainfall.json','./river.json','https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-classification.json','https://gyzxsugnlobxlvqjevhh.supabase.co/functions/v1/nre-sms-public'].map(async f=>{const response=await fetch(f+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(f+' unavailable');return response.json();}));
  const manual=check(await sb.from('manual_control_readings').select('zone,salinity,reading_time').eq('location','Smithton').eq('zone','Duck Bay').order('reading_time',{ascending:false}).limit(1));
  const limits=check(await sb.from('bay_settings').select('bay_name,salinity_min,salinity_max,rainfall_7d_limit,river_flow_limit').eq('bay_name','Duck Bay').maybeSingle());
  openEntry('environment-check');const now=new Date(),rain=files[0],live=rain.live||{},date=live.period_start?.slice(0,10),sum=n=>{let total=0;for(let i=0;i<n;i++){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-i);const v=rain.daily?.[d.toISOString().slice(0,10)];if(typeof v!=='number')return '';total+=v;}return typeof live.rain_since_9am==='number'?Number((total+live.rain_since_9am).toFixed(3)):'';};
  const offset=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16),values={area:'Duck Bay',observed_at:offset,salinity:manual[0]?.salinity??'',rain_24:rain.daily?.[date]??'',rain_3:date?sum(2):'',rain_7:date?sum(6):'',river_flow:files[1].flow??'',decision:'Awaiting verification',limits_source:'Approved management plan — confirm before harvest'};
  for(const [key,value] of Object.entries(values)){const el=document.querySelector('[data-field="'+key+'"]');if(el)el.value=value;}
  $('notes').value=JSON.stringify({captured_at:now.toISOString(),rainfall:{source:rain.source,updated:rain.updated,latest_date:rain.latest_date,live:rain.live},river:{flow:files[1].flow,timestamp:files[1].timestamp,updated:files[1].updated},classification:files[2],sms_report:files[3].latest,manual_salinity:manual[0]||null,app_limits:limits},null,2);
  $('entryStatus').textContent='Snapshot captured for Duck Bay. Check source times, approved limits and current ShellMAP SMS before recording the harvest decision. This snapshot does not authorise harvest.';
 }catch(e){message('Snapshot could not be captured: '+e.message,true);}finally{$('snapshot').disabled=false;}}
function dateShift(s,days){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function openCycle(){const start=dateShift(cycle.end_date,1),d=new Date(start+'T12:00:00Z');d.setUTCFullYear(d.getUTCFullYear()+1);const end=dateShift(d.toISOString().slice(0,10),-1);$('newCycleTitle').value='Smithton '+start.slice(0,4)+'–'+end.slice(0,4)+' audit cycle';$('cycleStart').value=start;$('cycleEnd').value=end;$('cycleDue').value=end;$('cycleMessage').textContent='';$('cycleDialog').showModal();}
async function saveCycle(event){event.preventDefault();const button=event.submitter;button.disabled=true;try{const c=check(await sb.from('fs_audit_cycles').insert({title:$('newCycleTitle').value.trim(),start_date:$('cycleStart').value,end_date:$('cycleEnd').value,audit_due_on:$('cycleDue').value}).select().single());cycles.unshift(c);cycle=c;$('cycleSelect').innerHTML=cycles.map(x=>'<option value="'+x.id+'">'+esc(x.title)+'</option>').join('');$('cycleSelect').value=c.id;$('cycleDialog').close();await refresh();}catch(e){$('cycleMessage').textContent=e.message;}finally{button.disabled=false;}}
// Uncompressed ZIP: portable records, review history and the actual private evidence files.
function zip(entries){const encoder=new TextEncoder(),table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c;}
 let offset=0,locals=[],central=[];for(const [name,data] of entries){const bytes=data instanceof Uint8Array?data:encoder.encode(data),filename=encoder.encode(name);let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
 const h=new Uint8Array(30+filename.length),v=new DataView(h.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,filename.length,true);h.set(filename,30);locals.push(h,bytes);
 const ch=new Uint8Array(46+filename.length),cv=new DataView(ch.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,bytes.length,true);cv.setUint32(24,bytes.length,true);cv.setUint16(28,filename.length,true);cv.setUint32(42,offset,true);ch.set(filename,46);central.push(ch);offset+=h.length+bytes.length;}
 const end=new Uint8Array(22),ev=new DataView(end.buffer),centralSize=central.reduce((n,c)=>n+c.length,0);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,entries.length,true);ev.setUint16(10,entries.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);return new Blob([...locals,...central,end],{type:'application/zip'});
}
function csvCell(value){let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
async function exportPack(){
 $('export').disabled=true;try{
  if(!await refresh())throw Error('Reload the records successfully before exporting.');if(!allowed)throw Error('Administrator access required.');
  const total=attachments.reduce((n,a)=>n+Number(a.size_bytes),0);if(total>100*1024*1024)throw Error('This cycle exceeds the 100 MB browser export limit. Download evidence files individually from the record register.');
  message('Preparing audit pack with private evidence files…');
  const entries=[],manifest=[];for(const a of attachments){const data=check(await sb.storage.from(BUCKET).download(a.object_path)),name='evidence/'+a.record_id+'/'+a.id+'-'+a.file_name.replace(/[^\p{L}\p{N} ._-]/gu,'_');entries.push([name,new Uint8Array(await data.arrayBuffer())]);manifest.push({...a,export_path:name});}
  const headings=['record_id','requirement','record_date','title','performed_by','outcome','batch','run','equipment','recorded_at','recorder_account','supersedes','details','notes','corrective_action','evidence_link','origin','source_type','source_observed_at','needs_completion'];
  const csv=[headings.map(csvCell).join(','),...records.map(r=>[r.id,r.requirement_id,r.record_date,r.title,r.performed_by,r.outcome,r.batch_ref,r.run_ref,r.equipment_ref,r.created_at,r.created_by,r.supersedes_id,JSON.stringify(r.details),r.notes,r.corrective_action,r.evidence_reference,r.origin,r.source_type,r.source_observed_at,r.needs_completion].map(csvCell).join(','))].join('\r\n');
  const pack={exported_at:new Date().toISOString(),site:'Smithton',cycle,requirements,records,review_history:reviews,attachments:manifest};entries.push(['records.csv','\uFEFF'+csv],['audit-data.json',JSON.stringify(pack,null,2)]);
  const index='<!doctype html><html><head><meta charset="utf-8"><title>Smithton audit evidence</title><style>body{font:15px system-ui;margin:30px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:9px;border-bottom:1px solid #ddd}h2{margin-top:30px}</style></head><body><h1>'+esc(cycle.title)+'</h1><p>'+esc(cycle.start_date)+' to '+esc(cycle.end_date)+' · Audit due '+esc(cycle.audit_due_on)+'</p><p>Evidence collection and review index. Reviewed status records the internal review; it is not an audit certification.</p><table><tr><th>Requirement</th><th>Frequency</th><th>Review state</th><th>Records</th></tr>'+requirements.map(r=>{const s=stateFor(r);return '<tr><td>'+esc(r.title)+'</td><td>'+esc(r.frequency)+'</td><td>'+esc(s.label)+'</td><td>'+s.rows.length+'</td></tr>';}).join('')+'</table><h2>Evidence files</h2><ul>'+manifest.map(a=>'<li><a href="'+esc(a.export_path)+'">'+esc(a.file_name)+'</a> · Record '+esc(a.record_id)+'</li>').join('')+'</ul></body></html>';entries.push(['audit-index.html',index]);download(zip(entries),'Smithton_food_safety_'+cycle.start_date+'_to_'+cycle.end_date+'.zip');message('Audit pack downloaded with '+records.length+' records and '+attachments.length+' evidence files.');
 }catch(e){message('Audit pack could not be exported: '+e.message,true);}finally{$('export').disabled=false;}}

function renderCollection(result){
 const el=$('autoStatus');
 if(result.error){el.classList.add('fs-collector-warning');el.textContent='Collection status unavailable. Saved evidence is still available.';return;}
 const c=result.data;
 if(!c){el.classList.add('fs-collector-warning');el.textContent='Automatic collector has not reported its first run.';return;}
 const r=c.last_result||{};
 const last=c.last_finished_at?Date.parse(c.last_finished_at):NaN;
 const stale=!Number.isFinite(last)||Date.now()-last>25*60*1000;
 const failures=Number(r.errors)||0;
 const sources=Array.isArray(r.unavailableSources)?r.unavailableSources:[];
 const warning=Boolean(c.last_error)||stale||failures>0||sources.length>0;
 el.classList.toggle('fs-collector-warning',warning);
 const next=new Date((Math.floor(Date.now()/600000)+1)*600000);
 const currentRecords=records.filter(x=>x.origin==='app_import').length;
 const currentFiles=attachments.filter(x=>x.origin==='app_import').length;
 const officialPdfs=attachments.filter(x=>x.file_name==='Official_NRE_classification.pdf').length;
 const items=[
  (warning?'ATTENTION':'RUNNING')+' · '+(c.last_finished_at?'Last completed '+stamp(c.last_finished_at):'No completed collection yet')+' · Every 10 minutes · Next scheduled check about '+stamp(next.toISOString()),
  'Selected audit cycle: '+currentRecords+' automatic records · '+currentFiles+' saved source files · '+officialPdfs+' official NRE PDF'+(officialPdfs===1?'':'s'),
  'Last run: '+(r.imported??'—')+' new records · '+(r.existing??'—')+' previously archived · '+(r.filesAdded??'—')+' new files · '+(r.pending??'—')+' pending entries'
 ];
 if(stale)items.push('The collector is overdue. Check the Supabase scheduled job.');
 if(failures)items.push(failures+' source processing error'+(failures===1?'':'s')+'; retry is automatic.');
 if(sources.length)items.push('Unavailable: '+sources.join(', ')+'.');
 if(c.last_error)items.push('Latest warning: '+c.last_error);
 el.textContent=items.join('\n');
}
async function collectNow(){
 $('collectNow').disabled=true;message('Archiving app evidence…');
 try{const r=check(await sb.functions.invoke('food-safety-collector',{body:{action:'collect'}}));await refresh();message(r.busy?'A background collection is already running. The register will refresh automatically.':'App evidence collection finished: '+r.imported+' new records, '+r.filesAdded+' files. '+(r.pending?'Pending source entries: '+r.pending+'.':'No source backlog.'));}
 catch(e){message('Collection could not finish: '+e.message+'. The background collector will retry.',true);}finally{$('collectNow').disabled=false;}
}
$('signIn').onclick=async()=>{try{check(await sb.auth.signInWithOAuth({provider:'github',options:{redirectTo:location.href.split('#')[0]}}));}catch(e){message(e.message,true);}};
$('signOut').onclick=async()=>{check(await sb.auth.signOut());};
$('cycleSelect').onchange=async()=>{cycle=cycles.find(x=>x.id===$('cycleSelect').value);requirementFilter='';await refresh();};
$('refresh').onclick=refresh;$('collectNow').onclick=collectNow;$('snapshot').onclick=snapshot;$('export').onclick=exportPack;$('newCycle').onclick=openCycle;
for(const name of ['evidence','records','trace'])$(name+'Tab').onclick=()=>{requirementFilter='';showTab(name);renderRecords();};
for(const id of ['category','search','statusFilter'])$(id).addEventListener('input',render);
$('entryForm').onsubmit=saveEntry;$('reviewForm').onsubmit=saveReview;$('cycleForm').onsubmit=saveCycle;$('findBatch').onclick=trace;
$('attachFiles').onclick=async()=>{const button=$('attachFiles');button.disabled=true;try{await uploadFiles(openedRecord,[...$('extraFiles').files]);const id=openedRecord.id;await refresh();$('recordDialog').close();openRecord(id);$('attachmentMessage').textContent='Files attached.';}catch(e){$('attachmentMessage').textContent=e.message;}finally{button.disabled=false;}};
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;try{if(b.dataset.close)$(b.dataset.close).close();if(b.dataset.add)openEntry(b.dataset.add);if(b.dataset.review)openReview(b.dataset.review);if(b.dataset.filter){requirementFilter=b.dataset.filter;$('search').value='';showTab('records');renderRecords();}if(b.dataset.record)openRecord(b.dataset.record);if(b.dataset.correct)openEntry(records.find(r=>r.id===b.dataset.correct).requirement_id,records.find(r=>r.id===b.dataset.correct));if(b.dataset.file)downloadAttachment(b.dataset.file);}catch(e){message(e.message,true);}});
setInterval(()=>{if(allowed&&!document.querySelector('dialog[open]'))refresh();},60000);
sb.auth.getSession().then(r=>authorise(r.data.session));sb.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>authorise(session),0);});
})();
