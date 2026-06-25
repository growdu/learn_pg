# PG Kernel Visualizer 手动部署指南

> 本文档描述在 Linux 服务器上手动部署 PG Kernel Visualizer 的步骤。

---

## 环境信息

| 组件 | 地址 | 说明 |
|------|------|------|
| Nginx | http://8.137.19.179 | 前端静态文件 + API 反向代理 |
| 后端 API | http://8.137.19.179:3000 | Go 后端服务 |
| PostgreSQL | 8.137.19.179:5432 | PostgreSQL 18.3 |
| WebSocket | ws://8.137.19.179/ws | 实时事件流 |

---

## 1. 安装依赖

```bash
# 安装 nginx
dnf install -y nginx

# 安装 PostgreSQL 18 编译依赖（如果需要从源码编译）
dnf install -y meson ninja gcc make perl
```

---

## 2. 部署后端

### 2.1 启动后端服务

```bash
# 进入后端目录
cd /root/learn_pg/backend

# 如果需要编译
# cd /root/learn_pg/postgres
# meson setup build --prefix=/usr/local/pgsql
# ninja -C build
# ninja -C build install

# 启动后端（默认监听 0.0.0.0:3000）
./pgv-server
```

### 2.2 验证后端

```bash
curl http://localhost:3000/health
# 输出: {"status":"ok","pg_connected":true}
```

---

## 3. 配置 PostgreSQL

### 3.1 修改 postgresql.conf

```bash
# 编辑配置文件
vim /var/lib/pgsql/data/postgresql.conf

# 设置监听所有 IP
listen_addresses = '*'
```

### 3.2 修改 pg_hba.conf（允许外部访问）

```bash
# 添加外部 IP 访问权限
echo "host all all 8.137.19.179/32 trust" >> /var/lib/pgsql/data/pg_hba.conf

# 重载配置
/usr/local/pgsql/bin/psql -h 127.0.0.1 -U postgres -c "SELECT pg_reload_conf();"
```

### 3.3 验证 PostgreSQL

```bash
curl -X POST http://localhost:3000/api/cluster/overview \
  -H "Content-Type: application/json" \
  -d '{"nodes":[{"id":"1","name":"test","host":"127.0.0.1","port":5432,"user":"postgres","password":"postgres","database":"postgres","cluster_type":"physical","role":"primary"}]}'
```

---

## 4. 部署前端

### 4.1 构建前端

```bash
cd /root/learn_pg/frontend
npm install
npm run build
```

### 4.2 部署到 nginx

```bash
# 创建目录
mkdir -p /var/www/html

# 复制构建产物
rm -rf /var/www/html/assets
cp -r dist/assets /var/www/html/
cp dist/index.html /var/www/html/
```

---

## 5. 配置 Nginx 反向代理

### 5.1 创建 nginx 配置

```bash
cat > /etc/nginx/nginx.conf << 'EOF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent"';

    access_log /var/log/nginx/access.log main;
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;

    server {
        listen 80;
        server_name _;

        location /api/ {
            proxy_pass http://127.0.0.1:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        location /health {
            proxy_pass http://127.0.0.1:3000;
            proxy_set_header Host $host;
        }

        location /ws {
            proxy_pass http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 86400;
        }

        location / {
            root /var/www/html;
            index index.html;
            try_files $uri $uri/ /index.html;
        }
    }
}
EOF
```

### 5.2 启动 nginx

```bash
# 测试配置
nginx -t

# 启动服务
systemctl enable nginx
systemctl start nginx

# 重启（如已运行）
systemctl restart nginx
```

---

## 6. 验证部署

### 6.1 检查服务状态

```bash
# 检查端口监听
ss -tlnp | grep -E ':80|:3000|:5432'

# 检查 nginx 状态
systemctl status nginx

# 检查后端健康
curl http://localhost/health
```

### 6.2 访问前端

浏览器打开: http://8.137.19.179

### 6.3 测试 API

```bash
curl http://localhost/health
# {"status":"ok","pg_connected":true}
```

---

## 7. 目录结构

```
/root/learn_pg/
├── backend/          # Go 后端源码
│   └── pgv-server   # 编译后的可执行文件
├── frontend/        # React 前端
│   ├── src/        # 前端源码
│   └── dist/       # 构建产物
├── postgres/       # PostgreSQL 18 源码（如需编译）
└── /var/www/html/  # 前端部署目录
```

---

## 8. 常用命令

### 8.1 后端管理

```bash
# 查看后端进程
ps aux | grep pgv-server

# 重启后端
pkill pgv-server
cd /root/learn_pg/backend && ./pgv-server &

# 查看后端日志
journalctl -u pgv-server -f
```

### 8.2 Nginx 管理

```bash
# 测试配置
nginx -t

# 重载配置
systemctl reload nginx

# 重启服务
systemctl restart nginx

# 查看错误日志
tail -f /var/log/nginx/error.log
```

### 8.3 前端更新

```bash
cd /root/learn_pg/frontend
npm run build

rm -rf /var/www/html/assets
cp -r dist/assets /var/www/html/
cp dist/index.html /var/www/html/

systemctl restart nginx
```

---

## 9. 防火墙配置（如需要）

```bash
# 开放端口
firewall-cmd --permanent --add-port=80/tcp
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload
```

---

## 10. 故障排查

### 10.1 白页问题

1. 检查浏览器控制台错误
2. 强制刷新: Ctrl+Shift+R
3. 检查 nginx 是否正确提供静态文件: `curl -sI http://localhost/assets/index-*.js`
4. 确认 MIME 类型正确（应返回 `application/javascript`）

### 10.2 API 500 错误

1. 检查 PostgreSQL 连接: `curl http://localhost/health`
2. 检查 pg_hba.conf 配置
3. 查看后端日志

### 10.3 WebSocket 连接失败

1. 确认 nginx 配置了 WebSocket 代理
2. 检查浏览器控制台 WebSocket 错误

---

*最后更新: 2026-05-09*
