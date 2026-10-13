begin;
alter table public.fs_records add column origin text not null default 'manual' check(origin in ('manual','app_import'));
alter table public.fs_records add column source_key text;
alter table public.fs_records add column source_type text;
alter table public.fs_records add column source_observed_at timestamptz;
alter table public.fs_records add column source_payload jsonb;
alter table public.fs_records add column needs_completion boolean not null default false;
alter table public.fs_records alter column created_by drop not null;
alter table public.fs_records add constraint fs_record_actor check((origin='manual' and created_by is not null) or (origin='app_import' and created_by is null));
alter table public.fs_records add constraint fs_record_source_key unique(cycle_id,source_key);
alter table public.fs_attachments add column origin text not null default 'manual' check(origin in ('manual','app_import'));
alter table public.fs_attachments alter column created_by drop not null;
create table public.fs_app_evidence_queue (
 id uuid primary key default gen_random_uuid(), source_table text not null, source_pk text not null,
 source_data jsonb not null, source_version text generated always as(md5(source_data::text)) stored,
 captured_at timestamptz not null default clock_timestamp(), source_actor uuid,
 processed_at timestamptz, record_id uuid references public.fs_records(id), last_error text,
 unique(source_table,source_pk,source_version)
);
create index fs_evidence_queue_pending on public.fs_app_evidence_queue(captured_at) where processed_at is null;
create table public.fs_auto_collection_status (
 id integer primary key check(id=1),lock_until timestamptz not null default '1970-01-01',
 last_started_at timestamptz,last_finished_at timestamptz,last_result jsonb,last_error text
);
insert into public.fs_auto_collection_status(id) values(1);
alter table public.fs_app_evidence_queue enable row level security;
alter table public.fs_auto_collection_status enable row level security;
revoke all on public.fs_app_evidence_queue,public.fs_auto_collection_status from public,anon,authenticated;
grant all on public.fs_app_evidence_queue,public.fs_auto_collection_status to service_role;
grant select on public.fs_auto_collection_status to authenticated;
create policy fs_auto_collection_admin_read on public.fs_auto_collection_status for select to authenticated using(exists(select 1 from public.admin_users where user_id=(select auth.uid())));
create schema if not exists fs_internal;
revoke all on schema fs_internal from public,anon,authenticated;
-- Only database source-write triggers can enqueue privileged copies. No client can call this function.
create function fs_internal.capture_app_evidence() returns trigger language plpgsql security definer set search_path='' as $$
declare b jsonb:=to_jsonb(new); applicable boolean:=false;
begin
 if auth.uid() is null and session_user<>'postgres' and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then raise exception 'Authenticated source required'; end if;
 if auth.uid() is not null and not exists(select 1 from public.admin_users where user_id=auth.uid()) then raise exception 'Registered administrator or server source required'; end if;
 if tg_table_name='toc_nre_sms_events' then applicable:=new.bay='Duck Bay' and new.source='forwarded_sms'; b:=b-'sender'-'message_hash';
 elsif tg_table_name='manual_control_readings' then applicable:=new.location='Smithton' and new.zone in ('Duck Bay','Kemps Bay') and new.salinity is not null;
 elsif tg_table_name='meat_test_results' then applicable:=new.bay_name in ('Duck Bay','Kemps Bay','Duck Bay Salinity T0','Duck Bay Salinity T24','Duck Bay Salinity T48','Duck Bay Salinity Reopening Status','Duck Bay NRE Classification');
 end if;
 if applicable then insert into public.fs_app_evidence_queue(source_table,source_pk,source_data,source_actor) values(tg_table_name,b->>'id',b,auth.uid()) on conflict do nothing; end if;
 return new;
end $$;
revoke all on function fs_internal.capture_app_evidence() from public,anon,authenticated;
create trigger fs_archive_sms_source after insert or update on public.toc_nre_sms_events for each row execute function fs_internal.capture_app_evidence();
create trigger fs_archive_manual_source after insert or update on public.manual_control_readings for each row execute function fs_internal.capture_app_evidence();
create trigger fs_archive_test_source after insert or update on public.meat_test_results for each row execute function fs_internal.capture_app_evidence();
insert into public.fs_app_evidence_queue(source_table,source_pk,source_data) select 'toc_nre_sms_events',id::text,to_jsonb(s)-'sender'-'message_hash' from public.toc_nre_sms_events s where bay='Duck Bay' and source='forwarded_sms' on conflict do nothing;
insert into public.fs_app_evidence_queue(source_table,source_pk,source_data) select 'manual_control_readings',id::text,to_jsonb(s) from public.manual_control_readings s where location='Smithton' and zone in ('Duck Bay','Kemps Bay') and salinity is not null on conflict do nothing;
insert into public.fs_app_evidence_queue(source_table,source_pk,source_data) select 'meat_test_results',id::text,to_jsonb(s) from public.meat_test_results s where bay_name in ('Duck Bay','Kemps Bay','Duck Bay Salinity T0','Duck Bay Salinity T24','Duck Bay Salinity T48','Duck Bay Salinity Reopening Status','Duck Bay NRE Classification') on conflict do nothing;
-- Historic records keep their original dates in the previous audit period.
insert into public.fs_audit_cycles(title,start_date,end_date,audit_due_on)
select 'Smithton '||extract(year from start_date-interval '1 year')::integer||'–'||extract(year from start_date)::integer||' historical evidence',(start_date-interval '1 year')::date,start_date-1,start_date-1
from public.fs_audit_cycles where start_date='2026-10-08' on conflict(site,start_date,end_date) do nothing;
create or replace function public.fs_validate_evidence() returns trigger language plpgsql security invoker set search_path='' as $$
declare c public.fs_audit_cycles; r public.fs_records; requirement public.fs_requirements; field jsonb; v jsonb; automated boolean:=false;
begin
 automated:=tg_table_name in ('fs_records','fs_attachments') and to_jsonb(new)->>'origin'='app_import';
 if automated then
  if current_user not in ('service_role','postgres') then raise exception 'Only the server collector may import app evidence'; end if;
  new.created_by:=null;
 else
  if auth.uid() is null or not exists(select 1 from public.admin_users where user_id=auth.uid()) then raise exception 'Registered administrator required'; end if;
  new.created_by:=auth.uid();
 end if;
 new.created_at:=clock_timestamp();
 if tg_table_name='fs_records' then
  select * into c from public.fs_audit_cycles where id=new.cycle_id;
  if new.record_date<c.start_date or new.record_date>c.end_date then raise exception 'Record date must be inside the selected audit cycle'; end if;
  if new.record_date>(now() at time zone 'Australia/Hobart')::date then raise exception 'Evidence cannot be dated in the future'; end if;
  select * into requirement from public.fs_requirements where id=new.requirement_id;
  if new.requirement_id in ('harvest-record','stock-movements','relay-record','dispatch-label','stock-ledger','cold-chain','vibrio-control','depuration-run','harvest-hold') and length(trim(new.batch_ref))=0 then raise exception 'Batch reference required'; end if;
  if new.supersedes_id is not null then
   select * into r from public.fs_records where id=new.supersedes_id;
   if r.id is null or r.cycle_id<>new.cycle_id or r.requirement_id<>new.requirement_id then raise exception 'Correction must belong to the same audit cycle and evidence requirement'; end if;
  end if;
  if automated then
   if new.source_key is null or new.source_type is null or new.source_payload is null then raise exception 'Source provenance required'; end if;
   new.needs_completion:=false;
  else
   new.needs_completion:=false;
  end if;
  for field in select value from jsonb_array_elements(requirement.fields) loop
   v:=new.details->(field->>'key');
   if (field->>'required')::boolean and (v is null or v='null'::jsonb or trim(v #>> '{}')='') then
    if automated then new.needs_completion:=true; else raise exception 'Required field: %',field->>'label'; end if;
   end if;
   if v is not null and v<>'null'::jsonb and trim(v #>> '{}')<>'' then
    if field->>'type'='number' and jsonb_typeof(v)<>'number' then raise exception 'Numeric field required: %',field->>'label'; end if;
    if field->>'type'='number' and field->>'key'='quantity' and ((v #>> '{}')::numeric<=0 or (v #>> '{}')::numeric<>trunc((v #>> '{}')::numeric)) then raise exception 'Quantity must be a positive whole oyster count'; end if;
    if field->>'type'='select' and not (field->'options' ? (v #>> '{}')) then raise exception 'Invalid choice: %',field->>'label'; end if;
   end if;
  end loop;
  if automated and new.needs_completion then new.outcome:='PENDING'; end if;
  if new.requirement_id='stock-ledger' and ((new.details->>'quantity')::numeric<=0 or (new.details->>'quantity')::numeric<>trunc((new.details->>'quantity')::numeric)) then raise exception 'Stock movement requires a positive whole oyster count'; end if;
 elsif tg_table_name='fs_attachments' then
  select * into r from public.fs_records where id=new.record_id;
  if r.id is null or split_part(new.object_path,'/',1)<>r.cycle_id::text or split_part(new.object_path,'/',2)<>r.id::text then raise exception 'Attachment path does not match its evidence record'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='smithton-food-safety' and o.name=new.object_path) then raise exception 'Upload the evidence file before linking it to the record'; end if;
 elsif tg_table_name='fs_reviews' and new.status='reviewed' then
  if exists(select 1 from public.fs_records x where x.cycle_id=new.cycle_id and x.requirement_id=new.requirement_id and x.needs_completion and not exists(select 1 from public.fs_records y where y.supersedes_id=x.id)) then raise exception 'Complete the imported evidence details using a correction before review sign-off'; end if;
  if not exists(select 1 from public.fs_records x where x.cycle_id=new.cycle_id and x.requirement_id=new.requirement_id and not exists(select 1 from public.fs_records y where y.supersedes_id=x.id)) then raise exception 'Collect evidence before signing off the review'; end if;
  select * into requirement from public.fs_requirements where id=new.requirement_id;
  if requirement.attachment_required and exists(select 1 from public.fs_records x where x.cycle_id=new.cycle_id and x.requirement_id=new.requirement_id and x.evidence_reference='' and not exists(select 1 from public.fs_records y where y.supersedes_id=x.id) and not exists(select 1 from public.fs_attachments a where a.record_id=x.id)) then raise exception 'Attach the supporting documents or an approved evidence link before review sign-off'; end if;
 end if;
 return new;
end $$;
update public.fs_requirements set fields=(select jsonb_agg(case when f->>'key'='stage' then jsonb_set(f,'{options}',(f->'options')||'["Reset after closure","In progress"]'::jsonb) else f end) from jsonb_array_elements(fields) f) where id='salinity-reopening';
-- Service-only, security-invoker importer. Existing rows are never overwritten on retry.
create function public.fs_import_app_records(p_records jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; r public.fs_records; output jsonb:='[]'; added boolean;
begin
 if current_user not in ('service_role','postgres') then raise exception 'Server collector required'; end if;
 for item in select value from jsonb_array_elements(p_records) loop
  r:=null;
  insert into public.fs_records(cycle_id,requirement_id,record_date,title,performed_by,outcome,details,notes,origin,source_key,source_type,source_observed_at,source_payload)
  values((item->>'cycle_id')::uuid,item->>'requirement_id',(item->>'record_date')::date,item->>'title','TOC app automatic collector','RECORDED',coalesce(item->'details','{}'),coalesce(item->>'notes',''),'app_import',item->>'source_key',item->>'source_type',nullif(item->>'source_observed_at','')::timestamptz,item->'source_payload')
  on conflict(cycle_id,source_key) do nothing returning * into r;
  added:=r.id is not null;
  if r.id is null then select * into r from public.fs_records where cycle_id=(item->>'cycle_id')::uuid and source_key=item->>'source_key'; end if;
  output:=output||jsonb_build_array(jsonb_build_object('record_id',r.id,'cycle_id',r.cycle_id,'source_key',r.source_key,'inserted',added,'needs_completion',r.needs_completion,'source_payload',r.source_payload,'source_observed_at',r.source_observed_at));
 end loop;
 return output;
end $$;
revoke all on function public.fs_import_app_records(jsonb) from public,anon,authenticated;
grant execute on function public.fs_import_app_records(jsonb) to service_role;
commit;
