# 进度日志 — PG Kernel Visualizer

---

## 2026-03-30

### 完成

- [x] 创建 `design.md` — 概要设计
  - 系统架构：前端(React+D3) + WebSocket + Go后端 + Rust eBPF
  - 6大功能模块设计
  - 技术选型确定

- [x] 创建 `README.md` — 详细设计
  - 完整技术栈选型
  - 模块详细设计（WAL/CLOG/事务/Pipeline）
  - 数据模型与 API
  - 云原生部署设计（Docker Compose + K8s）
  - P0~P5 实施计划

- [x] 创建 `task_plan.md` — 任务规划
  - 6个阶段，30+ 个任务
  - 决策记录

- [x] 创建 `findings.md` — 研究发现
  - PG 18 探针方案对比
  - WAL/CLOG 文件格式
  - 架构决策记录
  - 待验证假设清单

- [x] 更新 PG 版本为 postgres:18（所有位置）

### 进行中

- [ ] 阶段一：项目初始化
  - [ ] 1.1 创建项目目录结构
  - [ ] 1.2 Git 初始化
  - [ ] 1.3 Docker Compose 开发环境
  - [ ] 1.4 .env.example

### 下一步

**阶段一任务执行顺序：**
1. 创建完整目录结构（符合 README.md 第9节）
2. Git init + .gitignore + 初始提交
3. 配置 docker-compose.dev.yml
4. 验证 postgres:18 可启动

### 备注

- 功能单元划分：Go后端6模块、React前端8模块、eBPF采集器4模块
- 每个任务完成后自动提交 GitHub
- GitHub 仓库待初始化

---

*最后更新：2026-03-30*