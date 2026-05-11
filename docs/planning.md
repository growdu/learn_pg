# 任务规划与进度日志

> 本文档合并了历史任务规划和进度记录，供追溯参考。
> 当前活跃进度请查看 [plan.md](./plan.md)。

---

## 1. 任务规划

### 阶段一：项目初始化

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 1.1 | 创建项目目录结构（backend/src, src, collector） | ✅ 完成 | 按 README.md 目录结构 |
| 1.2 | 初始化 Git 仓库 | ✅ 完成 | .gitignore，初始提交至 growdu/learn_pg |
| 1.3 | 配置 Docker Compose 开发环境（postgres18 + backend + frontend） | ✅ 完成 | docker-compose.dev.yml |
| 1.4 | 编写 .env.example 环境变量 | ✅ 完成 | PG/WS/API 端口配置 |

### 阶段二：Go 后端服务（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 2.1 | Go 项目初始化（go mod init） | ✅ 完成 | gorilla/websocket 依赖 |
| 2.2 | 配置加载模块（config.go，支持 env） | ✅ 完成 | PG/WS/API/Collector 配置 |
| 2.3 | PG Wire Protocol 客户端（pg/client.go） | ✅ 完成 | 无 libpq 依赖，自实现协议 |
| 2.4 | WebSocket Hub（ws/hub.go） | ✅ 完成 | 广播中心，多客户端管理 |
| 2.5 | HTTP API Handler（/health, /api/execute, /api/snapshot） | ✅ 完成 | REST + WS |
| 2.6 | WAL 文件读取解析（pkg/wal/reader.go + parser.go） | ✅ 完成 | 读取 pg_wal 目录，XLogRecord 解析 |
| 2.7 | CLOG 文件读取解析 | ✅ 完成 | 读取 pg_clog 目录，事务状态位 |
| 2.8 | Docker 构建验证（backend/Dockerfile） | ✅ 完成 | multi-stage build |
| 2.9 | 优雅关闭 + 结构化日志 + 中间件 | ✅ 完成 | slog, request ID, CORS, /readyz, /livez |
| 2.10 | WAL API 增强 | ✅ 完成 | /api/wal/segments, WAL 范围查询 |
| 2.11 | 统一错误格式 + handler 清理 | ✅ 完成 | ErrorResponse, writeError helper |

### 阶段三：React 前端（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 3.1 | React 项目初始化（Vite + TypeScript） | ✅ 完成 | package.json, vite.config.ts, tsconfig |
| 3.2 | 基础布局组件（Header, Sidebar, StatusBar） | ✅ 完成 | 导航 + 连接状态 |
| 3.3 | SQLConsole 组件（输入框 + 执行按钮 + 结果展示） | ✅ 完成 | 连接 PG，执行 SQL，表格输出 |
| 3.4 | WALViewer 组件（十六进制 + 结构解析） | ✅ 完成 | WAL 记录表格 |
| 3.5 | CLOGViewer 组件（事务状态位矩阵） | ✅ 完成 | 状态矩阵，颜色编码 |
| 3.6 | WebSocket 客户端（hooks/useWebSocket.ts） | ✅ 完成 | 实时事件订阅 |
| 3.7 | Zustand 状态管理（eventStore, pgStore） | ✅ 完成 | 采集事件 + PG 连接状态 |
| 3.8 | Docker 构建验证（frontend/Dockerfile + nginx.conf） | ✅ 完成 | React build + nginx |

### 阶段四：eBPF 采集器（P1）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 4.1 | Rust 项目初始化（Aya + tokio） | ✅ 完成 | Cargo.toml, tokio, serde, tokio-tungstenite |
| 4.2 | 探针定义模块（probe/mod.rs） | ✅ 完成 | 事务/WAL/Buffer/Lock 探针清单 + probe.bpf.c eBPF 源码 |
| 4.3 | WAL Insert 探针实现 | ✅ 完成 | XLogInsert uprobe 框架 |
| 4.4 | Buffer Pin 探针实现 | ✅ 完成 | BufFetchOrCreate uprobe 框架 |
| 4.5 | 事务状态探针实现 | ✅ 完成 | StartTransaction/CommitTransaction/AbortTransaction |
| 4.6 | WebSocket 客户端（上报后端） | ✅ 完成 | tokio-tungstenite WS 客户端 |
| 4.7 | Docker 构建验证（collector/Dockerfile） | ✅ 完成 | Rust multi-stage build |

### 阶段五：Pipeline 可视化（P1-P2）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 5.1 | PipelineView 组件（时间线动画） | ✅ 完成 | D3.js 横向时间线，10 节点 |
| 5.2 | BufferHeatmapView 组件 | ✅ 完成 | D3.js 热图网格，512 buffers |
| 5.3 | PlanTreeView 组件 | ✅ 完成 | D3.js 树形图，执行计划树 |
| 5.4 | LockGraphView 组件 | ✅ 完成 | D3 力导向图，拖拽/缩放/死锁检测 |
| 5.5 | TransactionStateView 组件 | ✅ 完成 | D3.js 状态机动画，5 状态转换 |

### 阶段六：集成与提交

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 6.1 | Docker Compose 完整联调 | ✅ 完成 | postgres + backend + frontend 联动验证通过 |
| 6.2 | GitHub Actions CI 流水线 | ✅ 完成 | Docker Buildx 多架构构建 |
| 6.3 | 按功能单元自动提交（每完成一个任务即提交） | ✅ 完成 | 已完成 14+ 次提交 |
| 6.4 | GitHub 仓库初始化并推送 | ✅ 完成 | growdu/learn_pg 已推送 |

### 决策记录

| 序号 | 决策 | 理由 | 日期 |
|------|------|------|------|
| D1 | 使用 Docker Compose 作为主要开发和验证环境 | 需求明确云原生部署 | 2026-03-30 |
| D2 | PG 版本基准为 18 | 用户指定 postgres:18 | 2026-03-30 |
| D3 | eBPF 不可用时降级为日志解析模式 | 兼容非特权/非 Linux 环境 | 2026-03-30 |
| D4 | 每个任务完成后立即提交 GitHub | 功能解耦，快速迭代 | 2026-03-30 |

---

## 2. 进度日志

### 2026-05-11

**前端交互优化 + 文档整理**

#### 本轮改动
- 拓扑图节点双击进入节点详情页（TopologyMap onDoubleClick）
- 节点详情页及所有子页面（11个）统一添加"返回集群"按钮
- NodePageHeader 组件支持 rightSlot 与 onBack 并列渲染
- 版本号/LNS 长文本溢出处理（stat-card flex + word-break）
- docs/ 目录结构整理，根目录只保留 README.md

#### 提交记录
- `feat(frontend): 拓扑图节点双击进入节点详情`
- `feat(frontend): 所有子页面统一添加返回集群按钮`
- `fix(frontend): NodePageHeader rightSlot 与 onBack 并列渲染`
- `fix(frontend): 版本号/LNS 长文本溢出处理`
- `docs: 整理 docs/ 目录结构，根目录只保留 README.md`
- `chore: postgres/ 源码目录加入 .gitignore`

---

### 2026-05-09

**手动部署文档完善 + 服务状态验证**

- 完成 docs/manual-deploy.md（Linux 手动部署指南）
- 确认 nginx + backend + PostgreSQL 链路正常
- Workspace 后端持久化已完成

---

### 2026-05-06

**M3 节点专题真实化**

- 锁等待图、事务状态页面优先使用 `/api/snapshot` 真实数据
- Buffer 热图移除随机/时序演示数据
- 内存结构页改为 snapshot+事件流真实数据
- 执行计划树移除内置 DEMO_PLAN
- Pipeline 视图移除演示动画
- 节点专题页头统一使用 NodePageHeader 组件

---

### 2026-05-04

**联调验证完成**

| 端点 | 状态 | 备注 |
|------|------|------|
| GET /health | ✅ | pg_connected: true |
| GET /readyz | ✅ | status: ready |
| GET /livez | ✅ | status: alive |
| POST /api/execute | ✅ | SQL 执行正常，PostgreSQL 18.3 |
| GET /api/wal/segments | ✅ | 返回 WAL 段列表 |
| WS /ws/ | ✅ | 101 Switching Protocols |

> 注：CLOG API 有已知路由问题（/api/clog/status 被 ServeCLOGFile 误匹配为文件名），不影响核心功能。

---

### 2026-03-31

**已累计完成全部 6 个阶段**

累计提交（按提交哈希）：

| 提交 | 内容 |
|------|------|
| fc8c3c8 | 项目骨架 + 设计文档 |
| 9a93fd1 | docker-compose.dev.yml + Dockerfiles |
| fb722d6 | .env.example |
| d028d62 | config.go |
| 16a7146 | ws/hub.go, pg/client.go, api/handler.go |
| 8008200 | pkg/wal/, pkg/clog/ |
| 30f5c8f | 生产 Dockerfile + docker-compose.yml |
| 97b226a | React 前端（布局、SQLConsole、WALViewer、CLOGViewer 等） |
| 45a8d1d | Rust eBPF 采集器（WS 客户端 + 日志解析降级） |
| e1d0202 | D3.js 可视化（PipelineView, BufferHeatmap, LockGraph, PlanTree） |
| 9001a4c | task_plan.md 更新 |
| 7a3b9c2 | eBPF 探针定义 + TransactionStateView |
| 052984b | GitHub Actions CI 流水线 |
| bde5280 | 优雅关闭, slog, 中间件, WAL API 增强, 统一错误格式 |

---

*最后更新：2026-05-11*
