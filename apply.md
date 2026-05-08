# 实现文档（apply.md）

## 1. 目标
在现有“多项目-多集群-多节点观测”基础上，补齐“自动交付观测”能力：
1. 自动拉起单机（1 节点）并自动连接
2. 自动拉起物理复制集群并自动连接
3. 自动拉起逻辑复制集群并自动连接
4. 支持机器探测接入与 DSN 接入已有数据库

## 2. 实现范围（本轮）
本轮先完成文档与接口契约，下一轮进入代码实现。

### 2.1 规划实现能力
- Provisioning：模板拉起 + 自动建模 + 自动连接
- Discovery：SSH 探测 + DSN 校验 + 导入观测
- Orchestration：任务状态跟踪与失败回滚策略

## 3. API 契约（待实现）

### 3.1 自动拉起
1. `POST /api/provision/single`
- 输入：`projectId`, `clusterName`, `runtime`
- 输出：`clusterId`, `nodeIds`, `autoConnectedNodeId`

2. `POST /api/provision/physical`
- 输入：`projectId`, `clusterName`, `runtime`, `topology`
- 输出：同上 + `taskId`

3. `POST /api/provision/logical`
- 输入：`projectId`, `clusterName`, `runtime`, `topology`
- 输出：同上 + `taskId`

4. `GET /api/provision/tasks/:taskId`
- 输出：`status`, `progress`, `message`, `result`

### 3.2 自动探测与接入
5. `POST /api/discovery/host/scan`
- 输入：`host`, `ssh(user/password/port)`
- 输出：`instances[]`

6. `POST /api/discovery/host/import`
- 输入：`projectId`, `clusterId`, `instance`, `autoConnect`
- 输出：`nodeId`, `connected`

7. `POST /api/discovery/dsn/validate`
- 输入：`dsn`
- 输出：`reachable`, `version`, `capabilities`

8. `POST /api/discovery/dsn/import`
- 输入：`projectId`, `clusterId`, `dsn`, `autoConnect`
- 输出：`nodeId`, `connected`

## 4. 前后端改造点（待实现）

### 4.1 后端
- 新增 `provision` handler 与 service：
  - 单机、物理、逻辑三类模板执行
  - 任务状态管理（ProvisionTask）
- 新增 `discovery` handler 与 service：
  - SSH 扫描
  - DSN 校验
- 与现有 `/api/connect`、`/api/cluster/overview` 集成

### 4.2 前端
- 项目主页新增“添加资源”入口：
  - 快速拉起：单机 / 物理 / 逻辑
  - 接入已有：机器探测 / 连接串
- 新增任务进度 UI（任务状态 + 日志摘要）
- 拉起完成后自动跳转到对应集群主页

### 4.3 数据结构
- `WorkspaceCluster` 增加 `provisionMode`, `provisionTaskId`, `runtime`
- `ClusterNodeConfig` 增加 `source`, `instanceMeta`, `sshHint`
- 新增 `ProvisionTask`, `DiscoveryInstance`

## 5. 实施步骤（下一轮代码）
1. 后端骨架：`/api/provision/*` 与 `/api/discovery/*` 路由 + 类型定义
2. 单机模板最小闭环（可用）
3. DSN 接入闭环（可用）
4. 物理复制模板
5. 逻辑复制模板
6. SSH 扫描接入

## 6. 验收标准
1. 选择单机模板可自动创建节点并连接成功
2. 物理/逻辑模板可生成正确集群拓扑并显示同步状态
3. 输入机器信息可探测到实例并导入观测
4. 输入 DSN 可校验并导入观测
5. 全流程失败有明确错误提示，不会污染工作区数据

## 7. 风险与应对
1. 环境差异（Docker/本机）
- 应对：先统一 Docker provider，后扩展 local provider。

2. SSH 探测稳定性
- 应对：超时控制、分步探测、错误分级提示。

3. 复制模板版本差异
- 应对：按 PG 版本分层参数模板，默认支持主流版本。

4. 凭据安全
- 应对：敏感字段最小化持久化，后续引入加密存储。
