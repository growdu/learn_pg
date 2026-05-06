# learn_pg

PostgreSQL 内核学习与可视化观测项目。

当前定位：**Web MVP（多项目/多集群/多节点）+ 部分真实采集能力**。

## 1. 当前状态（务实口径）

已具备：
- 项目/集群/节点/组件分层工作区
- 物理复制与逻辑复制模板化创建
- 集群同步状态看板（后端接口驱动）
- 节点观测入口（SQL、WAL、CLOG、锁、事务、内存等）

仍在完善：
- 部分专题页仍含 demo 数据
- 项目配置后端持久化
- 跨平台 Tauri 完整产品化闭环

## 2. 核心页面结构

- 项目主页：项目级拓扑总览
- 集群主页：复制拓扑 + 同步状态 + 节点管理
- 组件主页：组件-集群关系图 + 关联矩阵
- 节点主页：单节点观测模块入口

## 3. 快速启动

### 3.1 前端
```bash
cd frontend
npm install
npm run dev
```

### 3.2 后端
```bash
cd backend
go run ./cmd/server
```

> 说明：如需完整构建请先确保 Node/npm 环境可联网安装依赖。

## 4. 关键接口

- `POST /api/connect`：激活节点连接
- `POST /api/cluster/overview`：集群总览与同步状态
- `POST /api/cluster/node/inspect`：单节点探测

## 5. 文档索引

- 需求文档：[need.md](./need.md)
- 设计文档：[design.md](./design.md)
- 实现文档：[apply.md](./apply.md)
- 进度文档：[progress.md](./progress.md)

## 6. 路线建议

1. 把节点专题页逐步从 demo 数据替换为真实数据源。
2. 完成项目/集群配置后端持久化。
3. 在 Web MVP 稳定后推进 Tauri 桌面端整合。
