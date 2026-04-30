# FAQ / 常见问题

## Q: 浏览器访问前端返回 502，或 Docker 容器内 nginx 无法连接 backend

### 场景一：Docker nginx upstream 指向 localhost 导致 502

**症状**：通过浏览器访问 `http://<host>/api/connect` 返回 502 Bad Gateway；但从宿主机 `curl http://localhost:<port>/api/connect` 正常。

**根因**：nginx 运行在 Docker 容器内，`upstream` 配置错误：
```nginx
# 错误配置
upstream backend {
    server 127.0.0.1:3010;   # 容器内的 127.0.0.1 是容器自己，不是 backend！
}
```
容器内 `127.0.0.1` 指向容器自己，而不是 backend 容器或宿主机上的端口，所以 nginx 永远拿不到 upstream 连接。

**解决方法**：使用 Docker 内部 DNS 解析 backend 服务名：
```nginx
upstream backend {
    server backend:3000;   # Docker 网络中通过 DNS 解析为 backend 容器的内部 IP
    keepalive 16;
}
```
容器之间通过服务名互相访问，必须在同一 Docker 网络中。

**涉及文件**：`frontend/nginx.conf`

---

### 场景二：主机上的 nginx 与 Docker 端口冲突

**症状**：Docker Compose 正确映射了 `80:80`，但浏览器仍然 502 或访问到错误的内容（主机 nginx 默认页）。

**根因**：主机上已运行了 nginx（或其他服务）占用了 80 端口。`docker ps` 显示 Docker 容器端口映射正常，但实际监听 80 的是主机 nginx，不是容器内的 nginx：
```
$ ss -tlnp | grep :80
nginx  worker: 0.0.0.0:80   # ← 主机 nginx，不是 Docker 容器
docker-proxy  127.0.0.1:3010  # ← Docker 映射在其他端口
```
浏览器实际访问的是主机 nginx，它没有 `/api/` 的反向代理配置，因此 502。

**诊断方法**：
```bash
# 检查 80 端口被谁占用
ss -tlnp | grep :80

# 检查 Docker 容器的实际端口映射
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

**解决方法**（三选一）：

1. **停止主机 nginx**（推荐）：
   ```bash
   sudo systemctl stop nginx   # 或 nginx.service
   # 或禁用并停止
   sudo systemctl disable --now nginx
   ```

2. **修改 Docker 映射到其他端口**，绕过冲突：
   ```yaml
   # docker-compose.yml
   frontend:
     ports:
       - "8080:80"   # 映射到 8080，访问 http://host:8080
   ```

3. **修改主机 nginx 配置**，将 Docker 前端的请求反向代理出去：
   在主机 nginx 的 `server {}` 块中添加：
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:<映射端口>;
       proxy_set_header Host $host;
   }
   ```

**涉及文件**：`frontend/nginx.conf`、`docker-compose.yml`（端口映射）

---

## Q: eBPF probe 无法挂载，报 "failed to open elf: not a valid BPF object file" 或 "failed to load: argument list too long"

**根因**：常见两类问题：
1. `probe.bpf.o` 由其他架构（如本地 macOS）编译，无法在 Linux 上使用
2. clang 编译参数不对，缺少 BTF info 或使用了过大的栈帧

**解决方法**：

```bash
# 清理旧对象文件，重新编译
cd collector/probes
rm -f probe.bpf.o
docker exec pgv-collector bash -c 'cd /collector/probes && clang-18 -O2 -target bpf -c probe.bpf.c -o probe.bpf.o'

# 验证目标架构
docker exec pgv-collector readelf -a /collector/probes/probe.bpf.o | grep Machine
# 应输出: Machine: <none>  或 EM_BPF
```

**涉及文件**：`collector/probes/probe.bpf.c`

---

## Q: Rust collector 连接 backend WebSocket 失败

**症状**：`failed to connect to backend WebSocket: ... connection refused`

**根因**：`BACKEND_WS_URL` 环境变量配置错误：
- `docker-compose.yml` 中设置了错误的 IP（`127.0.0.1`），容器内 `127.0.0.1` 指向容器自身而非宿主机
- `docker-compose.dev.yml` 中 URL 配置了 Docker 服务名而非宿主机可访问的地址

**解决方法**：
- 开发环境（Linux host，直接运行 Rust）：使用 `ws://127.0.0.1:3000/ws`
- Docker Compose 环境：使用 `ws://host.docker.internal:3000/ws`（需要 `extra_hosts: host-gateway`）
- 容器间通信：使用 Docker 服务名 `ws://pgv-backend:3000/ws`

**涉及文件**：
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `collector/src/main.rs`

---

## Q: BPF probe 的符号（symbol）无法解析

**症状**：`failed to resolve symbol: ...` 或 probe 没有收到任何事件

**根因**：PostgreSQL 编译时禁用了符号表，或使用的 PostgreSQL 版本与编译 eBPF 时引用的符号不匹配。

**解决方法**：

```bash
# 查找 PostgreSQL 中的目标函数符号
nm /usr/lib/postgresql/18/lib/postgresql 2>/dev/null | grep -E 'heap_insert|bmgr|LockAcquire'
# 或查看已加载的探针符号
sudo bpftool map dump name events 2>/dev/null | head
```

确保 eBPF probe 中使用的符号名（函数名）与目标 PostgreSQL 二进制版本完全一致。不同 PG 版本函数名可能有差异。

**涉及文件**：`collector/probes/probe.bpf.c`

---

## Q: 前端 WebSocket 连接失败

**症状**：浏览器控制台报 `WebSocket connection to 'ws://.../ws' failed`

**根因**：nginx 未配置 WebSocket 升级，或后端服务未运行。

**解决方法**：确保 `frontend/nginx.conf` 包含 WebSocket 升级配置：

```nginx
location /ws {
    proxy_pass http://pgv-backend:3000/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

同时确认 backend 在端口 3000 正常运行。

**涉及文件**：`frontend/nginx.conf`

---

## Q: /api/clog 返回 `startXid=4294967295`（即 `uint32(-1)`），没有任何事务数据

**症状**：`curl http://host/api/clog` 返回的 `startXid` 和 `endXid` 都是 `4294967295`，`transactions` 为空数组，并提示 "No CLOG/pg_xact transactions were read for the requested range"。

**根因（双重失效）**：

1. `resolveXidRange()` 中 `parseIntQuery` 的默认值是 `-1`：
   ```go
   startXid := uint32(parseIntQuery(r, "start_xid", -1))  // uint32(-1) = 4294967295
   endXid   := uint32(parseIntQuery(r, "end_xid", -1))
   if startXid > 0 && endXid >= startXid {  // 4294967295 > 0 → true!
       return startXid, endXid  // 直接返回了错误的 4294967295
   }
   ```
   `uint32(-1)` 等于 `4294967295`，命中第一个 `if` 分支直接返回，根本没走 pgClient 和 fallback。

2. 即使走到 fallback，Volume 挂载路径也可能不对：
   - compose 挂载 `pg_data:/var/lib/postgresql:ro`
   - backend 环境变量 `PG_DATA_DIR=/var/lib/postgresql`（修改后）
   - 但实际 pg_xact 在 `/var/lib/postgresql/data/pg_xact/` 下

**解决方法**：

1. 修改 `parseIntQuery` 默认值，避免有符号整数转 uint32 溢出：
   ```go
   // handler.go resolveXidRange()
   startXid := uint32(parseIntQuery(r, "start_xid", 0))
   endXid   := uint32(parseIntQuery(r, "end_xid", 0))
   ```

2. fallback 增加双路径候选，同时探测 `PG_DATA_DIR` 和 `PG_DATA_DIR/data`：
   ```go
   candidates := []string{h.pgDataDir(), filepath.Join(h.pgDataDir(), "data")}
   for _, dataDir := range candidates {
       pgXactDir := filepath.Join(dataDir, "pg_xact")
       // ...
   }
   ```

3. 重新构建并部署：
   ```bash
   cd backend && docker build --no-cache -t learn_pg-backend:latest .
   docker compose up -d --force-recreate backend
   ```

**涉及文件**：
- `backend/internal/api/handler.go`（`resolveXidRange`、`pgDataDir`）
- `docker-compose.yml`（`PG_DATA_DIR` 环境变量）
- `backend/pkg/clog/reader.go`（CLOG reader）

---

## Q: /api/wal 返回 "WAL segments unavailable"，但 PostgreSQL 正在运行

**症状**：WAL 日志读取失败，API 返回 `note: "WAL segments unavailable..."`，但 `pgv-postgres` 容器状态 healthy。

**根因**：backend 容器未运行或 volume 挂载缺失。常见于手动 `docker run` 覆盖了 compose 管理的容器，导致：
- 容器未接入 `pgv-net` 网络，无法连接 postgres
- `pg_wal` 目录未通过 volume 共享给 backend

**解决方法**：

```bash
# 检查 backend 是否运行
docker compose -f docker-compose.yml ps backend

# 如果有残留容器，先删除
docker rm -f pgv-backend

# 重新部署
docker compose -f docker-compose.yml up -d backend

# 验证 pg_wal 是否挂载
docker exec pgv-backend ls /var/lib/postgresql/data/pg_wal/

# 验证 WAL API
curl http://192.168.3.99:80/api/wal
```

注意：如果 compose 镜像未更新，先重新 build：
```bash
cd backend && docker build --no-cache -t learn_pg-backend:latest .
docker compose -f docker-compose.yml up -d --force-recreate backend
```

**涉及文件**：
- `docker-compose.yml`（backend 服务定义、pg_data volume）
- `backend/pkg/wal/reader.go`
