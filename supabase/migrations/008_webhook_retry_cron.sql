-- Retries callback deliveries every minute (only calls the edge function when something is due).
create extension if not exists pg_cron;

create or replace function public.integ_kick_dispatch() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.webhook_deliveries where status = 'pending' and next_attempt_at <= now()) then
    perform net.http_post(
      url := 'https://mdyniigwwhupdnxwtnvo.supabase.co/functions/v1/integrations',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-ikris-secret', (select value from public.chat_settings where key = 'ingest_secret')),
      body := '{"action":"dispatch"}'::jsonb,
      timeout_milliseconds := 60000);
  end if;
end $$;
revoke all on function public.integ_kick_dispatch() from public, anon, authenticated;

select cron.schedule('ikris-webhook-retries', '* * * * *', 'select public.integ_kick_dispatch()');
