-- ============================================================
-- 财务工作台 · Supabase 云端同步表结构
-- 用途：每个用户一行，存整份应用快照（含照片凭证 base64）
-- 操作：在 Supabase 后台 → SQL Editor 里粘贴本文件 → Run
-- ============================================================

-- 快照表（与 auth.users 关联，用户删除时级联清理）
create table if not exists public.snapshots (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 索引（按更新时间排序用，可选）
create index if not exists snapshots_updated_at_idx on public.snapshots (updated_at desc);

-- 开启行级安全（RLS）：默认拒绝一切
alter table public.snapshots enable row level security;

-- 仅本人可读写自己的那一行
drop policy if exists "snapshots_owner_all" on public.snapshots;
create policy "snapshots_owner_all"
  on public.snapshots
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 说明：
-- 1) 应用里 upsert 的字段为 { user_id, data, updated_at }，与上面完全对应。
-- 2) 照片凭证以 base64 存在 data.photos 里，随快照一起同步，无需单独建存储桶。
-- 3) 免费版 Supabase 足够个人使用；如照片极多导致单行过大，可后续迁移到 Storage。
