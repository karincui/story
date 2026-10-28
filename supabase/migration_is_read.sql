-- 已读 / 未读标记（可重复执行）
alter table public.novels
  add column if not exists is_read boolean not null default false;

create index if not exists novels_user_is_read on public.novels (user_id, is_read);
