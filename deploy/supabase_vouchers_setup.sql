-- ============================================================
-- 财务工作台 · 凭证图云同步 一次性设置（v5 纯 SQL 终极防呆版）
--
-- 用法：Supabase 控制台 → SQL Editor → New query（两次）
--   ① 跑【Step 1】建桶 → Results 显示一行 vouchers|vouchers|false → 成功
--   ② 跑【Step 2】建策略 → Results 显示一行策略定义 → 成功
--   ③ 回 App 硬刷新 → 点「立即同步」→ 凭证图同步开始
--
-- 不依赖 DO 块 / EXCEPTION / raise notice，全部用纯 SQL。
--   - 建桶：INSERT ... ON CONFLICT DO UPDATE ... RETURNING → 必显示数据行
--   - 建策略：DROP IF EXISTS + CREATE POLICY + 末尾 SELECT 验证 → 必显示策略行
--
-- ============================================================


-- ============================================================
-- 【Step 1 / 2】建私有存储桶 vouchers
-- 期望 Results 显示 1 行：id=vouchers, name=vouchers, public=false
-- ============================================================

insert into storage.buckets (id, name, public)
values ('vouchers', 'vouchers', false)
on conflict (id) do update
  set name = excluded.name,
      public = excluded.public
returning id, name, public, created_at;


-- ============================================================
-- 【Step 2 / 2】建策略（每个登录用户只能读写自己目录下的凭证图）
-- 期望 Results 显示 1 行：policyname=vouchers_auth_own_folder, cmd=ALL
-- ============================================================

drop policy if exists "vouchers_auth_own_folder" on storage.objects;

create policy "vouchers_auth_own_folder"
on storage.objects
for all
to authenticated
using ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
with check ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text );

select policyname, cmd, roles, schemaname, tablename
from pg_policies
where schemaname = 'storage'
  and tablename   = 'objects'
  and policyname  = 'vouchers_auth_own_folder';


-- ============================================================
-- 【验证用，可选】跑任一段，看真实状态
-- ============================================================

-- select id, name, public, created_at from storage.buckets order by created_at;
-- select policyname, cmd, roles from pg_policies
-- where schemaname='storage' and tablename='objects' order by policyname;
