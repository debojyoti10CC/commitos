-- CommitOS stores domain rows independently. Secrets and pairing records are service-only.
create extension if not exists pgcrypto;

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 0 check (version >= 0),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.commitments (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 500), description text not null default '', project text,
  commitment_type text not null check (commitment_type in ('deliverable','communication','follow_up','deadline','academic','administrative','meeting','content','project','recurring','personal','other')),
  contact_name text, organization text, source text not null default 'manual', source_reference text, source_url text,
  status text not null check (status in ('inbox','scheduled','in_progress','waiting','blocked','done','cancelled')),
  priority text not null check (priority in ('low','medium','high','critical')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deadline timestamptz, check_in_at timestamptz, scheduled_start timestamptz, scheduled_end timestamptz,
  estimated_minutes integer not null check (estimated_minutes >= 0), completed_minutes numeric(12,2) not null default 0 check (completed_minutes >= 0), remaining_minutes numeric(12,2) not null check (remaining_minutes >= 0),
  next_action text, risk_score numeric not null default 0 check (risk_score between 0 and 100),
  risk_level text not null default 'safe' check (risk_level in ('safe','attention','high','critical','impossible')),
  last_risk_calculation_at timestamptz, last_reminded_at timestamptz, reminder_count integer not null default 0 check (reminder_count >= 0), snoozed_until timestamptz,
  started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, metadata jsonb not null default '{}'::jsonb,
  unique (id,user_id), check (scheduled_end is null or scheduled_start is null or scheduled_end > scheduled_start)
);
create index commitments_user_deadline on public.commitments(user_id,deadline) where status not in ('done','cancelled');
create table public.projects (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, description text not null default '', color text not null default '#14b8a6', archived boolean not null default false, created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.contacts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, organization text not null default '', email text not null default '', telegram text not null default '', notes text not null default '', unique(id,user_id)
);
create table public.work_sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, commitment_id uuid not null,
  started_at timestamptz not null, ended_at timestamptz, duration_minutes numeric(12,2) not null default 0 check (duration_minutes >= 0), notes text not null default '',
  foreign key(commitment_id,user_id) references public.commitments(id,user_id) on delete cascade,
  check(ended_at is null or ended_at >= started_at)
);
create unique index one_active_session_per_user on public.work_sessions(user_id) where ended_at is null;
create table public.reminders (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, commitment_id uuid,
  scheduled_for timestamptz not null, type text not null, status text not null check(status in ('pending','sending','sent','failed')),
  sent_at timestamptz, provider text not null, dedupe_key text not null, payload jsonb not null default '{}'::jsonb,
  foreign key(commitment_id,user_id) references public.commitments(id,user_id) on delete cascade, unique(user_id,dedupe_key)
);
create index reminders_pending on public.reminders(user_id,scheduled_for) where status in ('pending','failed');
create table public.integration_accounts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check(provider in ('telegram','google')), connected boolean not null default false, metadata jsonb not null default '{}'::jsonb, unique(user_id,provider)
);
create table public.integration_secrets (
  user_id uuid not null references auth.users(id) on delete cascade, provider text not null, encrypted_value text not null,
  primary key(user_id,provider)
);
create table public.daily_reviews (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  date date not null, planned_minutes integer not null default 0, completed_minutes integer not null default 0,
  completed_count integer not null default 0, overdue_count integer not null default 0, summary text not null default '', created_at timestamptz not null default now(), unique(user_id,date)
);
create table public.activity_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, commitment_id uuid,
  type text not null, message text not null, created_at timestamptz not null default now(),
  foreign key(commitment_id,user_id) references public.commitments(id,user_id) on delete cascade
);
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, title text not null,
  start timestamptz not null, "end" timestamptz not null, source text not null check(source in ('local','google','focus')), commitment_id uuid, external_id text,
  foreign key(commitment_id,user_id) references public.commitments(id,user_id) on delete cascade, check("end" > start)
);
create table public.gmail_candidates (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  email_id text not null, subject text not null, sender text not null, body text not null, parsed jsonb,
  status text not null check(status in ('pending','accepted','ignored')), created_at timestamptz not null default now(), unique(user_id,email_id)
);
create table public.telegram_pairings (
  user_id uuid primary key references auth.users(id) on delete cascade, token_hash text not null unique, expires_at timestamptz not null
);
create table public.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade, chat_id text not null unique, connected_at timestamptz not null default now()
);
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  label text not null, token_hash text not null unique, created_at timestamptz not null default now(), revoked_at timestamptz
);

do $$ declare t text; begin
  foreach t in array array['user_settings','commitments','projects','contacts','work_sessions','reminders','integration_accounts','daily_reviews','activity_events','calendar_events','gmail_candidates'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy owner_read on public.%I for select to authenticated using (auth.uid() = user_id)',t);
    -- Writes run through the transactional API, so authenticated clients cannot bypass version checks.
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  foreach t in array array['integration_secrets','telegram_pairings','telegram_connections','device_tokens'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create function public.load_commitos_state(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb; entry record; rows_json jsonb;
begin
  select jsonb_build_object('version',version,'user_id',user_id,'settings',settings) into result from public.user_settings where user_id=p_user_id for share;
  if result is null then return null; end if;
  for entry in select * from (values
    ('commitments','commitments'),('projects','projects'),('contacts','contacts'),('work_sessions','sessions'),('reminders','reminders'),('integration_accounts','integrations'),('daily_reviews','reviews'),('activity_events','activity'),('calendar_events','calendar_events'),('gmail_candidates','candidates')) as x(table_name,state_key)
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from public.%I t where user_id=$1',entry.table_name) into rows_json using p_user_id;
    result=result||jsonb_build_object(entry.state_key,rows_json);
  end loop;
  return result;
end $$;

create function public.save_commitos_state(p_user_id uuid,p_expected_version bigint,p_state jsonb) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare current_version bigint; entry record; item jsonb;
begin
  if (p_state->>'user_id')::uuid is distinct from p_user_id then raise exception 'OWNER_MISMATCH'; end if;
  insert into public.user_settings(user_id,version,settings) values(p_user_id,0,'{}') on conflict(user_id) do nothing;
  select version into current_version from public.user_settings where user_id=p_user_id for update;
  if current_version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  for entry in select * from (values
    ('commitments','commitments'),('projects','projects'),('contacts','contacts'),('work_sessions','sessions'),('reminders','reminders'),('integration_accounts','integrations'),('daily_reviews','reviews'),('activity_events','activity'),('calendar_events','calendar_events'),('gmail_candidates','candidates')) as x(table_name,state_key)
  loop
    if jsonb_typeof(p_state->entry.state_key) is distinct from 'array' then raise exception 'INVALID_STATE_ARRAY'; end if;
    for item in select * from jsonb_array_elements(p_state->entry.state_key) loop
      if (item->>'user_id')::uuid is distinct from p_user_id then raise exception 'OWNER_MISMATCH'; end if;
    end loop;
  end loop;
  delete from public.work_sessions where user_id=p_user_id;
  delete from public.reminders where user_id=p_user_id;
  delete from public.activity_events where user_id=p_user_id;
  delete from public.calendar_events where user_id=p_user_id;
  delete from public.commitments where user_id=p_user_id;
  delete from public.projects where user_id=p_user_id;
  delete from public.contacts where user_id=p_user_id;
  delete from public.integration_accounts where user_id=p_user_id;
  delete from public.daily_reviews where user_id=p_user_id;
  delete from public.gmail_candidates where user_id=p_user_id;
  -- Parents are inserted first; owner-composite foreign keys reject cross-account references.
  for entry in select * from (values
    ('commitments','commitments'),('projects','projects'),('contacts','contacts'),('work_sessions','sessions'),('reminders','reminders'),('integration_accounts','integrations'),('daily_reviews','reviews'),('activity_events','activity'),('calendar_events','calendar_events'),('gmail_candidates','candidates')) as x(table_name,state_key)
  loop
    execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I,$1)',entry.table_name,entry.table_name) using p_state->entry.state_key;
  end loop;
  update public.user_settings set version=current_version+1,settings=p_state->'settings',updated_at=now() where user_id=p_user_id;
  return current_version+1;
end $$;

create function public.redeem_telegram_pairing(p_token_hash text,p_chat_id text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner_id uuid;
begin
  select user_id into owner_id from public.telegram_pairings where token_hash=p_token_hash and expires_at>now() for update;
  if owner_id is null then return null; end if;
  if exists(select 1 from public.telegram_connections where chat_id=p_chat_id and user_id<>owner_id) then return null; end if;
  insert into public.telegram_connections(user_id,chat_id) values(owner_id,p_chat_id) on conflict(user_id) do update set chat_id=excluded.chat_id,connected_at=now();
  delete from public.telegram_pairings where user_id=owner_id;
  return owner_id;
end $$;

revoke all on function public.load_commitos_state(uuid) from public,anon,authenticated;
revoke all on function public.save_commitos_state(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.redeem_telegram_pairing(text,text) from public,anon,authenticated;
grant execute on function public.load_commitos_state(uuid) to service_role;
grant execute on function public.save_commitos_state(uuid,bigint,jsonb) to service_role;
grant execute on function public.redeem_telegram_pairing(text,text) to service_role;
