# 设计文档（design.md）

## 1. 设计原则
1. 整体优先：先看集群全局，再看节点细节。
2. 可观测优先：所有关键对象应有状态展示。
3. 渐进实现：先 Web MVP，后跨平台与深度内核采集。
4. 生长式界面：页面按数据出现动态增长，不展示无内容模块。

## 2. 信息架构

### 2.1 领域对象
- Project（项目）
- Cluster（集群）
- Node（节点）
- Component（组件）
- ProvisionTask（自动拉起任务）
- DiscoveryInstance（探测到的数据库实例）

### 2.2 层级关系
- Project 1..N Cluster
- Cluster 1..N Node
- Project 1..N Component
- Component N..N Cluster（通过 `linkedClusterIds`）

## 3. 页面结构

### 3.1 项目主页（Project Home）
职责：项目级入口与资源创建。
- 无项目：仅展示创建入口。
- 有项目后：展示项目列表、概览统计。
- 支持“添加资源”入口：快速拉起/接入已有数据库。

### 3.2 集群主页（Cluster Home）
职责：集群级状态与复制同步。
- 集群列表（选择/删除）
- 概览指标（总数、在线、异常）
- 复制拓扑图（物理/逻辑）
- 同步状态看板（后端轮询）
- 节点管理（增删改、激活）

### 3.3 组件主页（Component Home）
职责：组件与集群关系并联动下钻。
- 组件 -> 集群 -> 节点树
- 组件跨集群关系图
- 组件-集群关联矩阵

### 3.4 节点主页（Node Home）
职责：单节点观测入口。
- SQL / WAL / CLOG / 锁 / 事务 / 内存等

## 4. 自动拉起与接入设计

### 4.1 快速拉起能力
1. 单机模板（1 节点）
- 自动拉起 PostgreSQL。
- 自动创建节点配置。
- 自动执行连接并进入观测。

2. 物理流复制模板
- 自动拉起 primary + standby。
- 自动初始化复制参数（如 `wal_level`、`max_wal_senders`、`hot_standby`）。
- 自动生成集群拓扑并进入看板。

3. 逻辑复制模板
- 自动拉起 publisher + subscriber。
- 自动创建 publication/subscription。
- 自动校验订阅状态并进入看板。

### 4.2 接入已有数据库能力
1. 机器探测接入（IP + 登录凭据）
- 通过 SSH 扫描 PostgreSQL 实例。
- 识别端口、版本、数据目录、服务名。
- 选择实例导入并自动连接。

2. 连接串接入（DSN）
- 校验连通性与基础权限。
- 导入为节点并自动连接。

## 5. 后端接口设计

### 5.1 Provisioning API
- `POST /api/provision/single`
- `POST /api/provision/physical`
- `POST /api/provision/logical`
- `GET /api/provision/tasks/:taskId`

### 5.2 Discovery API
- `POST /api/discovery/host/scan`
- `POST /api/discovery/host/import`
- `POST /api/discovery/dsn/validate`
- `POST /api/discovery/dsn/import`

### 5.3 复用接口
- `POST /api/connect`
- `POST /api/cluster/overview`
- `GET /api/snapshot`

## 6. 数据结构变更

### 6.1 WorkspaceCluster
- `provisionMode?: "manual" | "single" | "physical" | "logical" | "discovered" | "dsn"`
- `provisionTaskId?: string`
- `runtime?: { type: "docker" | "local"; pgVersion?: string }`

### 6.2 ClusterNodeConfig
- `source?: "provisioned" | "discovered" | "dsn" | "manual"`
- `instanceMeta?: { service?: string; dataDir?: string; version?: string }`
- `sshHint?: { host?: string; port?: number; user?: string }`

### 6.3 ProvisionTask
- `id, type, status, progress, message, createdAt, updatedAt, result`

### 6.4 DiscoveryInstance
- `host, port, version, dataDir, service, confidence`

## 7. 交互流程（摘要）
1. 创建项目
2. 添加资源
3. 选择：快速拉起（单机/物理/逻辑）或接入已有（机器探测/DSN）
4. 自动创建集群/节点并连接
5. 进入集群主页与节点观测

## 8. 边界与约束
- 当前阶段默认以单机开发环境（Docker 或本机）为优先。
- SSH 探测需具备目标主机连接权限。
- 物理/逻辑复制模板优先实现同机多实例，跨机部署后续扩展。

## 9. 后续演进
1. 拉起器抽象多 provider（docker/local/k8s）
2. 自动回收与生命周期管理
3. 多租户与凭据安全托管
4. Tauri 桌面化统一部署
