# 进度日志 — PG Kernel Visualizer

---

## 2026-03-30

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
| 45a8d1d | 4.1-4.7 | Rust eBPF采集器（WS客户端、日志解析降级模式） |

**累计 9 次提交，已推送至 GitHub (growdu/learn_pg)**

### 进行中

- [ ] 阶段五：eBPF 采集器 P1
  - [ ] WAL Insert 探针
  - [ ] Buffer Pin 探针
  - [ ] 事务状态探针
  - [ ] Lock 探针
  - [ ] 实时事件上报

### 下一步

**阶段五执行顺序：**
1. 使用 Aya 框架实现 WAL Insert 探针
2. 实现 Buffer Pin / Buffer Alloc 探针
3. 实现事务状态探针（begin/commit/abort）
4. 实现 Lock 探针
5. 与后端 WebSocket 集成

### 备注

- P0（项目初始化 + Go后端 + React前端）已全部完成
- 阶段四（eBPF采集器）已实现基础框架，降级模式可用
- 每个任务完成后自动提交 GitHub

---

*最后更新：2026-03-30*