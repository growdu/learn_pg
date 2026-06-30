# 开发计划（plan.md）

最后更新：2026-05-11
状态：已建立（待执行）

## 1. 目标

将当前项目从“前端持有部分工作区数据 + 后端单全局连接”的实现，推进到“单用户本地工具下的后端真相源架构”。

本轮之后的主目标：

1. 浏览器只连后端，且不再长期保存工作区真数据和敏感凭据
2. 后端按节点维护连接状态，不再使用单全局数据库连接
3. 集群总览、快照、执行等观测接口以后端为准
4. 单机、主备、逻辑复制、宿主机发现都走真实任务执行链
5. 建立自动化回归与联调基线

## 2. 当前基线

### 2.1 已有能力

- 工作区：项目 / 集群 / 节点 / 组件
- 后端数据库连接能力
- 集群总览与节点观测页
- 工作区后端持久化

### 2.2 当前缺口

- 前端仍保存工作区缓存与连接 profile
- 后端仍偏单节点 / 单连接模型
- `overview` 仍依赖前端回传整套节点连接参数
- provision / discovery 尚未形成真实运行时闭环
- `Host / connectionStatus / task logs` 尚未进入稳定 schema
- provision 失败仍可能在前端生成本地假资源

## 3. 里程碑

## M0：文档与产品定位收口（P0，已完成）
状态：已完成

### 任务分解
1. 明确产品定位为单用户本地工具。
2. 明确后端统一连接、统一编排、统一观测。
3. 完成架构 review 并形成修改方向。
4. 补齐用户手册和运维手册。

### 验收标准
- 核心文档不再混淆“模板建模”和“真实拉起”。
- 当前能力、目标能力、限制条件边界清晰。

## M1：收回真相源到后端（P0，1 周）
状态：未开始

### 任务分解
1. 移除前端对工作区真数据的长期本地持久化依赖。
2. 移除前端对数据库密码、DSN、SSH 凭据的长期本地持久化。
3. 后端提供稳定的工作区读取与写入边界。
4. 前端只保留 UI 临时状态。

### 验收标准
- 刷新页面后工作区以后端数据为准。
- 浏览器本地不再保存数据库密码、DSN、SSH 凭据。

### 交付物
- `frontend/src/App.tsx`
- `frontend/src/components/connection/ConnectionManager.tsx`
- `backend/internal/api/workspace_store.go`

## M2：连接模型重构（P0，1 周）
状态：未开始

### 任务分解
1. 后端引入 `ConnectionManager`。
2. 将 `pgClient` 从单全局连接改为 `nodeId -> connection/session`。
3. 统一节点激活、连接校验、重连与失败状态。
4. 节点 schema 增加 `connectionStatus / lastError`。

### 验收标准
- 多节点切换不再互相覆盖连接。
- 当前激活节点与非激活节点状态可区分表达。
- `health / readyz / livez` 语义清晰。

### 交付物
- `backend/internal/connection/*`
- `backend/internal/api/handler.go`
- `backend/internal/api/workspace_store.go`
- `frontend/src/types/workspace.ts`

## M3：观测接口与资源边界改造（P0，1 周）
状态：未开始

### 任务分解
1. `cluster overview` 改为按 `projectId / clusterId` 查询。
2. `snapshot / execute` 改为按 `nodeId` 使用后端连接上下文。
3. 前端不再回传整套节点连接参数。
4. 前端节点与集群页改为按资源 ID 驱动。

### 验收标准
- overview 不再依赖前端上传节点密码。
- 观测接口与工作区资源模型一致。

### 交付物
- `backend/internal/api/handler.go`
- `frontend/src/components/workspace/ClusterHomeView.tsx`
- `frontend/src/App.tsx`

## M4：补齐数据模型（P1，1 周）
状态：已完成

### 任务分解
1. 增加 `WorkspaceHost`。
2. 增加 `WorkspaceNode.connectionStatus / hostId / lastError`。
3. 增加任务的 `taskType / result / logs`。
4. 为 schema 升级增加迁移逻辑。

### 验收标准
- 目标文档中的核心对象都进入真实 schema。
- 前后端类型与持久化结构一致。

### 交付物
- `backend/internal/api/workspace_store.go`
- `frontend/src/types/workspace.ts`
- `docs/design.md`

## M5：单机 provision 真实闭环（P0，1 周）
状态：未开始

### 任务分解
1. 抽出 `ProvisionService` 和 `docker provider`。
2. 打通 `POST /api/provision/single` 真实执行链。
3. 任务完成后写回工作区并触发连接校验。
4. 前端展示真实任务状态与跳转。

### 验收标准
- 点击“创建单机”后，可真实拉起 PostgreSQL。
- 成功后自动进入观测。
- 失败时任务含步骤错误信息。

### 交付物
- `backend/internal/provision/*`
- `backend/internal/tasks/*`
- `backend/internal/api/provision_discovery.go`
- `frontend/src/components/workspace/TemplateDialog.tsx`

## M6：主备与逻辑复制闭环（P1，2 周）
状态：未开始

### 任务分解
1. 打通 `POST /api/provision/physical`。
2. 打通 `POST /api/provision/logical`。
3. 自动校验复制 / 订阅状态。
4. 将真实指标接入集群总览与拓扑图。

### 验收标准
- 主备与逻辑复制拉起后可进入真实观测状态。
- 集群页可看到真实复制指标。

### 交付物
- `backend/internal/provision/*`
- `frontend/src/components/workspace/ClusterHomeView.tsx`

## M7：宿主机自动发现与导入（P0，1 周）
状态：未开始

### 任务分解
1. 引入 `Host` 资源接口。
2. 抽出 `HostDiscoveryService`。
3. 通过 SSH 扫描 PostgreSQL 实例信息。
4. 支持将扫描结果导入为节点并进入观测。

### 验收标准
- 添加一台机器后，可看到实例列表。
- 用户可导入实例并进入观测。

### 交付物
- `backend/internal/discovery/*`
- `backend/internal/api/*host*`
- `frontend/src/components/workspace/*`

## M8：删除错误 fallback 与补自动化（P1，1 周）
状态：未开始

### 任务分解
1. 删除 provision 失败后的本地模板 fallback。
2. 增加 workspace / provision / discovery / overview 契约测试。
3. 增加关键流程 E2E：
- 手动接入数据库节点
- 节点切换
- 单机 provision
- 宿主机导入
4. 增加联调检查清单。

### 验收标准
- 失败就是明确失败，不再生成假资源。
- 至少 6 条主链路自动化用例稳定通过。

### 交付物
- `frontend` E2E 测试
- `backend` API 测试
- `docs/user-manual.md`
- `docs/ops.md`

## 4. 排期建议

- 第 1 周：M1
- 第 2 周：M2
- 第 3 周：M3
- 第 4 周：M4
- 第 5 周：M5
- 第 6-7 周：M6
- 第 8 周：M7
- 第 9 周：M8

## 5. 风险与应对

1. 当前单连接模型阻塞多节点观测
- 应对：优先完成 M2

2. 前端仍持有工作区和凭据导致状态漂移
- 应对：优先完成 M1

3. Docker / 本机环境差异影响 provision 成功率
- 应对：先锁定 `docker` provider 为 MVP

4. SSH 扫描稳定性与权限问题
- 应对：先做 Linux + SSH MVP

5. 复制初始化流程复杂
- 应对：单机 -> 主备 -> 逻辑复制按顺序推进

## 6. 回滚策略

- 每个里程碑独立提交
- 前端保留“手动添加数据库节点”作为兜底入口
- provision / discovery 在真实闭环完成前不替换手动主链路

## 7. 完成定义（DoD）

1. 工作区、连接状态、任务状态以后端为唯一真相源
2. 浏览器不再长期保存数据库密码、DSN、SSH 凭据
3. 多节点观测基于 `nodeId` 连接注册表稳定运行
4. 手动接入、一键拉起、宿主机导入三类入口都能走通
5. 自动化用例覆盖核心主链路

## 8. 计划维护记录

- 2026-05-11：完成单用户本地工具架构 review。
- 2026-05-11：基于 review 结果重写实施方案与开发计划。
- 2026-05-12：M4 完成 — WorkspaceHost 类型、Hosts 数组、provisionTask 字段补全、Host/Task CRUD API、前端类型。
- 2026-05-12：M5 完成 — ProvisionService Provider 抽象、DockerProvider、LocalProvider、ServeProvisionSingle 重构、ServeClusterTeardown 端点、前端 Task 面板。
- 2026-05-12：M1 完成 — workspace_store 增量读写、workspace_crud 资源式 CRUD、API 密码脱敏返回、前端移除 localStorage workspace/profile 持久化。
- 2026-05-14：M8 完成 — 删除 provision fallback、TemplateDialog 增加 preview/create 模式选择、Playwright E2E 测试骨架、docker-compose.e2e.yml、后端 API 单元测试、ops.md 联调检查清单。
- 2026-06-24：修复 host_crud.go 闭包返回值编译错误、clog/wal 测试数据错误（WAL magic 未写入、TransactionsPerSegment 大小写、HEAP3/OP_16 期望值）。
- 2026-06-29：M9 完成 — 客户端遥测（error reporter + Web Vitals + fetch/WS breadcrumbs）、后端持久化去重 + 时间窗查询、CI 切分（backend-smoke / compose-smoke / e2e）、前端切到 pnpm + 真 lockfile、WS 与 HTTP 统一走 CORS allowlist、ops.md E2E 章节刷新。

## M9：可观测性、回归基线与发布硬化（P1，1 周）
状态：已完成

> 这一里程碑在 M0–M8 全部跑通之后补做，没有引入新业务能力，
> 目的是把"已完工的能力"补成可观测、可回归、可发布的形态。
> 原计划未单独列项，事后补登。

### 任务分解
1. 客户端错误与性能数据接入：
   - `errorReporter` + `Web Vitals` 上报到 `/api/telemetry/{errors,vitals}`。
   - fetch / WebSocket 包装器加 request-id、retry、timeout、breadcrumb。
   - 前端加 `ErrorBoundary` 作为根 fallback。
2. 后端遥测存储：
   - 文件落地 + sha256 去重（`telemetrystore`）。
   - 时间窗查询接口（`since`、`limit`），用于 admin/dashboard 调阅。
3. CI 流水线分层：
   - `tests`（go test / vitest / vet / race / compose-validate）独立于 push。
   - `backend-smoke` job：起后端 + `/health` `/readyz` 探活。
   - `compose-smoke` job：dev + prod compose 端到端起停。
   - `e2e` job：Playwright 套件接入。
4. 前端工程化：
   - 切到 pnpm，提交真 `pnpm-lock.yaml`，Dockerfile 走 `--frozen-lockfile`。
   - 去掉无用的 lint 脚本，引入 `typecheck`。
5. 安全收口：
   - CORS 走 `CORS_ALLOWED_ORIGINS` allowlist（带凭据感知）。
   - WebSocket 升级器复用同一 allowlist。
   - 敏感操作走 audit log channel。

### 验收标准
- 浏览器发生未捕获错误时，后端 `/api/telemetry/errors` 收到一条事件，且
  同一错误堆叠只入一次（去重按 sha256(msg|stack|url)）。
- `pnpm install --frozen-lockfile` 在干净环境能复现前端依赖。
- `actions` 上 4 个 job（tests / backend-smoke / compose-smoke / e2e）独立可跑。
- WS 与 HTTP 入口在生产配置下拒绝非同源 upgrade。

### 交付物
- `frontend/src/lib/{errorReporter,webVitals,api,fetchWithRetry}.ts`
- `frontend/src/components/common/ErrorBoundary.tsx`
- `backend/internal/telemetrystore/*`
- `backend/internal/reporter/*`（接收端）
- `backend/internal/auditlog/*`
- `.github/workflows/ci.yml`（分层 job）
- `frontend/Dockerfile`（pnpm + frozen lockfile）
- `docker-compose.{dev,prod,e2e}.yml`（smoke 验证）
- `docs/ops.md`（E2E 章节刷新）
- `scripts/{dev-smoke,prod-smoke}.sh`

---

## 9. 当前进度摘要

- M0：100%（已完成）
- M1：100%（已完成）
- M2：100%（已完成）
- M3：100%（已完成）
- M4：100%（已完成）
- M5：100%（已完成）
- M6：100%（已完成）
- M7：100%（已完成）
- M8：100%（已完成）
- M9：100%（已完成，2026-06-29 收口）
