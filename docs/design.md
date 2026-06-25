# 设计文档（design.md）

## 1. 设计原则

1. 后端统一代理：前端只连后端，不直连数据库或宿主机。
2. 先接入、后观测：所有资源必须先进入工作区，再进入观测链路。
3. 任务化执行：拉起、扫描、导入都走任务状态机，不做隐式长耗时操作。
4. 生长式界面：页面按数据出现动态增长，不展示伪造数据。

## 1.1 产品定位约束

当前产品定位明确为：**单用户本地工具**。

这意味着：
- 默认部署形态是“本机前端 + 本机后端 + 本机 Docker / 本机 PostgreSQL / 可选远程宿主机”。
- 不考虑多用户共享同一个后端服务。
- 不引入租户、权限、审计、配额等平台级能力。
- 可以接受“进程内任务编排 + 本地文件持久化”作为第一阶段实现。

## 2. 总体架构

### 2.1 逻辑拓扑

```text
┌──────────────────────┐
│     Browser UI       │
│ React + TS + Vite    │
└──────────┬───────────┘
           │ HTTP / WS
┌──────────▼───────────┐
│     Backend API      │
│ Go + Task Orchestr.  │
├──────────┬───────────┤
│ ConnMgr  │ Workspace │
│ Snapshot │ TaskStore │
│ Overview │ Events    │
└─────┬────┴──────┬────┘
      │           │
      │           ├──────────────┐
      │           │              │
┌─────▼─────┐ ┌───▼────────┐ ┌───▼──────────┐
│PostgreSQL │ │Host Scan    │ │Collector /   │
│Wire Client│ │SSH / Agent  │ │eBPF / Logs   │
└───────────┘ └─────────────┘ └──────────────┘
```

### 2.2 架构边界

- 前端负责：工作区操作、任务展示、观测页面渲染。
- 后端负责：数据库连接、集群拉起、宿主机扫描、实例导入、状态持久化。
- 采集器负责：实时内核级事件采集，无法启用时降级为日志解析。
- 浏览器不保存数据库密码、DSN、SSH 凭据作为长期真相数据。
- 后端是资源配置、连接状态、任务状态的唯一真相源。

## 3. 领域对象

### 3.1 核心对象

- `Project`：项目根对象
- `Cluster`：数据库集群
- `Node`：数据库实例节点
- `Component`：与集群关联的外部组件
- `Host`：运行 PostgreSQL 的宿主机
- `ProvisionTask`：一键拉起任务
- `DiscoveryTask`：宿主机扫描 / 导入任务
- `DiscoveryInstance`：扫描发现的数据库实例

### 3.2 关键关系

- `Project 1..N Cluster`
- `Cluster 1..N Node`
- `Project 1..N Component`
- `Project 1..N Host`
- `Host 1..N DiscoveryInstance`

## 4. 用户流设计

### 4.1 手动添加数据库节点

1. 用户选择项目 -> 新建集群 / 进入已有集群
2. 填写数据库节点连接参数
3. 后端执行连接校验
4. 校验成功后写入工作区并设为可观测节点
5. 前端跳转到集群主页 / 节点观测页

### 4.2 一键拉起单机 PostgreSQL

1. 用户在项目页点击“创建单机”
2. 前端调用 `POST /api/provision/single`
3. 后端创建任务并选择 runtime provider
4. provider 拉起数据库实例并返回连接信息
5. 后端写入 `Cluster / Node`
6. 后端自动执行连接校验
7. 前端通过任务状态刷新工作区并进入观测

### 4.3 一键拉起主备复制集群

1. 用户点击“创建主备集群”
2. 后端创建 `primary + standby`
3. 后端初始化复制参数、用户、槽位、`pg_hba.conf`
4. 后端验证复制链路与关键指标
5. 前端进入集群主页并展示复制拓扑

### 4.4 一键拉起逻辑复制集群

1. 用户点击“创建逻辑复制集群”
2. 后端创建 `publisher + subscriber`
3. 后端初始化 publication / subscription
4. 后端校验订阅状态、LSN、`latest_end_time`
5. 前端进入逻辑复制观测页面

### 4.5 添加宿主机并自动发现实例

1. 用户录入宿主机地址与 SSH 凭据
2. 后端创建 `Host`
3. 后端发起扫描任务
4. 后端探测 PostgreSQL 进程、端口、版本、数据目录、服务名
5. 用户选择实例导入，或按策略自动导入
6. 导入后的实例成为 `Node`，进入统一观测链路

## 5. 后端模块设计

### 5.1 Connection Manager

职责：
- 统一维护数据库连接生命周期
- 节点激活、重连、切换当前观测目标
- 为 `snapshot / execute / overview` 提供连接上下文

原则：
- 连接状态以节点为单位管理
- 密码只在后端使用
- 连接失败不污染已存在节点元数据
- 单用户模式下不需要复杂连接池，优先实现 `nodeId -> connection/session` 注册表
- 非活跃节点可按需连接，避免长期维持所有节点的活跃会话

### 5.2 Provision Orchestrator

职责：
- 接收单机 / 主备 / 逻辑复制拉起请求
- 选择 `docker / local` provider
- 管理任务进度、日志、结果、回滚

建议阶段：
- Phase 1：`docker` provider 优先
- Phase 2：视实际需要补 `local` provider
- Phase 3：抽象 `k8s` provider

单用户本地工具下的收敛建议：
- 当前只承诺 `docker` provider 为可用 MVP
- `k8s` 不进入近期实现范围
- `local` provider 仅在 Docker 无法满足时再补

### 5.3 Host Discovery Service

职责：
- 管理宿主机资源
- 执行 SSH / agent 扫描
- 输出 `DiscoveryInstance`
- 支持将实例导入工作区节点

### 5.4 Workspace Store

职责：
- 持久化 `Project / Cluster / Node / Component / Host / Task`
- 提供版本迁移能力
- 保证任务执行与工作区状态一致

实现建议：
- 第一阶段允许使用本地 JSON 文件
- 写入必须是后端原子写
- 前端不再整包覆盖工作区，只通过后端资源接口修改

## 6. API 设计

### 6.1 已有 / 保留接口

- `POST /api/connect`
- `POST /api/cluster/overview`
- `GET /api/snapshot`
- `GET /api/workspace/projects`
- `PUT /api/workspace/projects`

优化建议：
- 中期应逐步减少 `PUT /api/workspace/projects` 这种整包写入方式
- 演进到按资源的增删改接口，例如：
  - `POST /api/projects`
  - `POST /api/projects/:id/clusters`
  - `POST /api/clusters/:id/nodes`
  - `PATCH /api/nodes/:id`

### 6.2 Provisioning API

- `POST /api/provision/single`
- `POST /api/provision/physical`
- `POST /api/provision/logical`
- `GET /api/provision/tasks/:taskId`
- `GET /api/provision/tasks`

接口语义要求：
- 返回任务 ID
- 返回创建出的资源 ID
- 明确区分“元数据创建成功”和“数据库已真正可观测”

### 6.3 Host / Discovery API

建议补齐宿主机资源层：

- `GET /api/workspace/hosts`
- `POST /api/workspace/hosts`
- `DELETE /api/workspace/hosts/:id`
- `POST /api/hosts/:id/scan`
- `GET /api/hosts/:id/instances`
- `POST /api/hosts/:id/import`

若保留低层 discovery 接口，也应满足：

- `POST /api/discovery/host/scan`
- `POST /api/discovery/host/import`
- `POST /api/discovery/dsn/validate`
- `POST /api/discovery/dsn/import`

### 6.4 任务状态

统一状态枚举：
- `pending`
- `running`
- `success`
- `failed`
- `rolled_back`

统一字段建议：
- `taskId`
- `taskType`
- `status`
- `progress`
- `message`
- `result`
- `startedAt`
- `finishedAt`

单用户本地工具下的实现建议：
- 任务执行器可以直接运行在后端进程内
- 不需要引入外部消息队列
- 任务日志可以追加写入本地文件或内存 + 落盘

## 7. 数据结构建议

### 7.1 WorkspaceCluster

- `provisionMode?: "manual" | "single" | "physical" | "logical" | "host-import" | "dsn"`
- `provisionTaskId?: string`
- `runtime?: { type: "docker" | "local"; pgVersion?: string }`

### 7.2 WorkspaceNode

- `source?: "manual" | "provisioned" | "host-import" | "dsn"`
- `connectionStatus?: "unknown" | "connecting" | "ready" | "failed"`
- `instanceMeta?: { service?: string; dataDir?: string; version?: string }`
- `hostId?: string`

### 7.3 WorkspaceHost

- `id, name, address, sshPort, sshUser`
- `status: "idle" | "scanning" | "ready" | "failed"`
- `lastScanAt`
- `lastError`

## 8. 约束与边界

- 第一阶段只保证单机开发机与 Docker 环境。
- 宿主机扫描优先支持 Linux + SSH。
- eBPF 仍然是增强能力，不阻塞基础接入与观测主链路。
- 当前不面向 SaaS / 多人协作 / 共享服务部署。

## 9. 后续演进

1. provider 抽象扩展到 `k8s`
2. 宿主机常驻 agent 模式
3. 凭据加密托管
4. 多租户与权限模型
5. Tauri 桌面端统一入口
