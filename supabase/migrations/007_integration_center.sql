-- =====================================================================
--  IKRIS — API Integration Center
--  • integrations          : registry of external APIs (safe metadata only)
--  • credentials           : stored ENCRYPTED in Supabase Vault (vault.secrets);
--                            the table keeps only the Vault id + last-4 hint
--  • integration_metrics   : one row per outbound API call (no bodies, no headers)
--  • webhook_endpoints     : callback URLs that receive signed WhatsApp events
--  • webhook_deliveries    : delivery attempts (payload kept only until delivered)
--  • integration_clients   : API keys for other Ikris projects (SHA-256 hash only)
--  • integration_audit     : who changed what (never secrets)
--  Access: admin logins can READ (RLS). All writes go through the
--  "integrations" edge function (service role) which checks the admin role.
-- =====================================================================

create table if not exists public.integrations (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  name             text not null,
  provider         text not null,
  base_url         text,
  auth_type        text not null default 'bearer'
                   check (auth_type in ('none', 'bearer', 'api_key_header', 'basic', 'oauth2_client', 'managed')),
  auth_header      text,                       -- header name for api_key_header
  config           jsonb not null default '{}'::jsonb,  -- non-secret settings (test path, ids, custom header names/values that are not secret)
  managed_by       text not null default 'center' check (managed_by in ('center', 'n8n', 'external')),
  secret_id        uuid,                       -- vault.secrets.id (never exposed)
  secret_hint      text,                       -- e.g. "••••3f9a"
  enabled          boolean not null default true,
  status           text not null default 'untested' check (status in ('untested', 'connected', 'failed', 'disabled')),
  last_tested_at   timestamptz,
  last_test        jsonb,                      -- {ok, http, ms, message, details}
  rotated_at       timestamptz,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_by       text,
  updated_at       timestamptz not null default now()
);

create table if not exists public.integration_metrics (
  id            bigint generated always as identity primary key,
  integration   text not null,                 -- integrations.slug
  endpoint      text,                          -- path or action only (no query strings)
  method        text,
  status_code   int,
  ok            boolean not null,
  duration_ms   int,
  error         text,                          -- short, redacted
  source        text,                          -- which function made the call
  client_id     uuid,                          -- integration_clients.id when called by another project
  created_at    timestamptz not null default now()
);
create index if not exists integration_metrics_time_idx on public.integration_metrics (created_at desc);
create index if not exists integration_metrics_integ_idx on public.integration_metrics (integration, created_at desc);

create table if not exists public.webhook_endpoints (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  url               text not null,
  events            text[] not null default array['message.received', 'message.status'],
  enabled           boolean not null default true,
  secret_id         uuid,                      -- vault: HMAC signing secret
  secret_hint       text,
  status            text not null default 'untested' check (status in ('untested', 'healthy', 'failing', 'disabled')),
  last_delivery_at  timestamptz,
  last_status_code  int,
  last_error        text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.webhook_deliveries (
  id            bigint generated always as identity primary key,
  endpoint_id   uuid not null references public.webhook_endpoints(id) on delete cascade,
  event_id      text not null,                 -- idempotency key sent as X-Ikris-Event-Id
  event_type    text not null,
  payload       jsonb,                         -- cleared after successful delivery
  status        text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts      int not null default 0,
  next_attempt_at timestamptz not null default now(),
  status_code   int,
  duration_ms   int,
  error         text,
  is_test       boolean not null default false,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  unique (endpoint_id, event_id)
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (status, next_attempt_at) where status = 'pending';
create index if not exists webhook_deliveries_time_idx on public.webhook_deliveries (created_at desc);

create table if not exists public.integration_clients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  key_prefix    text not null,                 -- first 12 chars, shown in UI
  key_hash      text not null unique,          -- sha256 hex of the full key
  allowed       text[] not null default '{}',  -- integration slugs this key may use
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz not null default now()
);

create table if not exists public.integration_audit (
  id          bigint generated always as identity primary key,
  actor       text,
  action      text not null,
  target      text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists integration_audit_time_idx on public.integration_audit (created_at desc);
create index if not exists integration_audit_actor_idx on public.integration_audit (actor, created_at desc);

-- ---------- RLS: admins read, nobody writes directly ----------
alter table public.integrations        enable row level security;
alter table public.integration_metrics enable row level security;
alter table public.webhook_endpoints   enable row level security;
alter table public.webhook_deliveries  enable row level security;
alter table public.integration_clients enable row level security;
alter table public.integration_audit   enable row level security;

create policy "admins read integrations"   on public.integrations        for select to authenticated using ((select chat_private.is_admin()));
create policy "admins read metrics"        on public.integration_metrics for select to authenticated using ((select chat_private.is_admin()));
create policy "admins read webhooks"       on public.webhook_endpoints   for select to authenticated using ((select chat_private.is_admin()));
create policy "admins read deliveries"     on public.webhook_deliveries  for select to authenticated using ((select chat_private.is_admin()));
create policy "admins read clients"        on public.integration_clients for select to authenticated using ((select chat_private.is_admin()));
create policy "admins read audit"          on public.integration_audit   for select to authenticated using ((select chat_private.is_admin()));

revoke all on public.integrations, public.integration_metrics, public.webhook_endpoints,
              public.webhook_deliveries, public.integration_clients, public.integration_audit from anon, authenticated;
-- Browser may read only non-secret columns.
grant select (id, slug, name, provider, base_url, auth_type, auth_header, config, managed_by, secret_hint, enabled, status,
              last_tested_at, last_test, rotated_at, created_by, created_at, updated_by, updated_at)
  on public.integrations to authenticated;
grant select on public.integration_metrics, public.integration_audit to authenticated;
grant select (id, name, url, events, enabled, secret_hint, status, last_delivery_at, last_status_code, last_error, created_by, created_at, updated_at)
  on public.webhook_endpoints to authenticated;
grant select (id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, status_code, duration_ms, error, is_test, created_at, delivered_at)
  on public.webhook_deliveries to authenticated;
grant select (id, name, key_prefix, allowed, expires_at, revoked_at, last_used_at, created_by, created_at)
  on public.integration_clients to authenticated;

-- ---------- Vault helpers (service role only) ----------
create or replace function public.integ_put_secret(p_id uuid, p_secret text, p_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if p_id is null then
    select vault.create_secret(p_secret, 'integ:' || gen_random_uuid()::text, coalesce(p_label, '')) into v;
    return v;
  end if;
  perform vault.update_secret(p_id, p_secret);
  return p_id;
end $$;

create or replace function public.integ_read_secret(p_id uuid)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id
$$;

create or replace function public.integ_drop_secret(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets where id = p_id
$$;

revoke all on function public.integ_put_secret(uuid, text, text), public.integ_read_secret(uuid), public.integ_drop_secret(uuid) from public, anon, authenticated;
grant execute on function public.integ_put_secret(uuid, text, text), public.integ_read_secret(uuid), public.integ_drop_secret(uuid) to service_role;

-- ---------- Usage summary (admins) ----------
create or replace function public.integration_usage(p_from timestamptz, p_to timestamptz, p_integration text default null,
                                                    p_ok boolean default null, p_endpoint text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not chat_private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  with m as (
    select * from public.integration_metrics
    where created_at >= p_from and created_at < p_to
      and (p_integration is null or integration = p_integration)
      and (p_ok is null or ok = p_ok)
      and (p_endpoint is null or endpoint = p_endpoint)
  ), d as (
    select * from public.webhook_deliveries where created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'ok', (select count(*) from m where ok),
    'failed', (select count(*) from m where not ok),
    'avg_ms', (select round(avg(duration_ms)) from m where duration_ms is not null),
    'by_integration', coalesce((select jsonb_agg(x order by (x->>'total')::int desc) from (
        select jsonb_build_object('integration', integration, 'total', count(*), 'ok', count(*) filter (where ok),
                                  'failed', count(*) filter (where not ok), 'avg_ms', round(avg(duration_ms))) x
        from m group by integration) s), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('code', coalesce(status_code::text, 'no response'), 'count', count(*)) x
        from m group by status_code order by count(*) desc) s), '[]'::jsonb),
    'endpoints', coalesce((select jsonb_agg(distinct endpoint) from m where endpoint is not null), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x->>'day') from (
        select jsonb_build_object('day', to_char(date_trunc('day', created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD'),
                                  'ok', count(*) filter (where ok), 'failed', count(*) filter (where not ok)) x
        from m group by date_trunc('day', created_at at time zone 'Asia/Kolkata')) s), '[]'::jsonb),
    'webhooks', jsonb_build_object(
        'total', (select count(*) from d where not is_test),
        'delivered', (select count(*) from d where status = 'delivered' and not is_test),
        'failed', (select count(*) from d where status = 'failed' and not is_test),
        'pending', (select count(*) from d where status = 'pending'),
        'tests', (select count(*) from d where is_test))
  ) into r;
  return r;
end $$;
revoke all on function public.integration_usage(timestamptz, timestamptz, text, boolean, text) from public, anon;
grant execute on function public.integration_usage(timestamptz, timestamptz, text, boolean, text) to authenticated;

-- ---------- Registry: integrations that already exist (keys stay in n8n) ----------
insert into public.integrations (slug, name, provider, base_url, auth_type, managed_by, config, created_by)
values
  ('whatsapp_cloud', 'WhatsApp Cloud API (Meta)', 'whatsapp_cloud', 'https://graph.facebook.com/v23.0', 'managed', 'n8n',
   '{"note":"Access token is stored in the n8n credential \"WhatsApp account\". Tested through the n8n template API workflow.","waba_id":"2277080626413317","phone_number_id":"1349374634922231","inbound_webhook":"https://ikris.app.n8n.cloud/webhook/mda-whatsapp"}', 'system'),
  ('openrouter', 'OpenRouter AI (chatbot model)', 'openrouter', 'https://openrouter.ai/api/v1', 'managed', 'n8n',
   '{"note":"API key is stored in the n8n credential \"OpenRouter account 3\". Tested through the n8n health workflow.","model":"anthropic/claude-haiku-4.5"}', 'system'),
  ('n8n_send', 'n8n – WhatsApp send & media', 'n8n', 'https://ikris.app.n8n.cloud/webhook', 'managed', 'n8n',
   '{"note":"Webhooks used by the dashboard to send messages, templates and media. Protected by the shared x-ikris-secret header."}', 'system'),
  ('google_sheet', 'Google Sheet department_inquery (Apps Script)', 'apps_script',
   'https://script.google.com/macros/s/AKfycby2Jfb9REtb89dYxSqDO_DgQ1Bm0GDaklhdC8xi0rFnnW_VJXh_DPwr6fJt5Os0IB0eMg/exec', 'managed', 'external',
   '{"note":"Read with the signed-in user''s token. Credentials are managed by Google Apps Script."}', 'system')
on conflict (slug) do nothing;
