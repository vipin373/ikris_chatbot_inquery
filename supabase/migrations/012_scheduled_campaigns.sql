-- Scheduled WhatsApp campaigns: a campaign can be created now and sent automatically later.
--   status 'scheduled' → waiting for scheduled_at;  'cancelled' → cancelled before it was sent.
--   Every minute pg_cron asks the wa-campaigns edge function to start the campaigns that are due
--   (it only calls the function when something is due). The edge function claims each campaign
--   atomically (status scheduled → sending), so a campaign can never be sent twice.

alter table public.campaigns add column if not exists scheduled_at timestamptz;
alter table public.campaigns add column if not exists started_at   timestamptz;
alter table public.campaigns add column if not exists error        text;
alter table public.campaigns add column if not exists cancelled_at timestamptz;
alter table public.campaigns add column if not exists cancelled_by text;

alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check
  check (status in ('scheduled', 'sending', 'completed', 'failed', 'cancelled'));

create index if not exists campaigns_due_idx on public.campaigns (scheduled_at) where status = 'scheduled';

-- Google Sheet values (customer name, assigned person, medicine…) are read when the campaign is
-- scheduled, with the scheduler's own access, and kept per recipient for the send.
alter table public.campaign_recipients add column if not exists sheet_row jsonb;

create or replace function public.campaign_kick_scheduled() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.campaigns where status = 'scheduled' and scheduled_at <= now()) then
    perform net.http_post(
      url := 'https://mdyniigwwhupdnxwtnvo.supabase.co/functions/v1/wa-campaigns',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-ikris-secret', (select value from public.chat_settings where key = 'ingest_secret')),
      body := '{"action":"run_scheduled"}'::jsonb,
      timeout_milliseconds := 60000);
  end if;
end $$;
revoke all on function public.campaign_kick_scheduled() from public, anon, authenticated;

select cron.schedule('ikris-scheduled-campaigns', '* * * * *', 'select public.campaign_kick_scheduled()');
