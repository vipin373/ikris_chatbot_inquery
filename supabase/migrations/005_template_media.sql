-- =====================================================================
--  IKRIS — media headers (image / video / document) for WhatsApp templates
-- =====================================================================
-- Public bucket for WhatsApp template media (Meta must be able to download it).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wa-media', 'wa-media', true, 104857600,
        array['image/jpeg','image/png','video/mp4','video/3gpp','application/pdf'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "staff upload wa media" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wa-media' and (select chat_private.is_staff())
              and (storage.foldername(name))[1] in ('templates', 'campaigns'));

create policy "staff read wa media" on storage.objects
  for select to authenticated
  using (bucket_id = 'wa-media' and (select chat_private.is_staff()));

-- Media header link stored with the template (re-used when sending).
alter table public.wa_templates add column if not exists header_media_url text;
alter table public.wa_templates add column if not exists header_media_name text;
