# learn_pg

PostgreSQL 内核学习与可视化观测项目。

当前定位：**Web MVP（后端统一连接、统一编排、统一观测）**。

## 1. 当前状态

当前真正可用的闭环：
- 项目 / 集群 / 节点 / 组件分层工作区
- 手动添加数据库节点，由后端建立连接并提供观测
- 集群总览、复制拓扑、节点专题页（SQL、WAL、CLOG、锁、事务、内存等）
- 工作区后端持久化
- 节点专题页真实数据化（锁图、事务状态、Buffer 热图等）

当前尚未完成的目标能力：
- 一键拉起单机 PostgreSQL，并自动进入观测
- 一键拉起主备复制集群，并自动进入观测
- 一键拉起逻辑复制集群，并自动进入观测
- 添加数据库所在机器节点后，自动发现实例并导入观测
- 自动化回归、联调脚本、任务回滚与状态编排

## 2. 架构边界

系统采用统一后端代理模式：

```text
Browser (React)
    -> HTTP / WebSocket
Backend (Go)
    -> PostgreSQL wire protocol
    -> Provision runtime (docker/local)
    -> Host discovery (SSH / agent)
    -> Collector event stream
PostgreSQL / Host Machine / Collector
```

关键约束：
- 浏览器不直接连接 PostgreSQL。
- 浏览器不直接连接数据库宿主机。
- 所有数据库连接、主机扫描、集群拉起、任务编排都由后端负责。
- 前端只消费后端提供的工作区、任务状态、观测数据和实时事件。

## 3. 当前开发重点

当前需求已收敛为三条主链路：
1. 手动接入数据库节点，后端连接后进入观测。
2. 从界面一键拉起单机 / 主备 / 逻辑复制集群，后端完成初始化并自动接入观测。
3. 添加数据库运行机器节点，由后端自动扫描 PostgreSQL 实例并导入观测。

详细设计与实施计划见 `docs/design.md`、`docs/apply.md`、`docs/plan.md`。

## 4. 技术架构

| 组件 | 技术栈 | 路径 |
|------|--------|------|
| 前端 | React + TypeScript + Vite | `./frontend/` |
| 后端 | Go (HTTP + WebSocket) | `./backend/` |
| 数据采集器 | eBPF (Rust) | `./collector/` |
| 数据库 | PostgreSQL 18 | 本机安装 / Docker |
| 部署 | Docker Compose + nginx | `./docker-compose*.yml` |

## 5. 快速启动

### 5.1 前端开发
```bash
cd frontend
npm install
npm run dev
```

### 5.2 后端开发
```bash
cd backend
go run ./cmd/server
```

### 5.3 完整 Docker 环境
```bash
docker compose -f docker-compose.dev.yml up -d
```

## 6. 关键接口

- `GET /health` — 健康检查
- `POST /api/connect` — 由后端建立数据库连接
- `POST /api/cluster/overview` — 集群总览与同步状态
- `GET /api/snapshot` — 节点实时快照
- `GET /api/workspace/projects` — 工作区项目列表
- `PUT /api/workspace/projects` — 保存工作区配置
- `POST /api/provision/*` — 一键拉起任务入口（目标能力，当前需补全真实编排）
- `POST /api/discovery/*` — 宿主机扫描 / DSN 导入入口（目标能力，当前需补全真实探测）
- `WS /ws` — 实时事件流

## 7. 文档索引

所有详细文档位于 `./docs/` 目录：

| 文档 | 说明 |
|------|------|
| [docs/README.md](./docs/README.md) | 文档总入口 |
| [docs/need.md](./docs/need.md) | 需求边界：统一后端连接、自动拉起、宿主机接入 |
| [docs/design.md](./docs/design.md) | 系统设计：架构边界、资源接入流、接口设计 |
| [docs/apply.md](./docs/apply.md) | 实施方案：模块拆分、阶段落地、数据结构 |
| [docs/plan.md](./docs/plan.md) | 开发计划与里程碑 |
| [docs/user-manual.md](./docs/user-manual.md) | 用户手册：当前可用功能、操作步骤、限制说明 |
| [docs/FAQ.md](./docs/FAQ.md) | 常见问题：Nginx 502、WebSocket、CLOG/WAL 故障排查 |
| [docs/deploy.md](./docs/deploy.md) | Docker Compose / K8s 部署指南 |
| [docs/manual-deploy.md](./docs/manual-deploy.md) | Linux 手动部署指南（nginx + 后端 + PostgreSQL） |
| [docs/ops.md](./docs/ops.md) | 运维手册：单用户本地工具的启动、备份、排障、升级 |
| [docs/planning.md](./docs/planning.md) | 历史规划与进度记录 |
| [docs/findings.md](./docs/findings.md) | 技术调研：eBPF、PG Wire Protocol、踩坑记录 |

## 8. 部署地址

- 前端：http://8.137.19.179
- 后端 API：http://8.137.19.179:3000
- WebSocket：ws://8.137.19.179/ws
