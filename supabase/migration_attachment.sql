-- 已有项目：在 SQL Editor 执行本文件即可补上「附件」能力

alter table public.novels add column if not exists attachment_path text;
alter table public.novels add column if not exists attachment_name text;
alter table public.novels add column if not exists attachment_mime text;
alter table public.novels add column if not exists attachment_size bigint;

insert into storage.buckets (id, name, public)
values ('novel-attachments', 'novel-attachments', false)
on conflict (id) do nothing;

drop policy if exists "novel_attachments_own" on storage.objects;
create policy "novel_attachments_own" on storage.objects
  for all
  using (
    bucket_id = 'novel-attachments'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'novel-attachments'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
