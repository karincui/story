-- 「很想看」标记（可重复执行）
alter table public.novels
  add column if not exists want_to_read boolean not null default false;

create index if not exists novels_user_want on public.novels (user_id, want_to_read);
