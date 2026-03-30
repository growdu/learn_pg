# 进度日志 — PG Kernel Visualizer

---

## 2026-03-30

### 已完成任务

| 提交 | 任务 | 内容 |
|------|------|------|
| fc8c3c8 | 1.1,1.2 | 项目骨架 + 设计文档（README.md, design.md, need.md, task_plan.md, findings.md, progress.md） |
| 9a93fd1 | 1.3 | docker-compose.dev.yml + Dockerfiles (backend/collector/frontend dev) |
| fb722d6 | 1.4 | .env.example 环境变量模板 |
| d028d62 | 2.2 | config.go 配置加载模块 |
| 16a7146 | 2.3-2.9 | ws/hub.go, pg/client.go, api/handler.go, cmd/server/main.go |
| 8008200 | 2.10-2.11 | pkg/wal/reader.go, parser.go, pkg/clog/reader.go |
| 30f5c8f | P0全部 | 生产 Dockerfile + docker-compose.yml |

**累计 7 次提交，已推送至 GitHub (growdu/learn_pg)**

### 进行中

- [ ] 阶段三：React 前端
  - [ ] 3.1 React + Vite + TypeScript 项目初始化
  - [ ] 3.2 基础布局组件（Header, Sidebar, StatusBar）
  - [ ] 3.3 SQLConsole 组件
  - [ ] 3.4 WALViewer 组件
  - [ ] 3.5 CLOGViewer 组件
  - [ ] 3.6 WebSocket 客户端 hook
  - [ ] 3.7 Zustand 状态管理

### 下一步

**阶段三执行顺序：**
1. React + Vite + TypeScript 项目初始化（package.json, vite.config.ts）
2. 基础布局组件
3. SQLConsole 组件
4. WebSocket hook
5. WALViewer / CLOGViewer

### 备注

- 阶段一（项目初始化）和阶段二（Go后端P0）已完成
- 功能单元划分：Go后端6模块、React前端8模块、eBPF采集器4模块
- 每个任务完成后自动提交 GitHub

---

*最后更新：2026-03-30*