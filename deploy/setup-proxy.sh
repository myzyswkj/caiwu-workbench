#!/usr/bin/env bash
# ============================================================
# Supabase 香港反代一键部署（Caddy）
# 在香港腾讯云轻量服务器（Ubuntu/Debian）上以 root 执行
# 用法： bash setup-proxy.sh <你的反代域名>
# 例：   bash setup-proxy.sh supabase.example.top
# ============================================================
set -e
DOMAIN="${1:-}"
ORIGIN="uuvgvocusrpfakjejbnt.supabase.co"

if [ -z "$DOMAIN" ]; then
  echo "用法: bash setup-proxy.sh <你的反代域名>"
  echo "例:   bash setup-proxy.sh supabase.example.top"
  exit 1
fi
echo ">>> 反代域名: https://$DOMAIN"
echo ">>> 上游源站: https://$ORIGIN"
echo ""

# ---------- 1. 安装 Caddy ----------
if command -v caddy >/dev/null 2>&1; then
  echo ">>> Caddy 已安装，跳过安装"
else
  echo ">>> 安装 Caddy（官方源）..."
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---------- 2. 写入 Caddyfile ----------
echo ">>> 写入 /etc/caddy/Caddyfile ..."
cat > /etc/caddy/Caddyfile <<EOF
# 反代 Supabase：浏览器只连本机（国内可达），本机再转发到海外源站
$DOMAIN {
    encode gzip

    # 关键：反代 HTTPS 源站必须改 Host + 设 SNI，否则 Cloudflare 返回 404/522
    reverse_proxy https://$ORIGIN {
        header_up Host $ORIGIN
        transport http {
            tls
            tls_server_name $ORIGIN
        }
    }
}
EOF
echo ">>> Caddyfile 内容："
cat /etc/caddy/Caddyfile
echo ""

# ---------- 3. 系统防火墙（如启用 ufw）----------
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp 2>/dev/null || true
  ufw allow 443/tcp 2>/dev/null || true
fi

# ---------- 4. 启动 Caddy ----------
echo ">>> 启动 Caddy（首次会自动申请 Let's Encrypt 证书，需 80 端口可被外网访问）..."
systemctl enable caddy
systemctl restart caddy

echo ""
echo "=============================================="
echo "部署完成！请做以下确认："
echo "  1) 域名 $DOMAIN 的 A 记录已指向本机公网 IP"
echo "  2) 腾讯云控制台 -> 轻量应用服务器 -> 防火墙：放行 80 和 443"
echo "  3) 浏览器访问 https://$DOMAIN/ 应看到 Supabase 的 JSON"
echo "     （如 {\"message\":...} 或 404，只要不是 522/超时就说明通了）"
echo ""
echo "确认无误后，把域名 \"$DOMAIN\" 告诉我，我改前端 config.js 上线。"
echo "=============================================="
echo ""
echo "排错命令："
echo "  看 Caddy 日志:   journalctl -u caddy -f"
echo "  看 Caddy 状态:   systemctl status caddy"
echo "  重启 Caddy:      systemctl restart caddy"
