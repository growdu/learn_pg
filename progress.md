# 进度日志 — PG Kernel Visualizer

---

## 2026-03-31

### 已完成任务

| 提交 | 任务 | 内容 |
|------|------|------|
| fc8c3c8 | 1.1,1.2 | 项目骨架 + 设计文档 |
| 9a93fd1 | 1.3 | docker-compose.dev.yml + Dockerfiles (backend/collector/frontend dev) |
| fb722d6 | 1.4 | .env.example 环境变量模板 |
| d028d62 | 2.2 | config.go 配置加载模块 |
| 16a7146 | 2.3-2.9 | ws/hub.go, pg/client.go, api/handler.go, cmd/server/main.go |
| 8008200 | 2.10-2.11 | pkg/wal/reader.go, parser.go, pkg/clog/reader.go |
| 30f5c8f | P0全部 | 生产 Dockerfile + docker-compose.yml |
| 97b226a | 3.1-3.7 | React前端（布局、SQLConsole、WALViewer、CLOGViewer等） |
| 45a8d1d | 4.1,4.6,4.7 | Rust eBPF采集器（WS客户端 + 日志解析降级模式） |
| e1d0202 | 5.1-5.4 | D3.js可视化（PipelineView, BufferHeatmapView, LockGraphView, PlanTreeView） |
| 9001a4c | - | task_plan.md 更新 |
| 7a3b9c2 | 4.2-4.5,5.5 | eBPF探针定义 + TransactionStateView |

**累计 13 次提交，已推送至 GitHub (growdu/learn_pg)**

### 进行中

- [ ] 阶段六：集成与提交
  - [ ] 6.1 Docker Compose 完整联调
  - [ ] 6.2 GitHub Actions CI 流水线

### 下一步

**阶段六执行顺序：**
1. 完整 Docker Compose 联调（postgres + backend + frontend + collector）
2. GitHub Actions CI 流水线（Docker Buildx 多架构构建）

### 备注

- P0（项目初始化 + Go后端 + React前端）已全部完成
- 阶段五（Pipeline可视化）5/5 完成
- 阶段四（eBPF采集器）探针框架已完成
- 每个任务完成后自动提交 GitHub

---

*最后更新：2026-03-31*