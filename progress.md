# 进度日志 — PG Kernel Visualizer

---

## 2026-03-31

### 已完成任务（全部完成）

| 提交 | 任务 | 内容 |
|------|------|------|
| fc8c3c8 | 1.1,1.2 | 项目骨架 + 设计文档 |
| 9a93fd1 | 1.3 | docker-compose.dev.yml + Dockerfiles |
| fb722d6 | 1.4 | .env.example 环境变量模板 |
| d028d62 | 2.2 | config.go 配置加载模块 |
| 16a7146 | 2.3-2.9 | ws/hub.go, pg/client.go, api/handler.go |
| 8008200 | 2.10-2.11 | pkg/wal/reader.go, parser.go, pkg/clog/reader.go |
| 30f5c8f | 2.8 | 生产 Dockerfile + docker-compose.yml |
| 97b226a | 3.1-3.8 | React前端（布局、SQLConsole、WALViewer、CLOGViewer等） |
| 45a8d1d | 4.1,4.6,4.7 | Rust eBPF采集器（WS客户端 + 日志解析降级） |
| e1d0202 | 5.1-5.4 | D3.js可视化（PipelineView, BufferHeatmapView, LockGraphView, PlanTreeView） |
| 9001a4c | - | task_plan.md 更新 |
| 7a3b9c2 | 4.2-4.5 | eBPF探针定义模块（probe/mod.rs + probe.bpf.c） |
| 052984b | 5.5 | TransactionStateView D3.js 状态机组件 |
| 957f5ec | 6.2 | GitHub Actions CI 流水线 |

**累计 14 次提交，已推送至 GitHub (growdu/learn_pg)**

### 项目状态：✅ 全部完成

- 阶段一：项目初始化 ✅
- 阶段二：Go 后端服务 ✅
- 阶段三：React 前端 ✅
- 阶段四：eBPF 采集器 ✅
- 阶段五：Pipeline 可视化 ✅
- 阶段六：集成与提交 ✅

### 部署方式

```bash
# 启动完整环境
docker compose up -d

# 仅启动核心服务（Linux）
docker compose up -d postgres backend frontend

# 启动含 eBPF 采集器（需要特权容器）
docker compose --profile linux-only up -d
```

### 技术栈

- **后端**: Go 1.21+, gorilla/websocket, 自实现 PG Wire Protocol
- **前端**: React 18, TypeScript, D3.js v7, Zustand
- **采集器**: Rust, Aya eBPF 框架, tokio
- **数据库**: PostgreSQL 18
- **部署**: Docker Compose, GitHub Actions

---

*最后更新：2026-03-31*