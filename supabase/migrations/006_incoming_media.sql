-- =====================================================================
--  IKRIS — keep files customers send on WhatsApp (images, PDFs, voice, video)
--  The WhatsApp media id is stored with the message; the file is downloaded
--  through n8n and saved in the private chat-attachments bucket under
--  <conversation_id>/in-<message_id>-<file name>.
-- =====================================================================
alter table public.chat_messages add column if not exists wa_media_id text;

-- WhatsApp documents can be up to 100 MB.
update storage.buckets set file_size_limit = 104857600 where id = 'chat-attachments';

insert into public.chat_settings (key, value)
values ('wa_media_get_url', 'https://ikris.app.n8n.cloud/webhook/ikris-wa-media-get')
on conflict (key) do update set value = excluded.value;
