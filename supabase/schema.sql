-- 在 Supabase → SQL Editor → New query 中整段执行
-- 若库已建过，也可只跑 supabase/migration_attachment.sql

create table if not exists public.novels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  author text not null default '',
  synopsis text not null default '',
  tags text[] not null default '{}',
  sort_order int not null default 0,
  attachment_path text,
  attachment_name text,
  attachment_mime text,
  attachment_size bigint,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 已有库补字段（可重复执行）
alter table public.novels add column if not exists attachment_path text;
alter table public.novels add column if not exists attachment_name text;
alter table public.novels add column if not exists attachment_mime text;
alter table public.novels add column if not exists attachment_size bigint;
alter table public.novels add column if not exists is_read boolean not null default false;

create index if not exists novels_user_sort on public.novels (user_id, sort_order);

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  custom_tags text[] not null default '{}',
  hidden_presets text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.novels enable row level security;
alter table public.user_prefs enable row level security;

drop policy if exists "novels_own" on public.novels;
create policy "novels_own" on public.novels
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "prefs_own" on public.user_prefs;
create policy "prefs_own" on public.user_prefs
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 附件存储桶（私有）；路径约定：{user_id}/{novel_id}/文件名
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
