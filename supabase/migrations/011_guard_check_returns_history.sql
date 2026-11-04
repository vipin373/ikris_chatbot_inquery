-- Speed: the bot's "check" call also returns the chat history, so n8n needs one call (not two) before the AI.
create or replace function public.chat_ai_guard(p_secret text, p_action text, p_phone text, p_wa_message_id text, p_epoch integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g jsonb;
begin
  if not chat_private.bot_secret_ok(p_secret) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_action = 'check' then
    g := public.chat_ai_gate(p_phone, left(coalesce(p_wa_message_id, ''), 200));
    if coalesce((g->>'allowed')::boolean, false) then
      g := g || jsonb_build_object('chat_history',
             coalesce(public.chat_bot_history(p_secret, p_phone, 20)->>'messages', ''));
    end if;
    return jsonb_build_object('ok', true) || g;
  elsif p_action = 'claim_send' then
    return jsonb_build_object('ok', true) || public.chat_ai_claim_send(p_phone, coalesce(p_epoch, -1));
  end if;
  return jsonb_build_object('ok', false, 'error', 'action must be check or claim_send');
end
$$;
revoke all on function public.chat_ai_guard(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.chat_ai_guard(text, text, text, text, integer) to service_role;
