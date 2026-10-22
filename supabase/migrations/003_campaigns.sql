-- =====================================================================
--  IKRIS — WhatsApp templates & campaigns
--  wa_templates        cache of the WhatsApp Business Account's message templates
--  campaigns           one row per campaign (template sent to many chat contacts)
--  campaign_recipients one row per contact in a campaign
--  Sending happens in the "wa-campaigns" edge function (service role); the
--  dashboard only reads these tables, filtered by Row Level Security:
--    admin       → everything
--    department  → campaigns of their department(s) or created by them
-- =====================================================================

create table if not exists public.wa_templates (
  name            text not null,
  language        text not null,
  meta_id         text,
  category        text,
  status          text,
  rejected_reason text,
  components      jsonb not null default '[]',
  header_format   text,
  header_text     text,
  body_text       text,
  footer_text     text,
  body_vars       int  not null default 0,
  header_vars     int  not null default 0,
  sendable        boolean not null default true,
  created_by      text,
  created_by_name text,
  department      text,
  synced_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (name, language)
);

create table if not exists public.campaigns (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  template_name     text not null,
  template_language text not null,
  department        text,
  variables         jsonb not null default '{}',
  status            text not null default 'sending' check (status in ('sending', 'completed', 'failed')),
  total             int not null default 0,
  sent              int not null default 0,
  failed            int not null default 0,
  created_by        text not null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create table if not exists public.campaign_recipients (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  conversation_id uuid references public.chat_conversations(id) on delete set null,
  phone           text not null,
  customer_name   text,
  message_id      uuid references public.chat_messages(id) on delete set null,
  wa_message_id   text,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists campaign_recipients_campaign_idx on public.campaign_recipients (campaign_id);
create index if not exists campaigns_created_idx on public.campaigns (created_at desc);

-- Template messages are shown in the chat thread with a "Template" tag.
alter table public.chat_messages add column if not exists template_name text;
alter table public.chat_messages add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;

-- ---------- access helpers ----------
create or replace function chat_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chat_staff s where s.email = chat_private.my_email() and s.role = 'admin')
$$;

create or replace function chat_private.can_see_campaign(dep text, creator text) returns boolean
language sql stable security definer set search_path = '' as $$
  select chat_private.is_admin()
      or lower(coalesce(creator, '')) = chat_private.my_email()
      or (chat_private.norm(dep) <> '' and chat_private.can_see_department(dep))
$$;
grant execute on function chat_private.is_admin(), chat_private.can_see_campaign(text, text) to authenticated;

-- ---------- RLS (read-only for the dashboard) ----------
alter table public.wa_templates        enable row level security;
alter table public.campaigns           enable row level security;
alter table public.campaign_recipients enable row level security;

create policy "staff can view templates" on public.wa_templates
  for select to authenticated using ((select chat_private.is_staff()));

create policy "view own department campaigns" on public.campaigns
  for select to authenticated using (chat_private.can_see_campaign(department, created_by));

create policy "view recipients of visible campaigns" on public.campaign_recipients
  for select to authenticated using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and chat_private.can_see_campaign(c.department, c.created_by)));

revoke all on public.wa_templates, public.campaigns, public.campaign_recipients from anon;
revoke insert, update, delete on public.wa_templates, public.campaigns, public.campaign_recipients from authenticated;
grant select on public.wa_templates, public.campaigns, public.campaign_recipients to authenticated;

-- ---------- delivery statistics per campaign ----------
-- Counts follow the WhatsApp status of each sent message (sent → delivered → read).
create or replace function public.campaign_stats()
returns table (campaign_id uuid, total int, sent int, delivered int, read int, failed int, replied int)
language sql stable security definer set search_path = '' as $$
  select c.id,
         count(r.id)::int,
         count(*) filter (where m.delivery_status in ('sent', 'delivered', 'read'))::int,
         count(*) filter (where m.delivery_status in ('delivered', 'read'))::int,
         count(*) filter (where m.delivery_status = 'read')::int,
         count(*) filter (where r.status = 'failed' or m.delivery_status = 'failed')::int,
         count(*) filter (where exists (
           select 1 from public.chat_messages i
           where i.conversation_id = r.conversation_id and i.direction = 'in' and i.created_at > r.sent_at))::int
  from public.campaigns c
  left join public.campaign_recipients r on r.campaign_id = c.id
  left join public.chat_messages m on m.id = r.message_id
  where chat_private.can_see_campaign(c.department, c.created_by)
  group by c.id
$$;
revoke all on function public.campaign_stats() from public, anon;
grant execute on function public.campaign_stats() to authenticated;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.campaigns;
