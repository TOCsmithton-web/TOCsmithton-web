(function (root) {
  'use strict';
  function effectiveTime(value) {
    if (!value) return NaN;
    var m = String(value).match(/^(\d{3,4})\s*hrs\s+(\d{2})\/(\d{2})\/(\d{4})$/i);
    if (!m) return Date.parse(value);
    var hhmm = m[1].padStart(4, '0');
    var wall = Date.UTC(+m[4], +m[3]-1, +m[2], +hhmm.slice(0,2), +hhmm.slice(2));
    // Resolve the Australian/Hobart offset on this date, including daylight saving.
    var guess = wall - 10*3600000;
    var parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Australia/Hobart', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(guess));
    var p = {}; parts.forEach(function(x){p[x.type]=x.value;});
    var local = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
    return wall - (local-guess);
  }
  function label(status, depuration) {
    return status === 'CONDITIONAL' ? 'CONDITIONALLY OPEN' + (depuration ? ' — DEPURATION ONLY' : '') : status;
  }
  function resolve(input) {
    var now = input.now === undefined ? Date.now() : input.now;
    var c = input.classification || {}, sms = input.sms;
    var checked = Date.parse(c.checkedAt), ct = effectiveTime(c.effectiveFrom);
    var fresh = c.available !== false && c.area === 'Duck Bay Harvest Area' && /^\d{4}\/\d+$/.test(c.classificationNotice || '') && Number.isFinite(checked) && now >= checked && now-checked < 30*60000;
    var cs = c.statusLabel === 'OPEN (CONDITIONAL)' ? 'CONDITIONAL' : c.statusLabel;
    fresh = fresh && ['OPEN','CLOSED','CONDITIONAL'].includes(cs);
    var real = sms && sms.source === 'forwarded_sms';
    var st = real ? Date.parse(sms.effective_at || sms.received_at) : NaN;
    real = real && Number.isFinite(st) && st <= now;
    var ss = real && ['OPEN','CLOSED','CONDITIONAL'].includes(sms.reported_status) ? sms.reported_status : 'UNVERIFIED';
    var dep = real && ss === 'CONDITIONAL' && (sms.depuration_only===true || /depuration/i.test(sms.message || ''));
    var state = {status:'UNVERIFIED',label:'UNVERIFIED',basis:'unverified',confirmation:'NRE status unverified',canHarvest:false,classificationFresh:!!fresh,sms:real?sms:null,noticeNumber:c.classificationNotice||'',classificationStatus:fresh?label(cs,/depuration/i.test(c.details||'')):'UNVERIFIED',classificationEffective:c.effectiveFrom||'',checkedAt:c.checkedAt||'',effectiveAt:''};
    if (real) {
      state.status=ss; state.label=label(ss,dep); state.effectiveAt=sms.effective_at||sms.received_at;
      var matched=fresh && ss===cs && Number.isFinite(ct) && ct>=st && ct<=now && (!dep || /depuration/i.test(c.details||''));
      if (matched) {
        state.basis='both';state.confirmation='Now verified by text and classification';
      } else {
        // A repeated check of an older notice never cancels a newer SMS report.
        state.basis='sms';state.confirmation='Text report takes priority — awaiting matching classification';
      }
      // A later official restriction must still supersede an earlier opening SMS.
      if (fresh && Number.isFinite(ct) && ct>st && ct<=now && (cs==='CLOSED'||cs==='CONDITIONAL')) {
        state.status=cs;state.label=label(cs,/depuration/i.test(c.details||''));state.effectiveAt=c.effectiveFrom;
        state.basis='classification';state.confirmation='Newer classification takes priority over the earlier text report';
      }
    } else if (fresh && input.smsAvailable === true) {
      state.status=cs;state.label=label(cs,/depuration/i.test(c.details||''));state.effectiveAt=c.effectiveFrom||'';
      state.basis='classification';state.confirmation='Verified by classification';
    }
    state.canHarvest=state.status==='OPEN' && input.smsAvailable===true && ['classification','both','sms'].includes(state.basis);
    // The live forwarded ShellMAP SMS controls status while an older classification catches up.
    if(input.smsAvailable!==true)state.confirmation+=' • latest SMS check unavailable';
    return state;
  }
  async function load() {
    async function read(url) {
      var response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('NRE source unavailable');
      return response.json();
    }
    var results=await Promise.allSettled([
      read('https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-classification.json?ts='+Date.now()),
      read('https://gyzxsugnlobxlvqjevhh.supabase.co/functions/v1/nre-sms-public')
    ]);
    return {
      classification:results[0].status==='fulfilled'?Object.assign({},results[0].value,{available:true}):{available:false},
      sms:results[1].status==='fulfilled'?results[1].value.latest:null,
      smsAvailable:results[1].status==='fulfilled'
    };
  }
  root.TOCNre = {resolve:resolve,effectiveTime:effectiveTime,load:load};
})(typeof window !== 'undefined' ? window : globalThis);
