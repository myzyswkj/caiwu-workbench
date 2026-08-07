-- ============================================================
-- 财务工作台 · 凭证图云同步 一次性设置
-- 用法：Supabase 控制台（https://supabase.com/dashboard）
--   → 选项目（myzyswkj）→ 左侧「SQL Editor」→ New query
--   → 把本文件全部内容粘进去 → 点「Run」→ 完成
-- 只需执行一次。之后点 App 里的「立即同步」，凭证图就会自动上传/下载。
-- ============================================================

-- 第 1 步：创建私有存储桶 vouchers（存凭证图；私有=外网拿不到，安全）
insert into storage.buckets (id, name, public)
values ('vouchers', 'vouchers', false)
on conflict (id) do nothing;

-- 第 2 步：放行权限——每个登录用户只能读写「自己账号目录」下的凭证图
-- （凭证图按 用户ID/图片ID 存放，这条策略保证你的图只有你能访问）
create policy "vouchers_auth_own_folder"
on storage.objects
for all
to authenticated
using ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text )
with check ( bucket_id = 'vouchers' and (storage.foldername(name))[1] = auth.uid()::text );

-- 如果上面第 2 步提示 policy 已存在（duplicate key / already exists），
-- 说明已经建过了，忽略即可，不影响使用。
