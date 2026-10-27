-- 在 Supabase → SQL Editor → New query 中整段执行

create table if not exists public.novels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  author text not null default '',
  synopsis text not null default '',
  tags text[] not null default '{}',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
