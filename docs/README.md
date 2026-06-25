# PG Kernel Visualizer — 文档索引

PostgreSQL 内核学习与可视化观测平台文档。

---

## 快速导航

| 文档 | 说明 |
|------|------|
| [need.md](./need.md) | 需求边界：前端只连后端，后端统一连接数据库与宿主机 |
| [design.md](./design.md) | 系统设计：接入方式、后端职责、任务编排、接口建议 |
| [apply.md](./apply.md) | 实施方案：当前差距、模块拆分、数据结构、落地顺序 |
| [plan.md](./plan.md) | 新阶段开发计划：一键拉起与宿主机自动观测 |
| [user-manual.md](./user-manual.md) | 用户手册：当前版本可用功能、使用步骤、限制说明 |
| [FAQ.md](./FAQ.md) | 常见问题：Nginx 502、WebSocket、CLOG/WAL 故障排查 |
| [findings.md](./findings.md) | 技术调研：eBPF 方案、PG Wire Protocol、踩坑记录 |
| [planning.md](./planning.md) | 历史任务规划与进度日志 |
| [deploy.md](./deploy.md) | Docker Compose / K8s 部署指南 |
| [manual-deploy.md](./manual-deploy.md) | Linux 手动部署指南（nginx + 后端 + PostgreSQL） |
| [ops.md](./ops.md) | 运维手册：单用户本地工具的启动、备份、排障、升级 |

---

## 项目概览

**learn_pg** 是一个面向 PostgreSQL 内核学习与观测的可视化平台。

### 当前架构口径

```text
Browser -> Backend -> PostgreSQL / Host Machine / Collector
```

- 前端只通过 HTTP / WebSocket 调用后端。
- 后端负责数据库连接、集群拉起、宿主机扫描、任务编排与状态汇总。
- 数据库节点不应由浏览器直连。

### 当前可用能力

1. **工作区管理** — 项目 -> 集群 -> 节点 -> 组件分层结构
2. **手动数据库接入** — 手动维护节点连接信息，由后端发起连接
3. **集群观测** — 复制拓扑、LSN / lag 指标、节点专题页
4. **实时事件流** — WebSocket 推送 + eBPF 采集（降级：日志解析）

### 目标补齐能力

1. **一键拉起单机 PostgreSQL** — 点击按钮即可创建并进入观测
2. **一键拉起主备复制集群** — 自动完成复制参数与拓扑建模
3. **一键拉起逻辑复制集群** — 自动完成 publication / subscription 初始化
4. **添加数据库宿主机** — 自动扫描 PostgreSQL 实例并导入观测

### 当前实施重点

| 方向 | 现状 | 目标 |
|------|------|------|
| 数据库接入 | 仅手动添加数据库节点 | 支持一键拉起与自动接入 |
| 主机接入 | 无稳定闭环 | 支持添加宿主机并自动扫描实例 |
| 任务编排 | 仅有接口原型/任务条 | 提供真实任务执行、进度、回滚 |
| 自动化测试 | 仅少量单测 | 建立 E2E、契约测试、联调脚本 |

### 文档使用建议

- 想了解当前能做什么：先看 [user-manual.md](./user-manual.md)
- 想了解架构与后续设计：看 [design.md](./design.md) 和 [apply.md](./apply.md)
- 想做本地运行、备份、排障：看 [ops.md](./ops.md)

---

*最后更新：2026-05-11*
