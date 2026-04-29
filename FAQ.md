# FAQ / 常见问题

## Q: 浏览器连接数据库失败，提示 502 Bad Gateway

**症状**：通过前端 UI 点击 "Connect" 连接 PostgreSQL，返回 502 Bad Gateway 或 `dial tcp: lookup pgv-backend on 127.0.0.11:53: no such host`。

**根因**：Docker Compose 中 nginx 反向代理到后端服务 `pgv-backend`。Docker 容器内使用嵌入式 DNS（`127.0.0.11`）来解析 Compose 服务名，但 nginx 配置文件（`frontend/nginx.conf`）缺少 DNS 解析器配置，导致 nginx worker 进程无法解析 `pgv-backend` 服务名，连接失败。

**解决方法**：在 `frontend/nginx.conf` 的 `http {}` 块中添加 Docker 内置 DNS 作为 resolver：

```nginx
http {
    resolver 127.0.0.11 valid=30s ipv6=off;
    # ... 其他配置 ...
}
```

`127.0.0.11` 是 Docker 为容器分配的嵌入式 DNS 服务器地址，所有 Docker 服务名都通过它解析。`valid=30s` 控制 DNS 缓存 TTL，`ipv6=off` 避免 IPv6 解析延迟。

**涉及文件**：
- `frontend/nginx.conf`
- `docker-compose.yml`（服务网络配置）

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
