-- =====================================================================
--  Ikris Pharma Network — Chat Inbox (WhatsApp conversations)
--  Supabase stores conversations + messages. Access is enforced by RLS:
--    admin       → every conversation
--    department  → conversations whose department is one of theirs
--  Inquiry data stays in Google Sheets; nothing here touches it.
-- =====================================================================

create schema if not exists chat_private;
grant usage on schema chat_private to authenticated;

-- ---------- Staff & access ----------
create table public.chat_staff (
  email        text primary key check (email = lower(email)),
  display_name text,
  role         text not null check (role in ('admin', 'department')),
  departments  text[] not null default '{}',
  created_at   timestamptz not null default now()
);

-- Server-only settings (ingest secret, n8n send webhook). No policies → only service role can read.
create table public.chat_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- ---------- Conversations & messages ----------
create table public.chat_conversations (
  id               uuid primary key default gen_random_uuid(),
  customer_phone   text not null,
  customer_name    text,
  channel          text not null default 'Ikris',
  department       text,
  assigned_to      text,
  status           text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  inquiry_id       text,
  last_message     text,
  last_message_at  timestamptz,
  last_inbound_at  timestamptz,
  unread_count     integer not null default 0 check (unread_count >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index chat_conversations_phone_key on public.chat_conversations (customer_phone);
create index chat_conversations_last_msg_idx on public.chat_conversations (last_message_at desc nulls last);

create table public.chat_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.chat_conversations (id) on delete cascade,
  direction        text not null check (direction in ('in', 'out')),
  sender_type      text not null check (sender_type in ('customer', 'bot', 'agent', 'system')),
  sender_name      text,
  sender_email     text,
  body             text,
  attachment_url   text,   -- external URL (e.g. media received from WhatsApp)
  attachment_path  text,   -- path in storage bucket "chat-attachments" (files sent from the dashboard)
  attachment_type  text,
  attachment_name  text,
  wa_message_id    text unique,
  delivery_status  text not null default 'received'
                   check (delivery_status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'not_sent')),
  error            text,
  is_read          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index chat_messages_conv_idx on public.chat_messages (conversation_id, created_at);

-- ---------- Helper functions (not exposed through the API) ----------
create or replace function chat_private.norm(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]', '', 'g')
$$;

create or replace function chat_private.my_email() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function chat_private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chat_staff s where s.email = chat_private.my_email())
$$;

create or replace function chat_private.can_see_department(dep text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_staff s
    where s.email = chat_private.my_email()
      and (
        s.role = 'admin'
        or (chat_private.norm(dep) <> ''
            and exists (select 1 from unnest(s.departments) d where chat_private.norm(d) = chat_private.norm(dep)))
      )
  )
$$;

create or replace function chat_private.can_see_conversation(conv uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_conversations c
    where c.id = conv and chat_private.can_see_department(c.department)
  )
$$;

-- Safe variant for storage paths ("<conversation-uuid>/<file>")
create or replace function chat_private.can_see_conversation_path(folder text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return chat_private.can_see_conversation(folder::uuid);
exception when others then
  return false;
end
$$;


-- ---------- Triggers ----------
create or replace function chat_private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger chat_conversations_touch
before update on public.chat_conversations
for each row execute function chat_private.touch_updated_at();

-- Keeps last message / unread count / status in sync whenever a message is stored.
create or replace function chat_private.on_message_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  preview text;
begin
  preview := coalesce(nullif(btrim(new.body), ''),
                      case when new.attachment_name is not null then '📎 ' || new.attachment_name
                           when new.attachment_url is not null or new.attachment_path is not null then '📎 Attachment'
                           else '' end);
  update public.chat_conversations c set
    last_message    = left(preview, 280),
    last_message_at = greatest(coalesce(c.last_message_at, new.created_at), new.created_at),
    last_inbound_at = case when new.direction = 'in' then greatest(coalesce(c.last_inbound_at, new.created_at), new.created_at)
                           else c.last_inbound_at end,
    unread_count    = case when new.direction = 'in' and not new.is_read then c.unread_count + 1 else c.unread_count end,
    status          = case when new.direction = 'in' and c.status in ('resolved', 'closed') then 'open' else c.status end
  where c.id = new.conversation_id;
  return new;
end
$$;

create trigger chat_messages_after_insert
after insert on public.chat_messages
for each row execute function chat_private.on_message_insert();

revoke all on all functions in schema chat_private from public;
grant execute on function chat_private.norm(text), chat_private.my_email(), chat_private.is_staff(),
  chat_private.can_see_department(text), chat_private.can_see_conversation(uuid),
  chat_private.can_see_conversation_path(text) to authenticated;

-- ---------- RLS ----------
alter table public.chat_staff         enable row level security;
alter table public.chat_settings      enable row level security;
alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;

create policy "staff can view staff list" on public.chat_staff
  for select to authenticated using ((select chat_private.is_staff()));

create policy "view conversations of own departments" on public.chat_conversations
  for select to authenticated using (chat_private.can_see_department(department));

create policy "update conversations of own departments" on public.chat_conversations
  for update to authenticated
  using (chat_private.can_see_department(department))
  with check (chat_private.can_see_department(department));

create policy "view messages of visible conversations" on public.chat_messages
  for select to authenticated using (chat_private.can_see_conversation(conversation_id));

-- Clients may only change routing fields; counters and previews are server-managed.
revoke all on public.chat_conversations from anon;
revoke all on public.chat_messages from anon;
revoke all on public.chat_staff from anon;
revoke all on public.chat_settings from anon, authenticated;
revoke insert, update, delete, truncate on public.chat_conversations from authenticated;
grant  update (department, assigned_to, status, priority, customer_name) on public.chat_conversations to authenticated;
revoke insert, update, delete, truncate on public.chat_messages from authenticated;
revoke insert, update, delete, truncate on public.chat_staff from authenticated;

-- ---------- RPC: mark a conversation as read ----------
create or replace function public.chat_mark_read(conv uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not chat_private.can_see_conversation(conv) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.chat_messages set is_read = true
   where conversation_id = conv and direction = 'in' and not is_read;
  update public.chat_conversations set unread_count = 0 where id = conv and unread_count <> 0;
end
$$;
revoke execute on function public.chat_mark_read(uuid) from public, anon;
grant  execute on function public.chat_mark_read(uuid) to authenticated;

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.chat_conversations;
alter publication supabase_realtime add table public.chat_messages;

-- ---------- Storage for attachments sent from the dashboard ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 20971520)
on conflict (id) do nothing;

create policy "chat attachments: upload to visible conversations" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-attachments'
              and chat_private.can_see_conversation_path((storage.foldername(name))[1]));

create policy "chat attachments: read visible conversations" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-attachments'
         and chat_private.can_see_conversation_path((storage.foldername(name))[1]));

-- ---------- Seed (run once; keep in line with DASHBOARD_ACCESS in the Apps Script) ----------
-- insert into public.chat_staff (email, display_name, role, departments) values (...);
-- insert into public.chat_settings (key, value) values
--   ('ingest_secret', '<random secret>'), ('send_webhook_secret', '<same secret>'), ('send_webhook_url', '');
