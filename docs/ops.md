# PG Kernel Visualizer 运维手册

## 1. 适用范围

本文档适用于当前产品定位：**单用户本地工具**。

主要运行形态：
- 本机开发运行
- 本机 Docker Compose 运行
- 可选连接本机或远程 PostgreSQL

不在本文档重点范围内：
- 多节点集群化部署
- 多用户共享后端
- Kubernetes / Swarm 运维

## 2. 运行组件

当前系统由以下组件组成：

- `frontend`：React 前端
- `backend`：Go 后端
- `postgres`：被观测数据库，可能是本机实例或 Docker 容器
- `collector`：可选的 eBPF / 日志采集组件

逻辑关系：

```text
Browser -> Backend -> PostgreSQL / Host / Collector
```

## 3. 启动方式

### 3.1 本地开发启动

后端：

```bash
cd backend
go run ./cmd/server
```

前端：

```bash
cd frontend
npm install
npm run dev
```

### 3.2 Docker Compose 启动

```bash
docker compose -f docker-compose.dev.yml up -d
```

如果只需要核心链路：

```bash
docker compose up -d postgres backend frontend
```

## 4. 日常检查

### 4.1 健康检查

后端：

```bash
curl http://localhost:3000/health
curl http://localhost:3000/readyz
curl http://localhost:3000/livez
```

说明：
- `/health`：后端进程可用，且当前数据库连接状态可判断
- `/readyz`：后端依赖就绪
- `/livez`：进程活着

### 4.2 前端可达性

检查页面是否能正常打开：

- 开发模式：Vite 本地地址
- Docker 模式：`http://localhost`

### 4.3 数据库可达性

如果系统无法连接数据库，先手工验证：

```bash
pg_isready -h 127.0.0.1 -p 5432 -U postgres
```

或：

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "select version();"
```

## 5. 日志与排障

### 5.1 查看后端日志

本地运行时，直接看终端输出。

Docker 模式：

```bash
docker compose logs -f backend
```

### 5.2 查看前端日志

- 开发模式：查看 Vite 终端和浏览器控制台
- Docker 模式：查看 nginx / frontend 容器日志

```bash
docker compose logs -f frontend
```

### 5.3 查看数据库日志

如果数据库在 Docker 中：

```bash
docker compose logs -f postgres
```

如果数据库在本机：
- 查看 PostgreSQL 日志目录
- 或使用 `journalctl` / system service 日志

## 6. 备份与恢复

## 6.1 需要备份的内容

对于单用户本地工具，最重要的是两类数据：

1. 工作区数据
2. 被观测数据库的数据（如果数据库也是本机工具链的一部分）

### 6.2 工作区数据备份

当前后端使用本地文件持久化工作区和任务状态，至少应备份：

- `backend/data/workspace_projects.json`
- `backend/data/provision_tasks.json`

示例：

```bash
mkdir -p backups
cp backend/data/workspace_projects.json backups/workspace_projects.json.bak
cp backend/data/provision_tasks.json backups/provision_tasks.json.bak
```

### 6.3 PostgreSQL 数据备份

如果数据库由 Docker 启动：

```bash
docker compose exec -T postgres pg_dump -U postgres postgres > backups/postgres.sql
```

如果数据库在本机：

```bash
pg_dump -h 127.0.0.1 -p 5432 -U postgres postgres > backups/postgres.sql
```

### 6.4 恢复

工作区恢复：

```bash
cp backups/workspace_projects.json.bak backend/data/workspace_projects.json
cp backups/provision_tasks.json.bak backend/data/provision_tasks.json
```

数据库恢复：

```bash
psql -h 127.0.0.1 -p 5432 -U postgres postgres < backups/postgres.sql
```

## 7. 配置管理

### 7.1 关键配置项

| 变量 | 说明 |
|------|------|
| `PG_HOST` | 默认数据库地址 |
| `PG_PORT` | 默认数据库端口 |
| `PG_USER` | 默认数据库用户名 |
| `PG_PASSWORD` | 默认数据库密码 |
| `PG_DATABASE` | 默认数据库名 |
| `PG_DATA_DIR` | 数据目录 |
| `API_PORT` | 后端端口 |
| `LOG_LEVEL` | 日志级别 |

### 7.2 凭据管理建议

- 不要把生产数据库密码提交进仓库。
- 对单用户本地工具，建议使用本地 `.env` 或本机私有配置。
- 浏览器端不应作为凭据长期存储位置。

## 8. 常见故障处理

### 8.1 后端启动了，但页面看不到数据

优先检查：

1. 后端 `health` 是否正常
2. 当前节点是否已成功连接
3. PostgreSQL 是否实际可达
4. 是否只是当前页暂无数据而非系统异常

### 8.2 集群总览为空

常见原因：

1. 工作区中没有节点
2. 节点连接参数错误
3. 后端尚未成功连接数据库

建议动作：

1. 回到集群页检查节点配置
2. 手动触发连接
3. 查看后端日志

### 8.3 WebSocket 连接失败

检查：

```bash
curl http://localhost:3000/health
```

如果后端正常，再检查：
- 前端是否走了正确的 `/ws`
- 反向代理是否带了 `Upgrade` 头

### 8.4 eBPF 不可用

这是当前可接受情况。

处理原则：
- 先保证基础 SQL / snapshot / overview 路径可用
- eBPF 失败时退回日志解析或无事件流模式

## 9. 升级建议

单用户本地工具的安全升级流程：

1. 备份工作区文件
2. 备份 PostgreSQL 数据
3. 更新代码或镜像
4. 重启 backend / frontend
5. 执行健康检查
6. 打开页面验证工作区和节点连接状态

## 10. 运维边界

当前阶段不建议把这套系统当作：

- 多用户共享平台
- 长期公网服务
- 自动扩缩容系统
- 高可用集群控制平面

如果未来演进到这些方向，应重新设计：
- 连接隔离
- 凭据托管
- 任务队列
- 权限模型
- 持久化方案

## 11. 联调检查清单

### 11.1 环境准备

- [ ] Docker daemon 运行中（`docker info`）
- [ ] 后端运行在 `http://localhost:8080`（或配置的端口）
- [ ] 前端运行在 `http://localhost:5173`（开发模式）
- [ ] PostgreSQL 测试实例运行中（用于 E2E 测试）

### 11.2 启动 E2E 测试环境

```bash
# 启动 E2E 测试专用 PostgreSQL
docker compose -f docker-compose.e2e.yml up -d

# 验证 PG 可用
pg_isready -h 127.0.0.1 -p 5432 -U postgres
```

### 11.3 运行测试

```bash
cd tests/e2e
npm install
npx playwright install chromium

# 运行所有 E2E 测试
npm test

# 带 UI 运行
npm run test:ui

# 清理测试环境
npm run test:cleanup
docker compose -f docker-compose.e2e.yml down
```

### 11.4 主链路检查项

| 功能 | 验证方式 | 预期结果 |
|------|---------|---------|
| 手动连接数据库 | `POST /api/connect` | 返回 version |
| 主机探测扫描 | `POST /api/discovery/host/scan` | 返回 reachable 状态 |
| DSN 导入 | `POST /api/discovery/dsn/validate` + `import` | 节点写入 workspace |
| 单机 provision | `POST /api/provision/single` | 容器拉起，节点可连接 |
| 预览模式 | 前端操作 | 不调用 API，不写 workspace |
| provision 失败 | 模拟错误 | 明确错误提示，无假资源 |

### 11.5 常见 E2E 测试问题

**Q: Playwright 找不到浏览器**
```bash
npx playwright install chromium
```

**Q: Docker 命令在 CI 中失败**
- 检查 Docker-in-Docker (DinD) 配置
- 或使用 GitHub Actions 的 `docker/setup-buildx-action`

**Q: 测试超时**
- 检查 `docker-compose.e2e.yml` 中 PostgreSQL 是否正常启动
- 增加 `globalSetup` 等待时间

**Q: 前端构建失败**
```bash
cd frontend && npm install && npm run build
```

## 12. 关键文件位置

| 文件 | 说明 |
|------|------|
| `backend/data/workspace_projects.json` | 工作区持久化数据 |
| `backend/data/provision_tasks.json` | provision 任务状态 |
| `tests/e2e/` | Playwright E2E 测试套件 |
| `docker-compose.e2e.yml` | E2E 测试环境依赖 |
| `docs/superpowers/specs/` | 设计文档 |
