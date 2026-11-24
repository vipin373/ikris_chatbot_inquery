-- =====================================================================
--  IKRIS — Employee Management + Leave Management (WhatsApp)
--  New objects only. No existing table, policy or function is changed.
--
--  Dashboard (HR + admins only, via existing login):
--    • read employees / leave requests / audit / notification log (RLS)
--    • add / edit / deactivate employees ONLY through hr_save_employee()
--      and hr_set_employee_status() (server-side validation + audit)
--    • nobody can change a leave status from the dashboard
--  WhatsApp (leave-bot edge function, shared secret):
--    • leave_submit()  → creates the request (LV-YYYY-NNNN) atomically
--    • leave_decide()  → assigned manager approves / rejects (one-time token)
--  HR = chat_staff with a department named "Hr" (or "HR"), plus admins.
-- =====================================================================

-- ---------- access helper ----------
create or replace function chat_private.is_hr_or_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_staff s
    where s.email = chat_private.my_email()
      and (s.role = 'admin' or exists (select 1 from unnest(s.departments) d where chat_private.norm(d) = 'hr'))
  )
$$;
grant execute on function chat_private.is_hr_or_admin() to authenticated;

create or replace function chat_private.india_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) = 10 then '91' || regexp_replace(p, '\D', '', 'g')
    when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) = 11 and regexp_replace(p, '\D', '', 'g') like '0%' then '91' || substr(regexp_replace(p, '\D', '', 'g'), 2)
    else regexp_replace(coalesce(p, ''), '\D', '', 'g') end
$$;

-- ---------- employees ----------
create table if not exists public.employees (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          text not null,
  employee_name        text not null,
  whatsapp_number      text not null,
  designation          text not null,
  reporting_manager_id uuid references public.employees(id),
  status               text not null default 'active' check (status in ('active', 'inactive')),
  hr_flag              text,                    -- data issue for HR to fix (shown in the dashboard)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           text,
  updated_by           text,
  constraint employees_not_own_manager check (reporting_manager_id is null or reporting_manager_id <> id),
  constraint employees_phone_digits check (whatsapp_number ~ '^[0-9]{10,15}$')
);
create unique index if not exists employees_employee_id_uq on public.employees (upper(btrim(employee_id)));
-- one ACTIVE employee per WhatsApp number (the number is the identity on WhatsApp)
create unique index if not exists employees_active_phone_uq on public.employees (whatsapp_number) where status = 'active';
create index if not exists employees_manager_idx on public.employees (reporting_manager_id);

create table if not exists public.employee_audit (
  id            bigint generated always as identity primary key,
  employee_uuid uuid not null references public.employees(id),
  action        text not null,               -- created | updated | manager_changed | deactivated | reactivated
  changes       jsonb not null default '{}',
  performed_by  text,
  performed_at  timestamptz not null default now()
);
create index if not exists employee_audit_emp_idx on public.employee_audit (employee_uuid, performed_at desc);

-- ---------- leave requests ----------
create table if not exists public.leave_request_counters (year integer primary key, last_no integer not null default 0);

create table if not exists public.leave_requests (
  id                         uuid primary key default gen_random_uuid(),
  request_id                 text not null unique,                 -- LV-2026-0001
  employee_id                uuid not null references public.employees(id),
  employee_code_snapshot     text not null,
  employee_name_snapshot     text not null,
  designation_snapshot       text,
  employee_whatsapp_snapshot text not null,
  manager_id                 uuid not null references public.employees(id),
  manager_code_snapshot      text,
  manager_name_snapshot      text not null,
  manager_whatsapp_snapshot  text not null,
  from_date                  date not null,
  to_date                    date not null,
  leave_reason               text not null,
  status                     text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  rejection_reason           text,
  applied_at                 timestamptz not null default now(),
  decision_at                timestamptz,
  decided_by                 uuid references public.employees(id),
  decided_by_name            text,
  hr_review_flag             text,                                 -- e.g. employee deactivated while pending
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint leave_dates_ok check (to_date >= from_date),
  constraint leave_reject_reason check (status <> 'REJECTED' or coalesce(btrim(rejection_reason), '') <> '')
);
create index if not exists leave_requests_status_idx on public.leave_requests (status, applied_at desc);
create index if not exists leave_requests_emp_idx on public.leave_requests (employee_id, applied_at desc);
-- the same employee cannot have two PENDING requests for the same dates (duplicate submissions)
create unique index if not exists leave_requests_no_dup_pending on public.leave_requests (employee_id, from_date, to_date) where status = 'PENDING';

create table if not exists public.leave_request_audit (
  id                  bigint generated always as identity primary key,
  leave_request_id    uuid not null references public.leave_requests(id),
  previous_status     text,
  new_status          text not null,
  action_type         text not null,            -- submitted | approved | rejected | flagged
  action_performed_by text,
  rejection_reason    text,
  details             jsonb not null default '{}',
  action_timestamp    timestamptz not null default now()
);
create index if not exists leave_request_audit_req_idx on public.leave_request_audit (leave_request_id, action_timestamp);

-- one-time Approve/Reject token per request (sent in the button payload)
create table if not exists public.leave_action_tokens (
  token            text primary key,
  leave_request_id uuid not null unique references public.leave_requests(id),
  manager_id       uuid not null references public.employees(id),
  created_at       timestamptz not null default now(),
  used_at          timestamptz
);

-- every WhatsApp message the leave system sends (no duplicates, real delivery status)
create table if not exists public.leave_notifications (
  id               uuid primary key default gen_random_uuid(),
  leave_request_id uuid references public.leave_requests(id),
  employee_uuid    uuid references public.employees(id),
  recipient_role   text not null check (recipient_role in ('employee', 'manager', 'hr')),
  kind             text not null,              -- manager_card | hr_new | hr_decision | employee_decision | hr_alert
  phone            text not null,
  method           text,                       -- template | session
  template_name    text,
  status           text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'read', 'failed')),
  wa_message_id    text unique,
  error            text,
  attempts         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists leave_notifications_once on public.leave_notifications (leave_request_id, kind) where leave_request_id is not null;
create index if not exists leave_notifications_req_idx on public.leave_notifications (leave_request_id);

-- WhatsApp conversation state (employee applying, manager typing a rejection reason)
create table if not exists public.leave_sessions (
  phone      text primary key,
  kind       text not null check (kind in ('apply', 'reject_reason')),
  step       text not null,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- last time each number wrote to us through the leave system (24-hour WhatsApp window)
create table if not exists public.leave_inbound (phone text primary key, last_in_at timestamptz not null default now());

-- ---------- updated_at ----------
create or replace trigger employees_touch before update on public.employees for each row execute function chat_private.touch_updated_at();
create or replace trigger leave_requests_touch before update on public.leave_requests for each row execute function chat_private.touch_updated_at();
create or replace trigger leave_notifications_touch before update on public.leave_notifications for each row execute function chat_private.touch_updated_at();

-- ---------- RLS ----------
alter table public.employees enable row level security;
alter table public.employee_audit enable row level security;
alter table public.leave_request_counters enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_request_audit enable row level security;
alter table public.leave_action_tokens enable row level security;
alter table public.leave_notifications enable row level security;
alter table public.leave_sessions enable row level security;
alter table public.leave_inbound enable row level security;

revoke all on public.employees, public.employee_audit, public.leave_request_counters, public.leave_requests,
  public.leave_request_audit, public.leave_action_tokens, public.leave_notifications, public.leave_sessions,
  public.leave_inbound from anon, authenticated;
grant select on public.employees, public.employee_audit, public.leave_requests, public.leave_request_audit,
  public.leave_notifications to authenticated;

create policy "hr read employees" on public.employees for select to authenticated using (chat_private.is_hr_or_admin());
create policy "hr read employee audit" on public.employee_audit for select to authenticated using (chat_private.is_hr_or_admin());
create policy "hr read leave" on public.leave_requests for select to authenticated using (chat_private.is_hr_or_admin());
create policy "hr read leave audit" on public.leave_request_audit for select to authenticated using (chat_private.is_hr_or_admin());
create policy "hr read leave notifications" on public.leave_notifications for select to authenticated using (chat_private.is_hr_or_admin());
-- (no insert/update/delete policies: writes only through the functions below)

-- ---------- HR: add / edit employee ----------
create or replace function public.hr_save_employee(p jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me        text := chat_private.my_email();
  v_id      uuid := nullif(p->>'id', '')::uuid;
  v_code    text := upper(btrim(coalesce(p->>'employee_id', '')));
  v_name    text := btrim(regexp_replace(coalesce(p->>'employee_name', ''), '\s+', ' ', 'g'));
  v_phone   text := chat_private.india_phone(p->>'whatsapp_number');
  v_desig   text := btrim(coalesce(p->>'designation', ''));
  v_mgr     uuid := nullif(p->>'reporting_manager_id', '')::uuid;
  v_status  text := lower(coalesce(nullif(p->>'status', ''), 'active'));
  old       public.employees;
  mgr       public.employees;
  dup       public.employees;
  saved     public.employees;
  chg       jsonb := '{}';
  warn      text := null;
begin
  if not chat_private.is_hr_or_admin() then
    return jsonb_build_object('ok', false, 'error', 'Only HR and administrators can manage employees.');
  end if;
  if v_code = '' or v_name = '' or v_desig = '' or coalesce(p->>'whatsapp_number', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Employee ID, name, WhatsApp number and designation are required.');
  end if;
  if v_mgr is null then
    return jsonb_build_object('ok', false, 'error', 'Select the reporting manager.');
  end if;
  if v_phone !~ '^[0-9]{10,15}$' or length(v_phone) < 12 then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid WhatsApp number (10-digit Indian number, or the full number with country code).');
  end if;
  if v_status not in ('active', 'inactive') then v_status := 'active'; end if;

  if v_id is not null then
    select * into old from public.employees where id = v_id for update;
    if old.id is null then return jsonb_build_object('ok', false, 'error', 'Employee not found.'); end if;
    if v_mgr = v_id then return jsonb_build_object('ok', false, 'error', 'An employee cannot be their own reporting manager.'); end if;
  end if;

  select * into dup from public.employees where upper(btrim(employee_id)) = v_code and (v_id is null or id <> v_id);
  if dup.id is not null then
    return jsonb_build_object('ok', false, 'error', format('Employee ID %s already belongs to %s.', v_code, dup.employee_name));
  end if;
  select * into dup from public.employees where whatsapp_number = v_phone and status = 'active' and (v_id is null or id <> v_id);
  if dup.id is not null and v_status = 'active' then
    return jsonb_build_object('ok', false, 'error', format('WhatsApp number +%s is already registered to %s (%s). Each active employee needs their own number.', v_phone, dup.employee_name, dup.employee_id));
  end if;
  select * into dup from public.employees where whatsapp_number = v_phone and status = 'inactive' and (v_id is null or id <> v_id) limit 1;
  if dup.id is not null then warn := format('Note: this number was previously used by %s (%s, inactive).', dup.employee_name, dup.employee_id); end if;

  select * into mgr from public.employees where id = v_mgr;
  if mgr.id is null or mgr.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'The reporting manager must be an active employee in the directory. Add or reactivate the manager first.');
  end if;
  if v_id is not null and exists (            -- no reporting loops (A → B → A)
    with recursive up as (
      select id, reporting_manager_id, 1 as depth from public.employees where id = v_mgr
      union all
      select e.id, e.reporting_manager_id, up.depth + 1 from public.employees e join up on e.id = up.reporting_manager_id where up.depth < 50)
    select 1 from up where id = v_id) then
    return jsonb_build_object('ok', false, 'error', format('%s already reports (directly or indirectly) to this employee, so they cannot be the manager.', mgr.employee_name));
  end if;

  if v_id is null then
    insert into public.employees (employee_id, employee_name, whatsapp_number, designation, reporting_manager_id, status, created_by, updated_by)
    values (v_code, v_name, v_phone, v_desig, v_mgr, v_status, me, me) returning * into saved;
    insert into public.employee_audit (employee_uuid, action, changes, performed_by)
    values (saved.id, 'created', jsonb_build_object('employee_id', v_code, 'employee_name', v_name, 'whatsapp_number', v_phone,
            'designation', v_desig, 'reporting_manager', mgr.employee_name || ' (' || mgr.employee_id || ')', 'status', v_status), me);
    return jsonb_build_object('ok', true, 'created', true, 'id', saved.id, 'warning', warn);
  end if;

  if v_status = 'inactive' and old.status = 'active' then
    return jsonb_build_object('ok', false, 'error', 'Use the Deactivate button to deactivate an employee.');
  end if;
  if old.employee_id is distinct from v_code then chg := chg || jsonb_build_object('employee_id', jsonb_build_array(old.employee_id, v_code)); end if;
  if old.employee_name is distinct from v_name then chg := chg || jsonb_build_object('employee_name', jsonb_build_array(old.employee_name, v_name)); end if;
  if old.whatsapp_number is distinct from v_phone then chg := chg || jsonb_build_object('whatsapp_number', jsonb_build_array(old.whatsapp_number, v_phone)); end if;
  if old.designation is distinct from v_desig then chg := chg || jsonb_build_object('designation', jsonb_build_array(old.designation, v_desig)); end if;
  if old.reporting_manager_id is distinct from v_mgr then
    chg := chg || jsonb_build_object('reporting_manager', jsonb_build_array(
      (select employee_name || ' (' || employee_id || ')' from public.employees where id = old.reporting_manager_id),
      mgr.employee_name || ' (' || mgr.employee_id || ')'));
  end if;
  if old.status is distinct from v_status then chg := chg || jsonb_build_object('status', jsonb_build_array(old.status, v_status)); end if;
  if chg = '{}'::jsonb then return jsonb_build_object('ok', true, 'id', v_id, 'unchanged', true); end if;

  update public.employees set employee_id = v_code, employee_name = v_name, whatsapp_number = v_phone, designation = v_desig,
         reporting_manager_id = v_mgr, status = v_status, updated_by = me,
         hr_flag = case when chg ? 'reporting_manager' then null else hr_flag end
   where id = v_id;
  insert into public.employee_audit (employee_uuid, action, changes, performed_by)
  values (v_id, case when chg ? 'reporting_manager' then 'manager_changed' when chg ? 'status' then 'reactivated' else 'updated' end, chg, me);
  return jsonb_build_object('ok', true, 'id', v_id, 'warning', warn);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'That employee ID or WhatsApp number is already in use.');
end
$$;

-- ---------- HR: deactivate / reactivate ----------
create or replace function public.hr_set_employee_status(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me    text := chat_private.my_email();
  e     public.employees;
  team  text;
  n     integer;
begin
  if not chat_private.is_hr_or_admin() then
    return jsonb_build_object('ok', false, 'error', 'Only HR and administrators can manage employees.');
  end if;
  select * into e from public.employees where id = p_id for update;
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'Employee not found.'); end if;
  p_status := lower(coalesce(p_status, ''));
  if p_status not in ('active', 'inactive') or e.status = p_status then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  if p_status = 'inactive' then
    select string_agg(employee_name || ' (' || employee_id || ')', ', ' order by employee_name) into team
      from public.employees where reporting_manager_id = p_id and status = 'active';
    if team is not null then
      return jsonb_build_object('ok', false, 'error', format('%s is the reporting manager of: %s. Reassign them to another manager first.', e.employee_name, team));
    end if;
    update public.employees set status = 'inactive', updated_by = me where id = p_id;
    insert into public.employee_audit (employee_uuid, action, changes, performed_by)
    values (p_id, 'deactivated', jsonb_build_object('status', jsonb_build_array('active', 'inactive')), me);
    -- pending requests stay as they are; flag them for HR review
    update public.leave_requests set hr_review_flag = 'Employee was deactivated while this request was pending.'
     where employee_id = p_id and status = 'PENDING';
    get diagnostics n = row_count;
    insert into public.leave_request_audit (leave_request_id, previous_status, new_status, action_type, action_performed_by, details)
    select id, status, status, 'flagged', me, jsonb_build_object('note', 'Employee deactivated while pending') from public.leave_requests
     where employee_id = p_id and status = 'PENDING';
    delete from public.leave_sessions where phone = e.whatsapp_number and kind = 'apply';
    return jsonb_build_object('ok', true, 'pending_flagged', n);
  end if;

  if exists (select 1 from public.employees where whatsapp_number = e.whatsapp_number and status = 'active' and id <> p_id) then
    return jsonb_build_object('ok', false, 'error', 'Another active employee already uses this WhatsApp number.');
  end if;
  update public.employees set status = 'active', updated_by = me where id = p_id;
  insert into public.employee_audit (employee_uuid, action, changes, performed_by)
  values (p_id, 'reactivated', jsonb_build_object('status', jsonb_build_array('inactive', 'active')), me);
  return jsonb_build_object('ok', true);
end
$$;
revoke all on function public.hr_save_employee(jsonb), public.hr_set_employee_status(uuid, text) from public, anon;
grant execute on function public.hr_save_employee(jsonb), public.hr_set_employee_status(uuid, text) to authenticated;

-- ---------- WhatsApp: who is this number? (leave-bot only) ----------
create or replace function public.leave_identify(p_secret text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e  public.employees;
  m  public.employees;
begin
  if not chat_private.bot_secret_ok(p_secret) then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into e from public.employees where whatsapp_number = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
   order by (status = 'active') desc limit 1;
  if e.id is null then return jsonb_build_object('ok', true, 'employee', null); end if;
  select * into m from public.employees where id = e.reporting_manager_id;
  return jsonb_build_object('ok', true,
    'employee', jsonb_build_object('id', e.id, 'employee_id', e.employee_id, 'name', e.employee_name, 'designation', e.designation,
                                   'whatsapp', e.whatsapp_number, 'status', e.status),
    'manager', case when m.id is null then null else jsonb_build_object('id', m.id, 'employee_id', m.employee_id, 'name', m.employee_name,
                                   'whatsapp', m.whatsapp_number, 'status', m.status) end);
end
$$;

-- ---------- WhatsApp: submit (leave-bot only) ----------
create or replace function public.leave_submit(p_secret text, p_phone text, p_from date, p_to date, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e    public.employees;
  m    public.employees;
  r    public.leave_requests;
  yr   integer := extract(year from (now() at time zone 'Asia/Kolkata'))::integer;
  n    integer;
  tok  text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  if not chat_private.bot_secret_ok(p_secret) then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into e from public.employees where whatsapp_number = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') and status = 'active';
  if e.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_EMPLOYEE'); end if;
  select * into m from public.employees where id = e.reporting_manager_id;
  if m.id is null or m.status <> 'active' or coalesce(m.whatsapp_number, '') = '' then
    return jsonb_build_object('ok', false, 'code', 'NO_MANAGER');
  end if;
  if p_from is null or p_to is null or p_to < p_from or coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'INVALID');
  end if;
  select * into r from public.leave_requests where employee_id = e.id and from_date = p_from and to_date = p_to and status = 'PENDING';
  if r.id is not null then return jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'request_id', r.request_id); end if;

  insert into public.leave_request_counters as c (year, last_no) values (yr, 1)
  on conflict (year) do update set last_no = c.last_no + 1 returning last_no into n;

  insert into public.leave_requests (request_id, employee_id, employee_code_snapshot, employee_name_snapshot, designation_snapshot,
         employee_whatsapp_snapshot, manager_id, manager_code_snapshot, manager_name_snapshot, manager_whatsapp_snapshot,
         from_date, to_date, leave_reason)
  values ('LV-' || yr || '-' || lpad(n::text, 4, '0'), e.id, e.employee_id, e.employee_name, e.designation, e.whatsapp_number,
          m.id, m.employee_id, m.employee_name, m.whatsapp_number, p_from, p_to, left(btrim(p_reason), 500))
  returning * into r;
  insert into public.leave_request_audit (leave_request_id, previous_status, new_status, action_type, action_performed_by, details)
  values (r.id, null, 'PENDING', 'submitted', e.employee_name || ' (' || e.employee_id || ') via WhatsApp', jsonb_build_object('phone', e.whatsapp_number));
  insert into public.leave_action_tokens (token, leave_request_id, manager_id) values (tok, r.id, m.id);
  return jsonb_build_object('ok', true, 'request', to_jsonb(r), 'token', tok);
exception when unique_violation then
  select * into r from public.leave_requests where employee_id = e.id and from_date = p_from and to_date = p_to and status = 'PENDING';
  return jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'request_id', r.request_id);
end
$$;

-- ---------- WhatsApp: manager decision (leave-bot only) ----------
-- p_action: 'check' (validate a Reject tap before asking for the reason), 'approve', 'reject'
create or replace function public.leave_decide(p_secret text, p_phone text, p_token text, p_action text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t   public.leave_action_tokens;
  r   public.leave_requests;
  mgr public.employees;
  st  text;
begin
  if not chat_private.bot_secret_ok(p_secret) then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into t from public.leave_action_tokens where token = coalesce(p_token, '') for update;
  if t.token is null then return jsonb_build_object('ok', false, 'code', 'UNKNOWN'); end if;
  select * into r from public.leave_requests where id = t.leave_request_id for update;
  -- the sender must be the ACTIVE employee who is the manager recorded on this request
  select * into mgr from public.employees
   where whatsapp_number = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') and status = 'active';
  if mgr.id is null or mgr.id <> r.manager_id or mgr.id <> t.manager_id then
    return jsonb_build_object('ok', false, 'code', 'NOT_ASSIGNED', 'request_id', r.request_id);
  end if;
  if r.status <> 'PENDING' or t.used_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'request', to_jsonb(r));
  end if;
  if p_action = 'check' then return jsonb_build_object('ok', true, 'request', to_jsonb(r)); end if;
  if p_action = 'reject' and coalesce(btrim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED'); end if;
  if p_action not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'code', 'INVALID'); end if;

  st := case when p_action = 'approve' then 'APPROVED' else 'REJECTED' end;
  update public.leave_requests
     set status = st, rejection_reason = case when st = 'REJECTED' then left(btrim(p_reason), 500) end,
         decision_at = now(), decided_by = mgr.id, decided_by_name = mgr.employee_name
   where id = r.id returning * into r;
  update public.leave_action_tokens set used_at = now() where token = t.token;
  insert into public.leave_request_audit (leave_request_id, previous_status, new_status, action_type, action_performed_by, rejection_reason, details)
  values (r.id, 'PENDING', st, lower(st), mgr.employee_name || ' (' || mgr.employee_id || ') via WhatsApp', r.rejection_reason,
          jsonb_build_object('phone', mgr.whatsapp_number));
  delete from public.leave_sessions where phone = mgr.whatsapp_number and kind = 'reject_reason';
  return jsonb_build_object('ok', true, 'request', to_jsonb(r));
end
$$;

revoke all on function public.leave_identify(text, text), public.leave_submit(text, text, date, date, text),
  public.leave_decide(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.leave_identify(text, text), public.leave_submit(text, text, date, date, text),
  public.leave_decide(text, text, text, text, text) to service_role;

-- ---------- settings ----------
insert into public.chat_settings (key, value) values ('leave_hr_whatsapp', '919220822566') on conflict (key) do nothing;
