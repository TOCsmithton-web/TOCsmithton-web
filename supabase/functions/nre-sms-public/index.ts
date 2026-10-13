// Public projection of the forwarded ShellMAP report. Sender and intake credentials stay private.
Deno.serve(async (req: Request) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://tocsmithton-web.github.io',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  };
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers});
  if (req.method === 'OPTIONS') return new Response(null, {headers});
  if (req.method !== 'GET') return response({error:'Method not allowed'},405);
  try {
    const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Missing server configuration');
    const endpoint = new URL('/rest/v1/toc_nre_sms_events', url);
    endpoint.searchParams.set('select','reported_status,effective_at,received_at,source,verified,message');
    endpoint.searchParams.set('bay','eq.Duck Bay');
    endpoint.searchParams.set('source','eq.forwarded_sms');
    endpoint.searchParams.set('or', '(effective_at.lte.'+new Date().toISOString()+',effective_at.is.null)');
    endpoint.searchParams.set('order','effective_at.desc.nullslast,received_at.desc,id.desc');
    endpoint.searchParams.set('limit','1');
    const result = await fetch(endpoint,{headers:{apikey:key,Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
    if (!result.ok) throw new Error('Database query failed');
    const rows = await result.json(), row = rows[0];
    // Publish only the existing status/timestamps and a derived condition, never the private message or sender.
    const latest = row ? {
      reported_status:row.reported_status,
      effective_at:row.effective_at,
      received_at:row.received_at,
      source:row.source,
      verified:row.verified,
      depuration_only:row.reported_status==='CONDITIONAL' && /depuration/i.test(row.message||''),
    } : null;
    return response({latest});
  } catch {
    return response({error:'Status unavailable'},503);
  }
});
