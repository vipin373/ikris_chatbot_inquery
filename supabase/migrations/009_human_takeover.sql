-- =====================================================================
--  009 — Human agent takeover & AI chatbot auto-pause
--
--  conversation_status (separate from the inbox "status" open/pending/
--  resolved/closed, which staff already use for their own workflow):
--    AI_ACTIVE       the chatbot may reply
--    HUMAN_HANDOVER  an employee is handling the chat — the bot never replies
--    CLOSED          completed — the bot does not restart on its own
--
--  ai_epoch is bumped every time the AI is paused. The bot reads it before
--  it starts thinking and must present the same value when it claims the
--  right to send; a reply prepared before a takeover is therefore refused.
--  Both the takeover and the claim are single-row UPDATEs, so Postgres row
--  locking serialises them — a human and the AI can never both "win".
-- =====================================================================

alter table public.chat_conversations
  add column if not exists conversation_status text not null default 'AI_ACTIVE'
    check (conversation_status in ('AI_ACTIVE', 'HUMAN_HANDOVER', 'CLOSED')),
  add column if not exists assigned_agent_id   text,          -- chat_staff.email of the handling employee
  add column if not exists assigned_agent_name text,
  add column if not exists ai_paused_at        timestamptz,
  add column if not exists ai_resumed_at       timestamptz,
  add column if not exists last_human_reply_at timestamptz,
  add column if not exists ai_epoch            integer not null default 0,
  add column if not exists ai_last_reply_at    timestamptz;

create index if not exists chat_conversations_ai_status_idx
  on public.chat_conversations (conversation_status) where conversation_status <> 'AI_ACTIVE';

-- Audit trail of every takeover / resume / close and every AI reply the guard blocked.
create table if not exists public.chat_ai_events (
  id              bigserial primary key,
  conversation_id uuid references public.chat_conversations (id) on delete cascade,
  event           text not null,   -- human_reply, take_over, resume_ai, close, ai_blocked_before, ai_blocked_send, duplicate
  actor_email     text,
  actor_name      text,
  detail          text,
  created_at      timestamptz not null default now()
);
create index if not exists chat_ai_events_conv_idx on public.chat_ai_events (conversation_id, created_at desc);
alter table public.chat_ai_events enable row level security;
create policy "view ai events of visible conversations" on public.chat_ai_events
  for select to authenticated using (chat_private.can_see_conversation(conversation_id));
revoke all on public.chat_ai_events from anon;
revoke insert, update, delete, truncate on public.chat_ai_events from authenticated;

-- One AI run per incoming WhatsApp message (Meta re-delivers webhooks; two runs = duplicate replies).
create table if not exists public.chat_ai_claims (
  wa_message_id text primary key,
  created_at    timestamptz not null default now()
);
alter table public.chat_ai_claims enable row level security;   -- no policies: service role only
revoke all on public.chat_ai_claims from anon, authenticated;

-- ---------------------------------------------------------------------
--  Core: an employee takes the chat (reply or Take Over button).
--  p_force = true  → Take Over button: always assign to this employee.
--  p_force = false → a reply: keep an existing human assignment, otherwise assign to the replier.
-- ---------------------------------------------------------------------
create or replace function chat_private.ai_take_over(p_conv uuid, p_email text, p_name text, p_force boolean, p_event text)
returns public.chat_conversations
language plpgsql security definer set search_path = '' as $$
declare
  r public.chat_conversations;
begin
  update public.chat_conversations c set
    conversation_status = 'HUMAN_HANDOVER',
    ai_epoch            = c.ai_epoch + 1,
    ai_paused_at        = case when c.conversation_status = 'HUMAN_HANDOVER' then coalesce(c.ai_paused_at, now()) else now() end,
    assigned_agent_id   = case when p_force or c.conversation_status <> 'HUMAN_HANDOVER' or c.assigned_agent_id is null
                               then p_email else c.assigned_agent_id end,
    assigned_agent_name = case when p_force or c.conversation_status <> 'HUMAN_HANDOVER' or c.assigned_agent_id is null
                               then p_name else c.assigned_agent_name end,
    assigned_to         = case when p_force or c.conversation_status <> 'HUMAN_HANDOVER' or c.assigned_agent_id is null
                               then coalesce(p_name, c.assigned_to) else c.assigned_to end,
    last_human_reply_at = case when p_event = 'human_reply' then now() else c.last_human_reply_at end
  where c.id = p_conv
  returning * into r;
  if r.id is null then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  insert into public.chat_ai_events (conversation_id, event, actor_email, actor_name)
  values (p_conv, p_event, p_email, p_name);
  return r;
end
$$;
revoke all on function chat_private.ai_take_over(uuid, text, text, boolean, text) from public, anon, authenticated;

-- Called by chat-send (service role) just BEFORE a staff message goes to WhatsApp.
create or replace function public.chat_ai_human_reply(p_conv uuid, p_email text, p_name text)
returns public.chat_conversations
language sql security definer set search_path = '' as $$
  select chat_private.ai_take_over(p_conv, lower(p_email), p_name, false, 'human_reply');
$$;
revoke all on function public.chat_ai_human_reply(uuid, text, text) from public, anon, authenticated;
grant execute on function public.chat_ai_human_reply(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
--  Dashboard buttons: Take Over / Resume AI / Close Conversation.
--  Any signed-in employee who can see the conversation may use them.
-- ---------------------------------------------------------------------
create or replace function public.chat_ai_control(p_conv uuid, p_action text)
returns public.chat_conversations
language plpgsql security definer set search_path = '' as $$
declare
  me    text := chat_private.my_email();
  nm    text;
  r     public.chat_conversations;
begin
  if me is null or not chat_private.can_see_conversation(p_conv) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(s.display_name, me) into nm from public.chat_staff s where s.email = me;

  if p_action = 'take_over' then
    return chat_private.ai_take_over(p_conv, me, nm, true, 'take_over');

  elsif p_action = 'resume_ai' then
    update public.chat_conversations c set
      conversation_status = 'AI_ACTIVE',
      ai_resumed_at       = now(),
      status              = case when c.status in ('resolved', 'closed') then 'open' else c.status end
    where c.id = p_conv returning * into r;

  elsif p_action = 'close' then
    update public.chat_conversations c set
      conversation_status = 'CLOSED',
      ai_epoch            = c.ai_epoch + 1,
      ai_paused_at        = case when c.conversation_status = 'AI_ACTIVE' then now() else c.ai_paused_at end,
      status              = 'closed'
    where c.id = p_conv returning * into r;

  else
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;

  insert into public.chat_ai_events (conversation_id, event, actor_email, actor_name)
  values (p_conv, case p_action when 'resume_ai' then 'resume_ai' else 'close' end, me, nm);
  return r;
end
$$;
revoke all on function public.chat_ai_control(uuid, text) from public, anon;
grant execute on function public.chat_ai_control(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
--  Bot guard, step 1 — before the AI starts on an incoming message.
--  Returns { allowed, reason, epoch }.
-- ---------------------------------------------------------------------
create or replace function public.chat_ai_gate(p_phone text, p_wa_message_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  c   public.chat_conversations;
  n   integer;
begin
  select * into c from public.chat_conversations where customer_phone = ph;

  if c.id is not null and c.conversation_status <> 'AI_ACTIVE' then
    insert into public.chat_ai_events (conversation_id, event, detail)
    values (c.id, 'ai_blocked_before', c.conversation_status || coalesce(' / ' || c.assigned_agent_name, ''));
    return jsonb_build_object('allowed', false, 'reason', c.conversation_status, 'epoch', c.ai_epoch,
                              'agent', c.assigned_agent_name);
  end if;

  if coalesce(p_wa_message_id, '') <> '' then
    insert into public.chat_ai_claims (wa_message_id) values (p_wa_message_id) on conflict do nothing;
    get diagnostics n = row_count;
    if n = 0 then
      if c.id is not null then
        insert into public.chat_ai_events (conversation_id, event, detail) values (c.id, 'duplicate', p_wa_message_id);
      end if;
      return jsonb_build_object('allowed', false, 'reason', 'DUPLICATE', 'epoch', coalesce(c.ai_epoch, 0));
    end if;
    delete from public.chat_ai_claims where created_at < now() - interval '14 days';
  end if;

  return jsonb_build_object('allowed', true, 'reason', 'AI_ACTIVE', 'epoch', coalesce(c.ai_epoch, 0));
end
$$;
revoke all on function public.chat_ai_gate(text, text) from public, anon, authenticated;
grant execute on function public.chat_ai_gate(text, text) to service_role;

-- ---------------------------------------------------------------------
--  Bot guard, step 2 — immediately before the AI reply goes to WhatsApp.
--  Atomic: succeeds only if the chat is still AI_ACTIVE and nobody took it
--  over since step 1 (same epoch). A chat that does not exist yet cannot
--  have been taken over, so it is allowed.
-- ---------------------------------------------------------------------
create or replace function public.chat_ai_claim_send(p_phone text, p_epoch integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  cid uuid;
  c   public.chat_conversations;
begin
  update public.chat_conversations set ai_last_reply_at = now()
   where customer_phone = ph and conversation_status = 'AI_ACTIVE' and ai_epoch = coalesce(p_epoch, 0)
  returning id into cid;
  if cid is not null then
    return jsonb_build_object('allowed', true);
  end if;

  select * into c from public.chat_conversations where customer_phone = ph;
  if c.id is null then
    return jsonb_build_object('allowed', true, 'reason', 'NEW_CHAT');
  end if;
  insert into public.chat_ai_events (conversation_id, event, detail)
  values (c.id, 'ai_blocked_send', c.conversation_status || ' (epoch ' || coalesce(p_epoch, 0) || ' -> ' || c.ai_epoch || ')');
  return jsonb_build_object('allowed', false, 'reason', c.conversation_status, 'agent', c.assigned_agent_name);
end
$$;
revoke all on function public.chat_ai_claim_send(text, integer) from public, anon, authenticated;
grant execute on function public.chat_ai_claim_send(text, integer) to service_role;
