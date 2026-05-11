# PG Kernel Visualizer — 文档索引

PostgreSQL 内核学习与可视化观测平台文档。

---

## 快速导航

| 文档 | 说明 |
|------|------|
| [design.md](./design.md) | 系统设计：信息架构、页面结构、API 设计 |
| [plan.md](./plan.md) | 开发计划与里程碑（当前进度 M4） |
| [apply.md](./apply.md) | 实现记录：Provisioning、Discovery API 契约 |
| [FAQ.md](./FAQ.md) | 常见问题：Nginx 502、WebSocket、CLOG/WAL 故障排查 |
| [findings.md](./findings.md) | 技术调研：eBPF 方案、PG Wire Protocol、踩坑记录 |
| [planning.md](./planning.md) | 任务规划与进度日志（历史记录） |
| [deploy.md](./deploy.md) | Docker Compose / K8s 部署指南 |
| [manual-deploy.md](./manual-deploy.md) | Linux 手动部署指南（nginx + 后端 + PostgreSQL） |
| [ops.md](./ops.md) | 运维手册：日志、监控、备份、扩缩容 |

---

## 项目概览

**learn_pg** 是一个面向 PostgreSQL 内核学习与观测的可视化平台。

### 核心能力

1. **工作区管理** — 项目 → 集群 → 节点 → 组件分层结构
2. **集群观测** — 物理复制 / 逻辑复制拓扑可视化，LSN 与 lag 指标
3. **节点专题** — SQL、WAL、CLOG、Buffer 热图、锁等待图、事务状态、内存结构、执行计划树
4. **实时事件流** — WebSocket 推送 + eBPF 采集（降级：日志解析）

### 技术栈

- **前端**：React 18 + TypeScript + Vite + D3.js + Zustand
- **后端**：Go + gorilla/websocket + 自实现 PG Wire Protocol
- **采集器**：Rust + Aya eBPF 框架
- **数据库**：PostgreSQL 18
- **部署**：Docker Compose + nginx

### 开发里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1：复制链路指标细化 | ✅ 完成 | 物理/逻辑复制 LSN、lag 指标 |
| M2：工作区后端持久化 | ✅ 完成 | 后端 API + 前端同步 |
| M3：节点专题真实化 | ✅ 完成 | 锁图、事务、Buffer 等去除 demo 数据 |
| M4：自动化回归与联调基线 | ⏳ 进行中 | E2E 测试、接口契约、联调脚本 |

---

## 导航路径示例

```
项目主页
  └─ 集群主页
       ├─ 拓扑图 [双击节点] → 节点详情页
       │    ├─ SQL 控制台        [返回集群]
       │    ├─ WAL 查看         [返回集群]
       │    ├─ CLOG 查看        [返回集群]
       │    ├─ 写入链路         [返回集群]
       │    ├─ 读取链路         [返回集群]
       │    ├─ 事务链路         [返回集群]
       │    ├─ Buffer 热图      [返回集群]
       │    ├─ 锁等待图         [返回集群]
       │    ├─ 内存结构         [返回集群]
       │    ├─ 执行计划树        [返回集群]
       │    └─ 事务状态机        [返回集群]
       └─ 组件主页 → 节点主页（循环）
```

---

*最后更新：2026-05-11*
