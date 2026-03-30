# 任务规划 — PG Kernel Visualizer

> 项目：PostgreSQL 内核学习可视化平台
> 目标：根据 README.md 进行解耦实现，每个功能单元独立测试验证后自动提交 GitHub

---

## 阶段一：项目初始化

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 1.1 | 创建项目目录结构（backend/src, src, collector） | pending | 按 README.md 9.目录结构 |
| 1.2 | 初始化 Git 仓库 | pending | 创建 .gitignore，初始提交 |
| 1.3 | 配置 Docker Compose 开发环境（postgres18 + backend + frontend） | pending | 验证三容器互通 |
| 1.4 | 编写 .env.example 环境变量 | pending | PG/WS/API 端口配置 |

## 阶段二：Go 后端服务（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 2.1 | Go 项目初始化（go mod init） | pending | 依赖：ws, pgx, viper, cobra |
| 2.2 | 配置加载模块（config.go，支持 env） | pending | |
| 2.3 | PG Wire Protocol 客户端（pg/client.go） | pending | 无 libpq 依赖，自实现协议 |
| 2.4 | WebSocket Hub（ws/hub.go） | pending | 广播中心，多客户端管理 |
| 2.5 | HTTP API Handler（/health, /api/execute, /api/snapshot） | pending | |
| 2.6 | WAL 文件读取解析（pkg/wal/reader.go + parser.go） | pending | 读取 pg_wal 目录 |
| 2.7 | CLOG 文件读取解析 | pending | 读取 pg_clog 目录 |
| 2.8 | Docker 构建验证（backend/Dockerfile） | pending | |

## 阶段三：React 前端（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 3.1 | React 项目初始化（Vite + TypeScript） | pending | |
| 3.2 | 基础布局组件（Header, Sidebar, StatusBar） | pending | |
| 3.3 | SQLConsole 组件（输入框 + 执行按钮 + 结果展示） | pending | |
| 3.4 | WALViewer 组件（十六进制 + 结构解析） | pending | |
| 3.5 | CLOGViewer 组件（事务状态位矩阵） | pending | |
| 3.6 | WebSocket 客户端（hooks/useWebSocket.ts） | pending | |
| 3.7 | Zustand 状态管理（eventStore, pgStore） | pending | |
| 3.8 | Docker 构建验证（frontend/Dockerfile + nginx.conf） | pending | |

## 阶段四：eBPF 采集器（P1）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|
| 4.1 | Rust 项目初始化（Aya + tokio） | pending | |
| 4.2 | 探针定义模块（probe/mod.rs） | pending | 事务/WAL/Buffer/Lock 探针清单 |
| 4.3 | WAL Insert 探针实现 | pending | XLogInsert 事件采集 |
| 4.4 | Buffer Pin 探针实现 | pending | buffer hit/miss 事件 |
| 4.5 | 事务状态探针实现 | pending | begin/commit/abort |
| 4.6 | WebSocket 客户端（上报后端） | pending | |
| 4.7 | Docker 构建验证（collector/Dockerfile） | pending | 需要特权容器 |

## 阶段五：Pipeline 可视化（P1-P2）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 5.1 | PipelineView 组件（时间线动画） | pending | D3.js 横向时间线 |
| 5.2 | BufferHeatmapView 组件 | pending | 热图网格，颜色编码 |
| 5.3 | PlanTreeView 组件 | pending | 执行计划树 |
| 5.4 | LockGraphView 组件 | pending | D3 力导向图 |
| 5.5 | TransactionStateView 组件 | pending | 状态机动画 |

## 阶段六：集成与提交（P0-P5）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 6.1 | Docker Compose 完整联调 | pending | postgres + backend + frontend + collector |
| 6.2 | GitHub Actions CI 流水线 | pending | Docker Buildx 多架构构建 |
| 6.3 | 按功能单元自动提交（每完成一个任务即提交） | pending | commit message 规范 |
| 6.4 | GitHub 仓库初始化并推送 | pending | |

---

## 决策记录

| 序号 | 决策 | 理由 | 日期 |
|------|------|------|------|
| D1 | 使用 Docker Compose 作为主要开发和验证环境 | 需求明确云原生部署 | 2026-03-30 |
| D2 | PG 版本基准为 18 | 用户指定 postgres:18 | 2026-03-30 |
| D3 | eBPF 不可用时降级为日志解析模式 | 兼容非特权/非Linux环境 | 2026-03-30 |
| D4 | 每个任务完成后立即提交 GitHub | 功能解耦，快速迭代 | 2026-03-30 |

---

*最后更新：2026-03-30*