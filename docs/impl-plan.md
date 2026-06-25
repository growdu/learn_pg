# 详细实施计划（impl-plan.md）

最后更新：2026-05-11
状态：待评审

---

## 前提：代码基线摘要

### 后端（Go, backend/）

| 文件 | 当前职责 | 架构问题 |
|------|---------|---------|
| `internal/api/handler.go` | 所有 API Handler + 单全局 `pgClient` | `pgClient` 单实例，任意切换节点覆盖连接 |
| `internal/api/workspace_store.go` | JSON 文件全量读写 workspace | `appendCluster/appendNode` 全量读-改-写，无增量更新 |
| `internal/api/provision_discovery.go` | provision/discovery 接口 | 元数据拼装，无真实执行链 |
| `internal/pg/client.go` | 单 PG 连接封装（sql.DB 池） | 无 `nodeId -> connection` 注册表 |
| `cmd/server/main.go` | 入口 | 直接创建 `pg.Client` 注入 handler |

### 前端（React+TS, frontend/）

| 文件 | 当前职责 | 架构问题 |
|------|---------|---------|
| `src/App.tsx` | 工作区加载 + 路由 | `localStorage['pgv_workspace_projects']` 明文持久化完整凭据 |
| `src/components/connection/ConnectionManager.tsx` | 连接 profile 管理 | `localStorage['pgv_profiles']` 明文存储密码 |
| `src/stores/pgStore.ts` | 全局 PG 连接状态 | `PGConfig` 含明文 password |
| `src/components/workspace/ClusterHomeView.tsx` | 集群总览 | 节点激活时回传完整 `host/port/user/password/database` 到后端 |
| `src/types/workspace.ts` + `cluster.ts` | 类型定义 | 缺少 `connectionStatus`、`hostId`、`lastError` |
| `src/components/workspace/TemplateDialog.tsx` | Provision 入口 | 失败后有本地模板 fallback |

---

## M1：收回真相源到后端

**目标**：前端不再持有工作区真数据和敏感凭据，刷新页面后以 backend 为唯一真相源。

### 后端改动

**1. 新增资源式 CRUD 接口（`internal/api/workspace_crud.go` 新文件）**

```
POST   /api/projects                      # 创建项目
GET    /api/projects                     # 列出项目
GET    /api/projects/:id                 # 获取单个项目
PUT    /api/projects/:id                 # 更新项目（仅 name）
DELETE /api/projects/:id                # 删除项目

POST   /api/projects/:id/clusters        # 创建集群
PUT    /api/clusters/:id                # 更新集群
DELETE /api/clusters/:id                # 删除集群

POST   /api/clusters/:id/nodes           # 添加节点
PUT    /api/nodes/:id                   # 更新节点
DELETE /api/nodes/:id                   # 删除节点
```

节点更新接口需支持**脱敏读取**（GET 不返回 password，POST 凭据只在创建时写入后端存储，不回显）。

**2. 改造 `workspace_store.go`**

- 新增 `GetProject(id)`、`GetCluster(id)`、`GetNode(id)` 增量读取方法
- `appendCluster`/`appendNode` 内部使用增量写而非全量读写（先读目标 cluster/node，再写回）
- 内部方法加 `Locked` 后缀，调用方负责加锁

**3. 改造 `handler.go`**

- 删除前端直接调用 `PUT /api/workspace/projects` 整包写入的入口（或保留仅供迁移，标记 deprecated）
- 路由注册新的资源式接口

### 前端改动

**4. `App.tsx`**

```diff
- const STORAGE_KEY = 'pgv_workspace_projects'
- const TASK_STORAGE_KEY = 'pgv_provision_task'
- function loadProjects(): WorkspaceProject[] = localStorage.getItem(...)
- function saveProjects(projects: WorkspaceProject[]) = localStorage.setItem(...)

+ // 启动时只从 backend 加载，删掉所有 localStorage workspace 读写
+ async function loadProjectsFromBackend() // 已有，增强
- saveProjects() 调用 → 改为调用资源式 PUT/POST
```

**5. `ConnectionManager.tsx`**

```diff
- const STORAGE_KEY = 'pgv_profiles'
- function loadProfiles() = localStorage.getItem(...)
- function saveProfiles(profiles) = localStorage.setItem(...)

+ // profiles 只存内存，不持久化到 localStorage
+ // 连接成功后的凭据由 backend 保管，前端不再缓存
```

**6. `pgStore.ts`（store）**

```diff
interface PGConfig {
  host, port, user, database
- password  // 删除，或标记 deprecated，不再写入 localStorage
}
+ activeNodeId: string  // 当前激活的 nodeId
```

**7. `ClusterHomeView.tsx` 和所有观测组件**

- 移除所有直接回传 `node.password` 的代码
- 节点激活改为发送 `POST /api/nodes/:id/activate`（只需 nodeId），后端返回连接状态

### 验收

- 刷新页面后工作区以后端数据为准
- 浏览器 DevTools Application > Local Storage 中无 `pgv_workspace_projects` 和 `pgv_profiles` 键
- `pgv_provision_task` 仍可保留（任务状态是前端展示用的，不含敏感数据）

---

## M2：连接模型重构

**目标**：从单全局 `pgClient` 改为 `nodeId -> *pg.Client` 连接注册表，支持多节点独立连接。

### 后端改动

**1. 新建 `internal/connection/manager.go`**

```go
type Manager struct {
    mu       sync.RWMutex
    conns    map[string]*pg.Client   // nodeId -> active connection
    cfgStore map[string]*pg.Config  // nodeId -> connection config (for reconnect)
    active   atomic.String           // current active nodeId
}

func (m *Manager) Get(nodeId string) (*pg.Client, error)
func (m *Manager) Activate(nodeId string) error   // connect and set active
func (m *Manager) Deactivate(nodeId string) error  // close connection
func (m *Manager) GetActive() (string, *pg.Client)
func (m *Manager) Health(nodeId string) (status, error)
```

**2. 改造 `internal/pg/client.go`**

- `NewClient(config *Config)` 已存在，保持不变
- 可选增加 `Reconnect()` 方法供连接恢复使用

**3. 改造 `internal/api/workspace_store.go`**

- `workspaceNode` 新增字段：
  - `ConnectionStatus string` // `"unknown" | "connecting" | "ready" | "failed"`
  - `LastError string`
  - `HostId string`
- `GetNodeConnectionConfig(nodeId)` 方法：从 workspace 中读取指定 node 的连接配置

**4. 改造 `internal/api/handler.go`**

```diff
type Handler struct {
    config    *config.Config
-   pgClient  *pg.Client        // 删除
+   connMgr   *connection.Manager  // 新增
    workspace *workspaceStore
    // ...
}
```

- 所有使用 `h.pgClient` 的方法改为 `h.connMgr.Get(nodeId)` 或 `h.connMgr.GetActive()`
- 新增 `ServeNodeActivate(w, r, nodeId)`：接收 nodeId，从 workspace 读取配置，建立连接，设为 active
- 新增 `ServeNodeStatus(w, r, nodeId)`：返回节点连接状态
- 改造 `ServeConnect`：改为调用 `connMgr.Activate(nodeIdFromRequest)` 或保持向后兼容

**5. 新建 `internal/api/node_handler.go`**

```
POST   /api/nodes/:id/activate    # 激活节点（后端从 workspace 读配置）
GET    /api/nodes/:id/status      # 查询连接状态
POST   /api/nodes/:id/deactivate  # 断开连接
```

### 前端改动

**6. `types/cluster.ts`**

```diff
interface ClusterNodeStatus {
+ connectionStatus: "unknown" | "connecting" | "ready" | "failed"
+ lastError?: string
}
```

**7. `types/workspace.ts`**

```diff
interface WorkspaceNode {
+ connectionStatus: string
+ hostId?: string
+ lastError?: string
}
```

**8. `ClusterHomeView.tsx`**

- 节点切换改为调用 `POST /api/nodes/:id/activate`（只传 nodeId）
- 展示各节点 `connectionStatus` badge
- 移除回传 `host/port/user/password/database` 的逻辑

**9. `pgStore.ts`**

```diff
interface PGState {
  connected: boolean
- config: PGConfig (含 password)
+ activeNodeId: string | null
}
```

---

## M3：观测接口与资源边界改造

**目标**：`cluster overview`、`snapshot`、`execute` 等接口不再依赖前端回传节点凭据，改为按 `nodeId` 或 `clusterId` 查询。

### 后端改动

**1. 改造 `/api/cluster/overview`**

```diff
# 当前：POST body 包含 requestNodes[]，每个节点含完整 host/port/user/password/database
# 改为：GET /api/cluster/:id/overview
# 后端内部从 workspace + connMgr 聚合数据
```

- 删除 `ServeClusterOverview` 中解析前端 `requestNodes` 的逻辑
- 新 `ServeClusterOverview`：从 workspace 找到 cluster，再对每个 node 从 `connMgr` 获取连接状态
- 新增 `InspectNode(nodeId)` 内部方法：用 `connMgr.Get(nodeId)` 执行必要查询

**2. 改造 `/api/snapshot`、`/api/execute`**

- `ServeSnapshot`：使用 `connMgr.GetActive()` 而非 `h.pgClient`
- `ServeExecute`：使用 `connMgr.GetActive()` 而非 `h.pgClient`

**3. 改造 WAL/CLOG 端点**

- `ServeWal`、`ServeWalSegments`、`ServeClogFile`：使用 `connMgr.GetActive()`

**4. 改造 `inspectClusterNode`（provision 中的临时连接）**

- 移除临时创建 `&pg.Client{}` 的模式
- 改为 `connMgr.Get(nodeId)` 或从 workspace 读取配置后 `connMgr.Activate(nodeId)`

### 前端改动

**5. `ClusterHomeView.tsx`**

```diff
# 原来：
POST /api/cluster/overview
body: { requestNodes: [{ host, port, user, password, database, name, id }] }

# 改为：
GET /api/cluster/:clusterId/overview
# 前端只传 clusterId，不传任何节点凭据
```

- `TemplateDialog.tsx` 中的 overview 调用同步修改

---

## M4：补齐数据模型

**目标**：`WorkspaceHost`、`Task` 结构进入稳定 schema。

### 后端改动

**1. `workspace_store.go` 扩展**

```go
// Host
type workspaceHost struct {
    ID         string `json:"id"`
    Name       string `json:"name"`
    Address    string `json:"address"`
    SSHPort    int    `json:"sshPort"`
    SSHUser    string `json:"sshUser"`
    Status     string `json:"status"` // idle|scanning|ready|failed
    LastScanAt int64  `json:"lastScanAt"`
    LastError  string `json:"lastError"`
}

type workspaceEnvelope struct {
    SchemaVersion int
    Projects      []workspaceProject
+   Hosts         []workspaceHost   // 新增
+   Tasks         []workspaceTask   // 新增
}
```

```go
// Task
type workspaceTask struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"taskType"`   // provision_single|provision_physical|provision_logical|discovery_host|discovery_dsn
    Status    string                 `json:"status"`     // pending|running|success|failed|rolled_back
    Progress  int                    `json:"progress"`   // 0-100
    Message   string                 `json:"message"`
    Result    map[string]interface{} `json:"result,omitempty"`
    Logs      []taskLogEntry         `json:"logs,omitempty"`
    CreatedAt int64                  `json:"createdAt"`
    UpdatedAt int64                  `json:"updatedAt"`
}

type taskLogEntry struct {
    Time    int64  `json:"time"`
    Level   string `json:"level"`   // info|warn|error
    Message string `json:"message"`
}
```

- workspaceNode 扩展字段：
  - `ConnectionStatus string`
  - `HostId string`
  - `LastError string`
- workspaceCluster 扩展字段：
  - `ProvisionMode string`（已有）
  - `Runtime *workspaceRuntime`（已有）

**2. 新建 `internal/api/host_handler.go`**

```
GET    /api/workspace/hosts
POST   /api/workspace/hosts
DELETE /api/workspace/hosts/:id
POST   /api/hosts/:id/scan
GET    /api/hosts/:id/instances
POST   /api/hosts/:id/import
```

**3. 新建 `internal/api/task_handler.go`**

```
GET    /api/tasks
GET    /api/tasks/:id
GET    /api/tasks/:id/logs   # 流式日志
```

**4. Schema 迁移逻辑（workspace_store.go）**

- 读取文件时检测 `SchemaVersion`
- v1 → v2：加入空 Hosts 和 Tasks 数组，为已有 nodes 补 connectionStatus="unknown"

### 前端改动

**5. `types/workspace.ts`**

```ts
export interface WorkspaceHost {
  id: string
  name: string
  address: string
  sshPort: number
  sshUser: string
  status: 'idle' | 'scanning' | 'ready' | 'failed'
  lastScanAt?: number
  lastError?: string
}

export interface WorkspaceTask {
  id: string
  taskType: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'rolled_back'
  progress: number
  message: string
  result?: Record<string, unknown>
  logs?: TaskLogEntry[]
  createdAt: number
  updatedAt: number
}

export interface WorkspaceNode {
  // ... existing
  connectionStatus?: string
  hostId?: string
  lastError?: string
}
```

**6. `stores/hostStore.ts`（新建）**：管理 hosts 状态（可选，取决于 UI 复杂度）

---

## M5：单机 provision 真实闭环

**目标**：点击"创建单机"真实拉起 Docker 容器并进入观测。

### 后端改动

**1. 新建 `internal/provision/service.go`**

```go
type Service struct {
    connMgr   *connection.Manager
    workspace *workspaceStore
    taskStore *taskStore   // 从 workspaceStore 中独立出来
    docker    *DockerProvider
}

func (s *Service) ProvisionSingle(ctx context.Context, req ProvisionSingleRequest) (*Task, error)
```

**2. 新建 `internal/provision/docker.go`**

```go
type DockerProvider struct{}

func (p *DockerProvider) CreateSingle(ctx context.Context, cfg SingleConfig) (*ProvisionResult, error) {
    // 1. docker run --name pg-xxx -e POSTGRES_PASSWORD=xxx -p 5432:5432 postgres:18
    // 2. 等待容器 running
    // 3. 返回 { nodeId, host: "localhost", port: 5432, user, password, database }
}

func (p *DockerProvider) Delete(name string) error {
    docker rm -f name
}
```

**3. 新建 `internal/tasks/store.go`**

```go
type taskStore struct {
    mu    sync.Mutex
    tasks map[string]*workspaceTask
    path  string
}

func (ts *taskStore) Create(t workspaceTask) error
func (ts *taskStore) Update(id string, fn func(*workspaceTask))
func (ts *taskStore) Get(id string) (*workspaceTask, error)
func (ts *taskStore) List() []workspaceTask
func (ts *taskStore) AppendLog(id, level, msg string)
```

**4. 改造 `internal/api/provision_discovery.go`**

- `ServeProvisionSingle`：
  1. 创建 `workspaceTask`（status=running）
  2. 调用 `provisionService.ProvisionSingle()`
  3. 成功后 `workspace.appendCluster()` + `workspace.appendNode()`
  4. 调用 `connMgr.Activate(nodeId)`
  5. 更新 task（status=success, result={clusterId, nodeIds}）
  6. 失败：更新 task（status=failed, logs=错误步骤）

### 前端改动

**5. `TemplateDialog.tsx`**

- provision 成功后删除本地模板 fallback
- 失败时只展示后端 task 错误信息，不生成假资源
- 新增任务进度轮询 UI（展示 progress / message）

**6. `App.tsx`**

- provision 成功后调用 `reloadWorkspaceFromBackend()` 刷新工作区
- 不再需要 `TASK_STORAGE_KEY` fallback

---

## M6：主备 + 逻辑复制闭环

### 后端改动

**1. `docker.go` 扩展**

```go
func (p *DockerProvider) CreatePhysical(ctx context.Context, cfg PhysicalConfig) (*ProvisionResult, error)
func (p *DockerProvider) CreateLogical(ctx context.Context, cfg LogicalConfig) (*ProvisionResult, error)
```

- Physical：启动 primary + standby 容器，配置 `wal_level=hot_standby`、replication slot、`pg_hba.conf` 授权
- Logical：创建 publication/subscription，验证 `pg_stat_subscription`

**2. `provision_discovery.go`**

- `ServeProvisionPhysical`：调用 `docker.CreatePhysical()`
- `ServeProvisionLogical`：调用 `docker.CreateLogical()`

**3. `workspaceStore.go`**

- cluster 的 `nodes` 支持多节点
- `ReplicationType` 字段覆盖 `physical` / `logical`

### 前端改动

**4. `ClusterHomeView.tsx`**

- 拓扑图展示多节点（primary + standby / publisher + subscriber）
- 接入真实复制指标（LSN lag、subscription 状态）

---

## M7：宿主机自动发现与导入

### 后端改动

**1. 新建 `internal/discovery/host.go`**

```go
type HostDiscoveryService struct {
    workspace *workspaceStore
    connMgr   *connection.Manager
}

func (s *HostDiscoveryService) Scan(ctx context.Context, host workspaceHost) ([]DiscoveredInstance, error) {
    // 1. SSH 连接（或 docker exec 在本机场景）
    // 2. 扫描 postgres 进程、端口 5432/5433
    // 3. 尝试连接验证版本
    // 4. 返回 []DiscoveredInstance{ port, version, dataDir, serviceName, user }
}

type DiscoveredInstance struct {
    ID       string
    Port     int
    Version  string
    DataDir  string
    User     string
    Password string  // 用于导入后自动连接
}
```

**2. `internal/api/host_handler.go` 实现**

- `ServeHostScan`：调用 `HostDiscoveryService.Scan()`
- `ServeHostImport`：调用 `workspace.appendNode()` + `connMgr.Activate()`

### 前端改动

**3. 新建 `HostManagementView.tsx` 或整合到 `ProjectHomeView.tsx`**

- 宿主机列表 + 状态
- "扫描" 按钮触发 `POST /api/hosts/:id/scan`
- 扫描结果展示 + "导入" 按钮

---

## M8：删除错误 fallback 与补自动化

### 后端改动

**1. 删除 `handler.go` 中 provision 失败后生成本地假资源的逻辑**

- 当前 provision 失败后前端有 fallback 生成模板资源的逻辑
- 后端应返回明确失败状态，前端据此不再 fallback

**2. 新增 API 测试（`backend/internal/api/api_test.go`）**

```go
func TestWorkspaceCRUD(t)
func TestNodeActivation(t)
func TestClusterOverview(t)
func TestProvisionSingle(t)
func TestProvisionPhysical(t)
func TestProvisionLogical(t)
func TestHostDiscovery(t)
```

### 前端改动

**3. 删除 `TemplateDialog.tsx` 中 provision 失败后的本地 fallback**

```diff
- // 删除整块 catch 块中生成本地资源的代码
```

**4. 新增 E2E 测试（`frontend/cypress/` 或 `playwright/`）**

```
e2e/
  workspace/
    manual-node-connect.spec.ts
    node-switch.spec.ts
    provision-single.spec.ts
    host-discovery.spec.ts
```

---

## 文件变更总览

```
backend/
  internal/
    api/
      handler.go           # M2: 移除 h.pgClient，改用 h.connMgr
      workspace_crud.go    # M1: 新文件，资源式 CRUD
      host_handler.go      # M4: 新文件，Host CRUD + scan + import
      task_handler.go      # M4: 新文件，Task 查询
      workspace_store.go   # M1+M4: 增量读写、Host/Task schema、迁移
      provision_discovery.go # M5: 改造为真实 provision
    connection/
      manager.go           # M2: 新文件，nodeId->connection 注册表
    provision/
      service.go           # M5: 新文件，provision 编排
      docker.go            # M5: 新文件，docker provider
    discovery/
      host.go              # M7: 新文件，SSH 扫描
    tasks/
      store.go             # M5: 新文件，task 持久化
  cmd/server/main.go       # M2: 创建 connMgr 并注入

frontend/
  src/
    App.tsx               # M1: 删除 localStorage workspace 持久化
    components/
      connection/
        ConnectionManager.tsx  # M1: 删除 localStorage profile 持久化
      workspace/
        ClusterHomeView.tsx    # M2+M3: 节点激活改用 nodeId
        TemplateDialog.tsx      # M5: 真实任务状态 + 删除 fallback
        HostManagementView.tsx # M7: 新文件（可选整合）
    stores/
      pgStore.ts           # M2: activeNodeId 替换 password
      hostStore.ts         # M4: 新文件（可选）
    types/
      workspace.ts         # M4: Host/Task 类型
      cluster.ts           # M2+M4: connectionStatus
```

---

## 实施顺序决策点

### 是否并发 M1+M2？

**建议串行：先 M1 再 M2。**

理由：M1 确立后端真相源后，M2 的 `ConnectionManager` 可以直接依赖 workspace 中已稳定存储的节点连接信息。反之若先做 M2（多连接支持），前端仍在 localStorage 存凭据，切换时凭据来源混乱。

### 是否 M3 和 M2 合并？

M3 依赖 M2 完成（`connMgr` 必须存在才能移除 `h.pgClient`），建议 M2 末尾开始 M3，M3 结束时 M2 收尾。

### M4 在 M5 前还是后？

M4 是数据模型补齐，M5 是 provision 真实闭环。M4 可以和 M5 并行开发（后端新增 Host/Task schema 不影响 provision 的 docker 调用），但前端类型定义上 M5 依赖 M4。**建议 M4 完全完成后再开始 M5 前端部分。**

### M6 在 M5 后还是并行？

M6 复用了 M5 的 `docker.go` 框架，可以**在 M5 完成后紧接着做 M6**，预计 2 周。M5 的 `docker.go` 需提前规划 `PhysicalConfig` / `LogicalConfig` 接口以便扩展。

### M7 的 SSH 依赖？

M7 依赖 SSH 库（建议 `golang.org/x/crypto/ssh`）。M7 与 M5/M6 可**并行开发**（使用不同的后端模块），只需确保 workspace schema 已支持 Host（M4 完成）。

---

## 排期细化（基于串行 + 关键并行）

| 周 | 任务 | 关键交付 |
|----|------|---------|
| 1 | M1 全部 | 资源式 CRUD、移除前端 localStorage 持久化 |
| 2 | M2 全部 + M3 前半 | connMgr、后端路由改造、overview 改造 |
| 3 | M3 后半 + M4 前半 | WAL/CLOG 改完、Host/Task schema |
| 4 | M4 后半 | Schema 迁移、前端类型 |
| 5 | M5 全部 | Docker provider、单机真实闭环 |
| 6-7 | M6 全部 | 主备+逻辑复制闭环 |
| 7-8 | M7 全部 | SSH 宿主机发现与导入 |
| 9 | M8 全部 | 删除 fallback、E2E、API 测试 |

**预计总工期：9 周**（与原计划一致）
