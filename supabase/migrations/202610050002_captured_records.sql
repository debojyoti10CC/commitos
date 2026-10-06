-- Expand only: legacy tables and their existing rows are left intact.
-- Apply after 202610050001_commitos.sql before deploying the records API.
-- A previous app may still save a snapshot without `records`; that never erases captures.
create table public.captured_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 500),
  content text not null check (length(content) between 1 and 20000),
  kind text not null check (kind in ('task','note','idea','event','reference')),
  collection text not null check (length(collection) between 1 and 200),
  tags text[] not null default '{}', contacts text[] not null default '{}',
  deadline timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  source text not null check (source in ('text','voice','telegram','legacy')),
  status text not null default 'active' check (status in ('active','archived')),
  capture_id text not null check (length(capture_id) between 1 and 200),
  interpretation jsonb not null check (
    jsonb_typeof(interpretation) = 'object'
    and interpretation ?& array['provider','confidence','warnings','inferred_fields']
    and interpretation->>'provider' in ('local','gemini')
    and jsonb_typeof(interpretation->'confidence') = 'number'
    and (interpretation->>'confidence')::numeric between 0 and 1
    and jsonb_typeof(interpretation->'warnings') = 'array'
    and jsonb_typeof(interpretation->'inferred_fields') = 'array'
  ),
  unique (id,user_id)
);
create index captured_records_user_created on public.captured_records(user_id,created_at desc);
create index captured_records_user_capture on public.captured_records(user_id,capture_id);
create index captured_records_user_collection on public.captured_records(user_id,collection) where status='active';
alter table public.captured_records enable row level security;
create policy owner_read on public.captured_records for select to authenticated using (auth.uid()=user_id);
revoke all on public.captured_records from anon,authenticated;
grant select on public.captured_records to authenticated;
grant all on public.captured_records to service_role;

-- Retain the first RPC implementation unchanged, then extend its public entry points.
-- Both saves run in the same PostgreSQL transaction and share the user version lock.
alter function public.load_commitos_state(uuid) rename to load_commitos_state_v1;
alter function public.save_commitos_state(uuid,bigint,jsonb) rename to save_commitos_state_v1;
revoke all on function public.load_commitos_state_v1(uuid) from public,anon,authenticated,service_role;
revoke all on function public.save_commitos_state_v1(uuid,bigint,jsonb) from public,anon,authenticated,service_role;

create function public.load_commitos_state(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; records_json jsonb;
begin
  result=public.load_commitos_state_v1(p_user_id);
  if result is null then return null; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at,r.id),'[]'::jsonb)
    into records_json from public.captured_records r where r.user_id=p_user_id;
  return result||jsonb_build_object('records',records_json);
end $$;

create function public.save_commitos_state(p_user_id uuid,p_expected_version bigint,p_state jsonb) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; saved_version bigint;
begin
  if (p_state->>'user_id')::uuid is distinct from p_user_id then raise exception 'OWNER_MISMATCH'; end if;
  if p_state ? 'records' then
    if jsonb_typeof(p_state->'records') is distinct from 'array' then raise exception 'INVALID_STATE_ARRAY'; end if;
    for item in select * from jsonb_array_elements(p_state->'records') loop
      if (item->>'user_id')::uuid is distinct from p_user_id then raise exception 'OWNER_MISMATCH'; end if;
      if exists(select 1 from public.captured_records where id=(item->>'id')::uuid and user_id<>p_user_id) then raise exception 'OWNER_MISMATCH'; end if;
    end loop;
  end if;
  saved_version=public.save_commitos_state_v1(p_user_id,p_expected_version,p_state);
  if p_state ? 'records' then
    insert into public.captured_records as existing
      select * from jsonb_populate_recordset(null::public.captured_records,p_state->'records')
    on conflict(id) do update set
      title=excluded.title,content=excluded.content,kind=excluded.kind,collection=excluded.collection,
      tags=excluded.tags,contacts=excluded.contacts,deadline=excluded.deadline,
      updated_at=excluded.updated_at,status=excluded.status,interpretation=excluded.interpretation
    where existing.user_id=p_user_id and
      row(existing.title,existing.content,existing.kind,existing.collection,existing.tags,existing.contacts,existing.deadline,existing.updated_at,existing.status,existing.interpretation)
      is distinct from
      row(excluded.title,excluded.content,excluded.kind,excluded.collection,excluded.tags,excluded.contacts,excluded.deadline,excluded.updated_at,excluded.status,excluded.interpretation);
    -- Missing rows are preserved. User deletion is represented by status='archived'.
    -- Immutable provenance (owner, created_at, source and capture_id) is never replaced.
  end if;
  return saved_version;
end $$;
revoke all on function public.load_commitos_state(uuid) from public,anon,authenticated;
revoke all on function public.save_commitos_state(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.load_commitos_state(uuid) to service_role;
grant execute on function public.save_commitos_state(uuid,bigint,jsonb) to service_role;

-- Rollback the app independently: this expansion is backward compatible.
-- To restore only the previous RPCs, retain captured_records and its data, drop
-- the two wrapper functions, rename *_state_v1 back to *_state, and restore
-- their service_role execute grants. Do not drop captured_records on rollback.
