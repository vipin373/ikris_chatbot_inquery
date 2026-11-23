-- =====================================================================
--  Campaign quick-reply buttons (called by the n8n chatbot via chat-ai-guard,
--  action "campaign_button"). Additive: existing guard actions are unchanged.
--
--  chat_campaign_button(secret, phone, context_wa_message_id, choice)
--    choice = 'stop'    → marks the contact Opted out (campaigns skip it)
--    choice = 'details' → nothing is changed
--  Returns { ok, template_name, name } where template_name is the template of
--  the campaign message the button belongs to (looked up by its wamid) and
--  name is the contact name without a leading "Dr".
-- =====================================================================
create or replace function public.chat_campaign_button(p_secret text, p_phone text, p_context_id text, p_choice text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph   text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  tpl  text;
  nm   text;
begin
  if not chat_private.bot_secret_ok(p_secret) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if length(ph) < 8 then
    return jsonb_build_object('ok', false, 'error', 'phone is required');
  end if;

  if coalesce(p_context_id, '') <> '' then
    select m.template_name into tpl from public.chat_messages m
     where m.wa_message_id = p_context_id order by m.created_at desc limit 1;
  end if;

  if p_choice = 'stop' then
    insert into public.contacts (phone, source, opted_out, notes)
    values (ph, 'whatsapp', true, 'Opted out via WhatsApp "Stop messages" button')
    on conflict (phone) do update set opted_out = true;
  end if;

  select nullif(btrim(regexp_replace(coalesce(c.name, ''), '^\s*(dr\.?\s*)+', '', 'i')), '')
    into nm from public.contacts c where c.phone = ph;

  return jsonb_build_object('ok', true, 'template_name', tpl, 'name', nm);
end
$$;
revoke all on function public.chat_campaign_button(text, text, text, text) from public, anon, authenticated;
grant execute on function public.chat_campaign_button(text, text, text, text) to service_role;
