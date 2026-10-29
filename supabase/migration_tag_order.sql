-- 标签自定义顺序（可重复执行）
alter table public.user_prefs
  add column if not exists tag_order text[] not null default '{}';
