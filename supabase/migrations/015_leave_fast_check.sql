-- =====================================================================
--  Fast pre-check for the chatbot (n8n calls it via PostgREST, ~0.1 s, no cold start).
--  Decides whether an incoming WhatsApp webhook could belong to the leave system:
--    • Approve/Reject/Confirm button payloads (LV|… / LVC|…)
--    • the sender has an open leave conversation (session)
--    • a text message mentioning leave / chutti
--  Everything else → route = false → the normal chatbot runs immediately (customers see no delay).
--  Also records delivery receipts of leave notifications.
-- =====================================================================
create or replace function public.leave_check(p_secret text, p_body jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v       jsonb := p_body #> '{entry,0,changes,0,value}';
  m       jsonb := v #> '{messages,0}';
  st      jsonb;
  nxt     text;
  v_phone text;
  payload text;
  txt     text;
begin
  if not chat_private.bot_secret_ok(p_secret) then return jsonb_build_object('route', false, 'error', 'unauthorized'); end if;

  for st in select * from jsonb_array_elements(coalesce(v -> 'statuses', '[]'::jsonb)) loop
    nxt := case st->>'status' when 'sent' then 'sent' when 'delivered' then 'delivered' when 'read' then 'read' when 'failed' then 'failed' end;
    if nxt is not null and coalesce(st->>'id', '') <> '' then
      update public.leave_notifications n
         set status = nxt,
             error = case when nxt = 'failed' then left(coalesce(st #>> '{errors,0,title}', st #>> '{errors,0,message}', 'Failed'), 300) else n.error end
       where n.wa_message_id = st->>'id'
         and (nxt = 'failed' or array_position(array['pending','sent','delivered','read'], nxt) > coalesce(array_position(array['pending','sent','delivered','read'], n.status), 0));
    end if;
  end loop;

  if m is null then return jsonb_build_object('route', false); end if;
  v_phone := regexp_replace(coalesce(m->>'from', v #>> '{contacts,0,wa_id}', ''), '\D', '', 'g');
  payload := coalesce(m #>> '{button,payload}', m #>> '{interactive,button_reply,id}', '');
  if payload ~ '^LVC?\|' then return jsonb_build_object('route', true); end if;
  if exists (select 1 from public.leave_sessions s where s.phone = v_phone and s.updated_at > now() - interval '2 hours') then
    return jsonb_build_object('route', true);
  end if;
  txt := coalesce(m #>> '{text,body}', '');
  if m->>'type' = 'text' and (txt ~* '\m(leave|chh?utt?i)\M' or txt like '%छुट्टी%') then
    return jsonb_build_object('route', true);
  end if;
  return jsonb_build_object('route', false);
end
$$;
revoke all on function public.leave_check(text, jsonb) from public;
grant execute on function public.leave_check(text, jsonb) to anon, service_role;   -- protected by the shared secret
