-- =====================================================================
--  IKRIS Chat inbox — a chat stays visible to EVERY department the
--  customer has been routed to (one chat per phone number).
--  e.g. customer raised a Rare Disease inquiry, then an Import inquiry:
--  Sneha (Rare Disease) and the Import team both keep seeing the chat.
--  "department" is still the current/primary department.
-- =====================================================================

alter table public.chat_conversations
  add column if not exists shared_departments text[] not null default '{}';

-- Remember every department a chat is routed to.
create or replace function chat_private.track_departments() returns trigger
language plpgsql set search_path = '' as $$
begin
  if chat_private.norm(new.department) <> ''
     and not exists (select 1 from unnest(new.shared_departments) d
                     where chat_private.norm(d) = chat_private.norm(new.department)) then
    new.shared_departments := array_append(new.shared_departments, new.department);
  end if;
  return new;
end
$$;

drop trigger if exists chat_conversations_track_departments on public.chat_conversations;
create trigger chat_conversations_track_departments
  before insert or update of department, shared_departments on public.chat_conversations
  for each row execute function chat_private.track_departments();

-- Can the current user see a chat with this primary + shared departments?
create or replace function chat_private.can_see_chat(dep text, shared text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select chat_private.can_see_department(dep)
      or exists (select 1 from unnest(coalesce(shared, '{}'::text[])) d where chat_private.can_see_department(d))
$$;
grant execute on function chat_private.can_see_chat(text, text[]) to authenticated;

create or replace function chat_private.can_see_conversation(conv uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chat_conversations c
    where c.id = conv and chat_private.can_see_chat(c.department, c.shared_departments)
  )
$$;

drop policy if exists "view conversations of own departments" on public.chat_conversations;
create policy "view conversations of own departments" on public.chat_conversations
  for select to authenticated using (chat_private.can_see_chat(department, shared_departments));

drop policy if exists "update conversations of own departments" on public.chat_conversations;
create policy "update conversations of own departments" on public.chat_conversations
  for update to authenticated
  using (chat_private.can_see_chat(department, shared_departments))
  with check (chat_private.can_see_chat(department, shared_departments));

-- Backfill: every existing chat keeps its current department.
update public.chat_conversations set shared_departments = shared_departments where true;
