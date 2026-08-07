-- ============================================================
-- 财务工作台 · 凭证图云同步 一次性设置（v4 纯 SQL 终极防呆版）
--
-- 为什么这次最稳？
--   - 第 1 步用纯 INSERT ... ON CONFLICT ... RETURNING
--     → Results 面板直接显示一行数据 (id, name, public)，肉眼可见
--     → 不会因 DO 块/EXCEPTION/RLS 静默失败而看不到
--     → 已被 RLS 拒绝的话 PG 会自动 ERROR，无需用户看 NOTICE
--   - 第 2 步用 DO 块 + 末尾 SELECT 验证策略真的在 pg_policies 里
--   - 加了 "诊断" query 让用户随时 SELECT 看到 buckets / policies 真实状态
--
-- 用法：Supabase 控制台 → SQL Editor → New query → 复制对应一段 → Run
--       （依次跑三段，每段独立查看 Results）
-- ============================================================


-- ============================================================
-- 【Step 1 / 3】建存储桶（vouchers，私有）
-- 结果：
--   - 如果桶不存在 → Results 显示 1 行数据 (vouchers, vouchers, false)
--   - 如果桶已存在 → Results 显示 1 行数据 (ON CONFLICT 兜底 update)
--   - 如果被 RLS 拒   → Results 显示红色 ERROR
-- ============================================================

insert into storage.buckets (id, name, public)
values ('vouchers', 'vouchers', false)
on conflict (id) do update
  set name = excluded.name,
      public = excluded.public
returning id, name, public, created_at;


-- ============================================================
-- 【Step 2 / 3】建权限策略（每个用户只能读写自己目录）
-- 这一段必须 Step 1 跑成功后才能跑
-- 结果：
--   - 如果策略已存在 → raise notice「【已存在】策略 ...」
--   - 如果策略不存在 → raise notice「【成功创建】策略 ...」
--   - DO 块末尾 + 外面那条 SELECT 会显示该策略的当前状态
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vouchers_auth_own_folder'
  ) then
    create policy "vouchers_auth_own_folder"
    on storage.objects
    for all
    to authenticated
    using ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
    with check ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text );
    raise notice '【成功创建】策略 vouchers_auth_own_folder';
  else
    raise notice '【已存在】策略 vouchers_auth_own_folder';
  end if;
end
$$;

-- 这一行独立验证策略是否真在（Results 会显示策略的完整定义）
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'vouchers_auth_own_folder';


-- ============================================================
-- 【Step 3 / 3】（仅诊断用，可选跑）看当前 buckets 实际状态
-- 期望 Results 显示一行：vouchers | vouchers | false
-- ============================================================

select id, name, public, created_at
from storage.buckets
order by created_at;
