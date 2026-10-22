-- =====================================================================
--  IKRIS — Contacts (address book for WhatsApp campaigns)
--  • One row per phone number (digits only, with country code).
--  • Created by staff (single / CSV bulk upload) or automatically from
--    every WhatsApp chat (trigger on chat_conversations).
--  • Row Level Security:
--      admin        → all contacts
--      department   → contacts of their department(s), contacts they created,
--                     and contacts whose WhatsApp chat they can see
-- =====================================================================

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,
  name        text,
  email       text,
  company     text,
  country     text,
  tags        text[] not null default '{}',
  department  text,
  notes       text,
  opted_out   boolean not null default false,
  source      text not null default 'manual' check (source in ('manual', 'upload', 'whatsapp')),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_tags_idx on public.contacts using gin (tags);
create index if not exists contacts_created_idx on public.contacts (created_at desc);

-- ---------- helpers ----------
create or replace function chat_private.can_see_contact(dep text, ph text, creator text) returns boolean
language sql stable security definer set search_path = '' as $$
  select chat_private.is_admin()
      or lower(coalesce(creator, '')) = chat_private.my_email()
      or (chat_private.norm(dep) <> '' and chat_private.can_see_department(dep))
      or exists (select 1 from public.chat_conversations c
                 where c.customer_phone = ph and chat_private.can_see_chat(c.department, c.shared_departments))
$$;

create or replace function chat_private.can_write_contact_department(dep text) returns boolean
language sql stable security definer set search_path = '' as $$
  select chat_private.is_admin() or (chat_private.norm(dep) <> '' and chat_private.can_see_department(dep))
$$;
grant execute on function chat_private.can_see_contact(text, text, text), chat_private.can_write_contact_department(text) to authenticated;

-- Normalise phone, stamp creator and timestamps.
create or replace function chat_private.contacts_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  if length(new.phone) < 8 or length(new.phone) > 15 then
    raise exception 'Invalid phone number: use the full number with country code (8–15 digits).' using errcode = '22023';
  end if;
  new.name := nullif(btrim(coalesce(new.name, '')), '');
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.tags := coalesce((select array_agg(distinct t order by t) from unnest(new.tags) t where btrim(t) <> ''), '{}');
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, nullif(chat_private.my_email(), ''));
  else
    new.created_by := old.created_by;
    new.source := old.source;
    new.created_at := old.created_at;
  end if;
  return new;
end
$$;
drop trigger if exists contacts_before_write on public.contacts;
create trigger contacts_before_write before insert or update on public.contacts
  for each row execute function chat_private.contacts_before_write();

-- Every WhatsApp chat becomes (or fills in) a contact.
create or replace function chat_private.contact_from_chat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if length(regexp_replace(coalesce(new.customer_phone, ''), '\D', '', 'g')) >= 8 then
    insert into public.contacts (phone, name, department, source, created_by)
    values (new.customer_phone, new.customer_name, new.department, 'whatsapp', 'whatsapp')
    on conflict (phone) do update
      set name = coalesce(public.contacts.name, excluded.name),
          department = coalesce(public.contacts.department, excluded.department);
  end if;
  return new;
end
$$;
drop trigger if exists chat_conversations_contact on public.chat_conversations;
create trigger chat_conversations_contact after insert or update of customer_name, department on public.chat_conversations
  for each row execute function chat_private.contact_from_chat();

-- ---------- RLS ----------
alter table public.contacts enable row level security;

create policy "view visible contacts" on public.contacts
  for select to authenticated using (chat_private.can_see_contact(department, phone, created_by));
create policy "add contacts to own department" on public.contacts
  for insert to authenticated with check ((select chat_private.is_staff()) and chat_private.can_write_contact_department(department));
create policy "edit visible contacts" on public.contacts
  for update to authenticated
  using (chat_private.can_see_contact(department, phone, created_by))
  with check (chat_private.is_admin() or chat_private.norm(department) = '' or chat_private.can_see_department(department) or lower(coalesce(created_by, '')) = chat_private.my_email());
create policy "delete own department contacts" on public.contacts
  for delete to authenticated
  using (chat_private.is_admin() or lower(coalesce(created_by, '')) = chat_private.my_email() or (chat_private.norm(department) <> '' and chat_private.can_see_department(department)));

revoke all on public.contacts from anon;
grant select, delete on public.contacts to authenticated;
grant insert (phone, name, email, company, country, tags, department, notes, opted_out, source) on public.contacts to authenticated;
grant update (name, email, company, country, tags, department, notes, opted_out) on public.contacts to authenticated;

-- ---------- backfill from existing chats ----------
insert into public.contacts (phone, name, department, source, created_by, created_at)
select c.customer_phone, c.customer_name, c.department, 'whatsapp', 'whatsapp', c.created_at
from public.chat_conversations c
where length(regexp_replace(coalesce(c.customer_phone, ''), '\D', '', 'g')) between 8 and 15
on conflict (phone) do nothing;

-- Campaign recipients can come from contacts.
alter table public.campaign_recipients add column if not exists contact_id uuid references public.contacts(id) on delete set null;
