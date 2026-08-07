-- ============================================================
-- 财务工作台 · 凭证图云同步 一次性设置（防事务回滚版本）
-- 用法：Supabase 控制台（https://supabase.com/dashboard）
--   → 选项目（myzyswkj）→ 左侧「SQL Editor」→ New query
--   → 把本文件全部内容粘进去 → 点「Run」→ 完成
-- 只需执行一次。之后点 App 里的「立即同步」，凭证图就会自动上传/下载。
--
-- ⚠️ 重要：上一版用纯 INSERT + CREATE POLICY 分两条 statement，
-- PG 默认一个事务，第二条报错（如 policy 已存在 42710）会触发整事务回滚，
-- 导致第 1 条的「建桶」也被撤掉，结果桶从未真正建好，list 报 400 Bucket not found。
-- 本版用 PL/pgSQL DO 块 + EXCEPTION，把两条独立写入，第 2 步已存在时不抛错。
-- ============================================================

-- 第 1 步：创建私有存储桶 vouchers（存凭证图；私有=外网拿不到，安全）
do $$
begin
  begin
    insert into storage.buckets (id, name, public)
    values ('vouchers', 'vouchers', false);
  exception when unique_violation then
    -- 桶已存在，忽略
    raise notice '存储桶 vouchers 已存在，跳过创建';
  end;
end
$$;

-- 第 2 步：放行权限——每个登录用户只能读写「自己账号目录」下的凭证图
-- （凭证图按 用户ID/图片ID 存放，这条策略保证你的图只有你能访问）
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vouchers_auth_own_folder'
  ) then
    execute $sql$
      create policy "vouchers_auth_own_folder"
      on storage.objects
      for all
      to authenticated
      using ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
      with check ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
    $sql$;
  else
    raise notice '策略 vouchers_auth_own_folder 已存在，跳过创建';
  end if;
end
$$;