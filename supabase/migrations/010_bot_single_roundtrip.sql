-- Speed: the chatbot helpers (chat-history, chat-ai-guard) used to run near n8n (Frankfurt) while the
-- database is in Mumbai, so every query was a long round trip. These functions do the secret check
-- and all the work in ONE call, so each helper needs a single database round trip.

create or replace function chat_private.bot_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from public.chat_settings where key = 'ingest_secret' and btrim(value) <> '' and btrim(value) = p_secret);
$$;
revoke all on function chat_private.bot_secret_ok(text) from public, anon, authenticated;

create or replace function public.chat_bot_history(p_secret text, p_phone text, p_limit integer default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c    record;
  lim  integer := least(greatest(coalesce(p_limit, 20), 4), 40);
  msgs text;
begin
  if not chat_private.bot_secret_ok(p_secret) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  select id, customer_name, department, inquiry_id into c
    from public.chat_conversations where customer_phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if c.id is null then
    return jsonb_build_object('ok', true, 'messages', 'No earlier conversation with this customer.');
  end if;
  select string_agg(line, E'\n' order by created_at, id) into msgs from (
    select m.created_at, m.id,
      btrim('[' || to_char(m.created_at at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI am') || '] '
        || case m.sender_type when 'customer' then 'Customer' when 'bot' then 'Ikris Bot (you)'
                              when 'system' then 'Inquiry form' else 'Ikris team' end
        || ':'
        || case when coalesce(m.attachment_name, '') <> '' or coalesce(m.attachment_type, '') <> ''
                then ' [sent a file: ' || coalesce(nullif(m.attachment_name, ''), m.attachment_type) || ']' else '' end
        || ' ' || left(btrim(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g')), 500)) as line
    from (select * from public.chat_messages where conversation_id = c.id order by created_at desc limit lim) m
  ) t;
  return jsonb_build_object('ok', true, 'customer_name', c.customer_name, 'department', c.department,
                            'inquiry_id', c.inquiry_id, 'messages', coalesce(msgs, 'No earlier messages.'));
end
$$;
revoke all on function public.chat_bot_history(text, text, integer) from public, anon, authenticated;
grant execute on function public.chat_bot_history(text, text, integer) to service_role;
