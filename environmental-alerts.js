/* Device notifications while this dashboard is running; no background push service. */
(function(){
'use strict';
function create(options){
  var sent={},pending={},enabled=false,message='';
  try{enabled=localStorage.getItem(options.key)==='true';}catch(e){}
  var old=document.getElementById('notifyBtn'),button=old.cloneNode(true);old.replaceWith(button);
  var note=document.createElement('p');note.className='hint';note.setAttribute('role','status');button.parentElement.appendChild(note);
  function permitted(){return 'Notification' in window&&Notification.permission==='granted';}
  function update(){button.textContent=enabled?(permitted()?'Alerts ON ✓':'Alerts blocked — tap to retry'):'Enable alerts';note.textContent=(message?message+' ':'')+'Alerts cover '+options.scope+' while this page is running. Closed-app/background alerts are not configured.';}
  async function show(title,body,tag){
    if(!('serviceWorker' in navigator))throw Error('This browser does not support device alerts.');
    await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
    var reg=await Promise.race([navigator.serviceWorker.ready,new Promise(function(_,reject){setTimeout(function(){reject(Error('Notification service did not become ready.'));},10000);})]);
    await reg.showNotification(title,{body:body,tag:tag,renotify:true,data:{url:location.href}});
  }
  async function check(){
    update();
    var items=options.read();
    await Promise.all(items.map(async function(item){
      if(item.breach===null)return; // Unknown data must not re-arm a previous breach.
      if(!item.breach){delete sent[item.id];return;}
      if(!enabled||!permitted()||sent[item.id]||pending[item.id])return;
      pending[item.id]=true;
      try{await show(item.title,item.body,options.key+'-'+item.id);sent[item.id]=true;message='Last notification sent '+new Date().toLocaleTimeString('en-AU')+'.';}
      catch(e){message='Notification failed; will retry. '+e.message;}
      finally{delete pending[item.id];update();}
    }));
  }
  button.onclick=async function(){
    if(enabled&&permitted()){enabled=false;try{localStorage.setItem(options.key,'false');}catch(e){}message='Notifications disabled.';update();return;}
    try{
      if(!('Notification' in window))throw Error('Notifications are not supported on this device.');
      var permission=Notification.permission==='default'?await Notification.requestPermission():Notification.permission;
      if(permission!=='granted')throw Error('Allow notifications for this site in your browser settings.');
      await show('TOC alert test','Device alerts are working. Keep this dashboard open for environmental monitoring.',options.key+'-test');
      enabled=true;sent={};localStorage.setItem(options.key,'true');message='Test notification sent.';await check();
    }catch(e){message=e.message;}update();
  };
  update();setInterval(check,15000);document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});check();
  return {check:check};
}
function reading(id,name,value,limit,operator,unit){
  var known=value!==''&&value!==null&&value!==undefined&&Number.isFinite(Number(value))&&limit!==null&&limit!==undefined&&Number.isFinite(Number(limit));
  return {id:id,breach:known?(operator==='<'?Number(value)<Number(limit):operator==='>'?Number(value)>Number(limit):Number(value)>=Number(limit)):null,title:name+' ALERT',body:name+': '+value+' '+unit+'; alert threshold '+operator+' '+limit+' '+unit+'.'};
}
window.TOCAlerts={create:create,reading:reading};
})();
