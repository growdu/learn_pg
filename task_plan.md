# 任务规划 — PG Kernel Visualizer

> 项目：PostgreSQL 内核学习可视化平台
> 目标：根据 README.md 进行解耦实现，每个功能单元独立测试验证后自动提交 GitHub

---

## 阶段一：项目初始化

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 1.1 | 创建项目目录结构（backend/src, src, collector） | completed | 按 README.md 9.目录结构 |
| 1.2 | 初始化 Git 仓库 | completed | .gitignore，初始提交至 growdu/learn_pg |
| 1.3 | 配置 Docker Compose 开发环境（postgres18 + backend + frontend） | completed | docker-compose.dev.yml |
| 1.4 | 编写 .env.example 环境变量 | completed | PG/WS/API 端口配置 |

## 阶段二：Go 后端服务（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
|| 2.1 | Go 项目初始化（go mod init） | completed | gorilla/websocket 依赖 |
|| 2.2 | 配置加载模块（config.go，支持 env） | completed | PG/WS/API/Collector配置 |
|| 2.3 | PG Wire Protocol 客户端（pg/client.go） | completed | 无 libpq 依赖，自实现协议 |
|| 2.4 | WebSocket Hub（ws/hub.go） | completed | 广播中心，多客户端管理 |
|| 2.5 | HTTP API Handler（/health, /api/execute, /api/snapshot） | completed | REST + WS |
|| 2.6 | WAL 文件读取解析（pkg/wal/reader.go + parser.go） | completed | 读取 pg_wal 目录，XLogRecord 解析 |
|| 2.7 | CLOG 文件读取解析 | completed | 读取 pg_clog 目录，事务状态位 |
|| 2.8 | Docker 构建验证（backend/Dockerfile） | completed | multi-stage build |
|| 2.9 | 优雅关闭 + 结构化日志 + 中间件 | completed | slog, request ID, CORS, /readyz, /livez |
|| 2.10 | WAL API 增强 | completed | /api/wal/segments, WAL 范围查询 |
|| 2.11 | 统一错误格式 + handler 清理 | completed | ErrorResponse, writeError helper |

## 阶段三：React 前端（P0）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 3.1 | React 项目初始化（Vite + TypeScript） | completed | package.json, vite.config.ts, tsconfig |
| 3.2 | 基础布局组件（Header, Sidebar, StatusBar） | completed | 导航 + 连接状态 |
| 3.3 | SQLConsole 组件（输入框 + 执行按钮 + 结果展示） | completed | 连接PG，执行SQL，表格输出 |
| 3.4 | WALViewer 组件（十六进制 + 结构解析） | completed | WAL记录表格 |
| 3.5 | CLOGViewer 组件（事务状态位矩阵） | completed | 状态矩阵，颜色编码 |
| 3.6 | WebSocket 客户端（hooks/useWebSocket.ts） | completed | 实时事件订阅 |
| 3.7 | Zustand 状态管理（eventStore, pgStore） | completed | 采集事件 + PG连接状态 |
| 3.8 | Docker 构建验证（frontend/Dockerfile + nginx.conf） | completed | React build + nginx |

## 阶段四：eBPF 采集器（P1）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|
| 4.1 | Rust 项目初始化（Aya + tokio） | completed | Cargo.toml, tokio, serde, tokio-tungstenite |
| 4.2 | 探针定义模块（probe/mod.rs） | completed | 事务/WAL/Buffer/Lock 探针清单 + probe.bpf.c eBPF源码 |
| 4.3 | WAL Insert 探针实现 | completed | XLogInsert uprobe 框架 |
| 4.4 | Buffer Pin 探针实现 | completed | BufFetchOrCreate uprobe 框架 |
| 4.5 | 事务状态探针实现 | completed | StartTransaction/CommitTransaction/AbortTransaction |
| 4.6 | WebSocket 客户端（上报后端） | completed | tokio-tungstenite WS客户端 |
| 4.7 | Docker 构建验证（collector/Dockerfile） | completed | Rust multi-stage build |

## 阶段五：Pipeline 可视化（P1-P2）

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 5.1 | PipelineView 组件（时间线动画） | completed | D3.js 横向时间线，10节点，支持演示动画 |
| 5.2 | BufferHeatmapView 组件 | completed | D3.js热图网格，512 buffers，颜色编码 |
| 5.3 | PlanTreeView 组件 | completed | D3.js树形图，执行计划树 |
| 5.4 | LockGraphView 组件 | completed | D3力导向图，拖拽/缩放/死锁检测 |
| 5.5 | TransactionStateView 组件 | completed | D3.js 状态机动画，5状态转换 |

## 阶段六：集成与提交

| 序号 | 任务 | 状态 | 备注 |
|------|------|------|------|
| 6.1 | Docker Compose 完整联调 | completed | postgres + backend + frontend 联动验证通过，2026-05-04 |
| 6.2 | GitHub Actions CI 流水线 | completed | Docker Buildx 多架构构建 |
| 6.3 | 按功能单元自动提交（每完成一个任务即提交） | completed | 已完成 14 次提交 |
| 6.4 | GitHub 仓库初始化并推送 | completed | growdu/learn_pg 已推送 |

---

## 决策记录

| 序号 | 决策 | 理由 | 日期 |
|------|------|------|------|
| D1 | 使用 Docker Compose 作为主要开发和验证环境 | 需求明确云原生部署 | 2026-03-30 |
| D2 | PG 版本基准为 18 | 用户指定 postgres:18 | 2026-03-30 |
| D3 | eBPF 不可用时降级为日志解析模式 | 兼容非特权/非Linux环境 | 2026-03-30 |
| D4 | 每个任务完成后立即提交 GitHub | 功能解耦，快速迭代 | 2026-03-30 |

---

## 累计提交（14次）

| 提交 | 内容 |
|------|------|
| fc8c3c8 | 项目骨架 + 设计文档 |
| 9a93fd1 | docker-compose.dev.yml + Dockerfiles |
| fb722d6 | .env.example |
| d028d62 | config.go |
| 16a7146 | ws/hub.go, pg/client.go, api/handler.go |
| 8008200 | pkg/wal/, pkg/clog/ |
| 30f5c8f | 生产 Dockerfile + docker-compose.yml |
| 97b226a | React 前端（布局、SQLConsole、WALViewer、CLOGViewer等） |
| 45a8d1d | Rust eBPF采集器（WS客户端 + 日志解析降级） |
| e1d0202 | D3.js可视化（PipelineView, BufferHeatmap, LockGraph, PlanTree） |
| 9001a4c | task_plan.md 更新 |
| 052984b | eBPF探针定义 + TransactionStateView |
| 957f5ec | GitHub Actions CI 流水线 |

---

*最后更新：2026-05-04*