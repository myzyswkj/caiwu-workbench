-- ============================================================
-- 财务工作台 · 凭证图云同步 一次性设置（最强防呆版 v3）
--
-- 用法：Supabase 控制台（https://supabase.com/dashboard）
--   → 选项目（myzyswkj）→ 左侧「SQL Editor」
--   → Step 1 单独 New query 跑第 1 步 → 确认消息面板出现 NOTICE
--   → Step 2 单独 New query 跑第 2 步 → 确认消息面板出现 NOTICE
--   → 跑完后回 App 点同步即可
--
-- 历史踩坑（避免重复）：
--   1. 裸 INSERT + 裸 CREATE POLICY 共享事务：policy 已存在 42710
--      → 整事务回滚 → 桶从未创建。
--   2. 上一版 PL/pgSQL DO 块 + EXCEPTION 写法遇 0 行 INSERT（被 RLS
--      静默拒绝）时不会报错，用户看到 Success 但其实啥也没建。
--
-- 本版特性：
--   - 第 1 步用 RETURNING + raise notice 强制打印「建了什么」或「被 RLS 拦了」
--   - 第 2 步用 pg_policies 预检 + raise notice 强制打印结果
--   - 两段 SQL 完全独立，**请在 SQL Editor 分两次跑**，每跑一次都看 Messages 标签
-- ============================================================


-- ============================================================
-- 【Step 1 / 2】仅建桶
-- 复制 ↓↓↓ 这一段到 SQL Editor 跑（不要包含 Step 2）
-- ============================================================
do $$
declare
  v_id text;
  v_public boolean;
begin
  -- 如果已存在就跳过（不抛错），并输出当前桶状态
  select id, public into v_id, v_public
  from storage.buckets
  where id = 'vouchers';

  if v_id is not null then
    raise notice '【已存在】桶 id=%, public=%（无需创建）', v_id, v_public;
    return;
  end if;

  -- 第一次建：用 RETURNING 抓新建桶的字段，如果被 RLS 拒，INSERT 会返 0 行而不会抛错，
  -- 此时我们将显式抛出错误让用户看见
  insert into storage.buckets (id, name, public)
  values ('vouchers', 'vouchers', false)
  returning id, public into v_id, v_public;

  if v_id is null then
    raise exception '【失败】INSERT 0 行（疑似被 RLS 拦截）。请确认你在项目 owner 账号下执行，且该项目未被暂停';
  end if;

  raise notice '【成功创建】桶 id=%, public=%（私有）', v_id, v_public;
exception
  when unique_violation then
    raise notice '【已存在】发生 unique_violation，跳过';
  when others then
    raise exception '【失败】%', SQLERRM;
end
$$;


-- ============================================================
-- 【Step 2 / 2】建权限策略（依赖 Step 1 成功后再跑）
-- 在另一个 New query 里单独跑这一段 ↓↓↓
-- ============================================================
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vouchers_auth_own_folder'
  ) then
    raise notice '【已存在】策略 vouchers_auth_own_folder（无需创建）';
    return;
  end if;

  execute $sql$
    create policy "vouchers_auth_own_folder"
    on storage.objects
    for all
    to authenticated
    using ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
    with check ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
  $sql$;

  raise notice '【成功创建】策略 vouchers_auth_own_folder';
exception
  when others then
    raise exception '【失败】%', SQLERRM;
end
$$;


-- ============================================================
-- 【验证】可选：跑这一段确认 buckets 表里到底有什么
-- ============================================================
-- select id, name, public, created_at
-- from storage.buckets
-- order by created_at;
