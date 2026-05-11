# learn_pg

PostgreSQL 内核学习与可视化观测项目。

当前定位：**Web MVP（多项目/多集群/多节点）+ 部分真实采集能力**。

## 1. 当前状态

已具备：
- 项目/集群/节点/组件分层工作区
- 物理复制与逻辑复制模板化创建
- 集群同步状态看板（后端接口驱动）
- 节点观测入口（SQL、WAL、CLOG、锁、事务、内存等）
- 拓扑图双击进入节点详情，节点页全链路支持返回
- 工作区配置后端持久化
- 节点专题页真实数据化（锁图、事务状态、Buffer 热图等）

## 2. 技术架构

| 组件 | 技术栈 | 路径 |
|------|--------|------|
| 前端 | React + TypeScript + Vite | `./frontend/` |
| 后端 | Go (HTTP + WebSocket) | `./backend/` |
| 数据采集器 | eBPF (Rust) | `./collector/` |
| 数据库 | PostgreSQL 18 | 本机安装 |
| 部署 | Docker Compose + nginx | `./docker-compose*.yml` |

## 3. 快速启动

### 3.1 前端开发
```bash
cd frontend
npm install
npm run dev
```

### 3.2 后端开发
```bash
cd backend
go run ./cmd/server
```

### 3.3 完整 Docker 环境
```bash
docker compose -f docker-compose.dev.yml up -d
```

## 4. 关键接口

- `GET /health` — 健康检查（pg_connected 状态）
- `POST /api/connect` — 激活节点连接
- `POST /api/cluster/overview` — 集群总览与同步状态
- `GET /api/workspace/projects` — 工作区项目列表
- `PUT /api/workspace/projects` — 保存工作区配置
- `WS /ws` — 实时事件流

## 5. 文档索引

所有详细文档位于 `./docs/` 目录：

| 文档 | 说明 |
|------|------|
| [docs/README.md](./docs/README.md) | 文档总入口 |
| [docs/design.md](./docs/design.md) | 系统设计：信息架构、页面结构、API 设计 |
| [docs/plan.md](./docs/plan.md) | 开发计划与里程碑（M1-M4） |
| [docs/apply.md](./docs/apply.md) | 实现记录：Provisioning、Discovery API 契约 |
| [docs/FAQ.md](./docs/FAQ.md) | 常见问题：Nginx 502、WebSocket、CLOG/WAL 故障排查 |
| [docs/deploy.md](./docs/deploy.md) | Docker Compose / K8s 部署指南 |
| [docs/manual-deploy.md](./docs/manual-deploy.md) | Linux 手动部署指南（nginx + 后端 + PostgreSQL） |
| [docs/ops.md](./docs/ops.md) | 运维手册：日志、监控、备份、扩缩容 |
| [docs/planning.md](./docs/planning.md) | 任务规划与进度日志（历史） |
| [docs/findings.md](./docs/findings.md) | 技术调研：eBPF 方案、PG Wire Protocol、踩坑记录 |

## 6. 部署地址

- 前端：http://8.137.19.179
- 后端 API：http://8.137.19.179:3000
- WebSocket：ws://8.137.19.179/ws
