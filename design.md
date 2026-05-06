# 设计文档（design.md）

## 1. 设计原则
1. 整体优先：先看集群全局，再看节点细节。
2. 可观测优先：所有关键对象应有状态展示。
3. 渐进实现：先 Web MVP，后跨平台与深度内核采集。

## 2. 信息架构

### 2.1 领域对象
- Project（项目）
- Cluster（集群）
- Node（节点）
- Component（组件）

### 2.2 层级关系
- Project 1..N Cluster
- Cluster 1..N Node
- Project 1..N Component
- Component N..N Cluster（通过 `linkedClusterIds`）

## 3. 页面结构

### 3.1 项目主页（Project Home）
职责：展示项目级总览与对象关系。
- 项目列表（选择/删除）
- 项目拓扑总览（集群+节点、组件+关联）
- 模板化创建入口

### 3.2 集群主页（Cluster Home）
职责：展示集群级状态与复制同步。
- 集群列表（选择/删除）
- 概览指标（总数、在线、异常）
- 复制拓扑图（物理/逻辑）
- 同步状态看板（后端轮询）
- 节点管理（增删改、激活）

### 3.3 组件主页（Component Home）
职责：展示组件与集群关系并提供联动下钻。
- 组件 -> 集群 -> 节点树
- 组件跨集群关系图
- 组件-集群关联矩阵
- 组件详情卡片

### 3.4 节点主页（Node Home）
职责：承载单节点观测模块入口。
- SQL / WAL / CLOG / 锁 / 事务 / 内存等视图导航

## 4. 数据与接口设计

### 4.1 前端核心类型
- `WorkspaceProject`
- `WorkspaceCluster`
- `WorkspaceComponent`
- `ClusterNodeConfig`

### 4.2 模板参数
- `nodeCount`
- `alertThresholdSec`
- `createCollector/createAnalyzer/createStorage`
- `componentNamePattern`

### 4.3 后端接口（已对接）
- `POST /api/connect`：激活某节点连接
- `POST /api/cluster/overview`：返回集群同步状态总览
- `POST /api/cluster/node/inspect`：单节点状态探测（可继续增强）

## 5. 交互设计

### 5.1 下钻路径
- 项目主页 -> 集群主页 -> 节点主页
- 组件主页 -> 关系图点击集群 -> 节点主页

### 5.2 可视化交互
- 复制拓扑图支持点击边（链路详情）
- 复制拓扑图支持点击节点（高亮）
- 组件关系图支持组件聚焦与集群跳转

## 6. 同步状态策略
- 轮询模式：每 5 秒请求 `/api/cluster/overview`
- 本地聚合：按选中集群过滤节点状态
- 容错：请求失败显示错误并保留上次数据

## 7. 边界与约束
- 当前为 Web MVP，不承诺 Tauri 主流程已可用。
- 部分节点内视图仍含 demo 数据，需在后续版本替换为真实数据源。
- 当前项目/集群配置主要在前端状态与本地存储，后续建议后端持久化。

## 8. 后续演进
1. 拓扑边指标细化（LSN/lag/sync_state）
2. 项目级后端持久化
3. 多用户与权限
4. Tauri 桌面化封装与统一分发
