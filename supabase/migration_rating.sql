-- 评分（0–5，0=未评）与文字评价（可重复执行）
alter table public.novels
  add column if not exists rating smallint not null default 0;

alter table public.novels
  add column if not exists review text not null default '';

-- 约束：0–5
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'novels_rating_range'
  ) then
    alter table public.novels
      add constraint novels_rating_range check (rating >= 0 and rating <= 5);
  end if;
end $$;
