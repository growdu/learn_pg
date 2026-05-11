# 实施方案（apply.md）

## 1. 目标

围绕当前架构评审结论，将项目从“前端持有部分真相数据 + 后端单连接”收敛到“单用户本地工具下的后端真相源架构”。

核心目标：

1. 前端只负责 UI 与导航，不长期保存工作区真数据和敏感凭据
2. 后端按节点维护连接状态，不再使用单全局数据库连接
3. 集群总览、快照、执行等观测接口以后端工作区和连接注册表为准
4. provision / discovery 从占位接口演进为真实执行链
5. 宿主机、任务、连接状态进入稳定的数据模型

## 2. 架构评审结论

### 2.1 当前可用闭环

- 工作区管理已具备
- 手动添加数据库节点已具备
- 后端可基于节点配置建立数据库连接
- 集群 / 节点观测主链路已具备

### 2.2 当前主要架构问题

1. 前端仍持有工作区真数据与数据库凭据
2. 后端仍是单全局 `pgClient` 模型
3. `cluster overview` 依赖前端周期性回传整套节点连接信息
4. `provision / discovery` 仍主要是元数据拼装，不是真实编排
5. `Host / connectionStatus / task logs` 等目标模型尚未进入真实 schema
6. provision 失败后前端仍会本地 fallback 生成假资源

## 3. 总体实施策略

实施顺序遵循：

1. 先收回真相源到后端
2. 再重构连接模型
3. 再改造工作区与总览接口
4. 再补齐数据模型
5. 最后落地真实 provision / discovery 与自动化

单用户本地工具下的实现原则：

1. 不为了未来多租户预埋复杂平台抽象
2. 允许后端进程内维护任务执行器与连接注册表
3. 允许本地文件存储工作区与任务状态
4. 优先保证后端统一连接、统一持久化、统一观测

## 4. 模块拆分

### 4.1 后端

#### A. Workspace Source of Truth

职责：
- 持久化 `Project / Cluster / Node / Component / Host / Task`
- 提供稳定 schema 与迁移能力
- 作为前端工作区展示的唯一真相源

约束：
- 前端不再整包覆盖工作区
- 后端返回前端时默认脱敏

#### B. Connection Manager

职责：
- 为节点维护连接状态
- 支持激活、重连、切换当前观测目标
- 为 `connect / overview / snapshot / execute` 提供连接上下文

实现建议：
- 第一阶段做 `nodeId -> connection/session` 注册表
- 非活跃节点按需连接
- 连接失败不污染已存在节点元数据

#### C. Provision Runtime

职责：
- 根据模板创建单机 / 主备 / 逻辑复制拓扑
- 执行 PostgreSQL 初始化脚本
- 返回连接信息与集群结果

当前决策：
- 近期只承诺 `docker` provider
- `local` provider 作为后续扩展

#### D. Task Orchestrator

职责：
- 创建任务
- 记录进度、错误、步骤日志
- 失败时执行回滚或至少标记半完成状态

实现建议：
- 进程内执行
- 本地落盘
- 不依赖外部队列或分布式调度器

#### E. Host Discovery Service

职责：
- 维护宿主机资源
- 执行 SSH 扫描
- 生成 `DiscoveryInstance`
- 支持实例导入为工作区节点

### 4.2 前端

#### A. 资源接入入口

统一入口建议：
- 手动添加数据库
- 一键拉起单机
- 一键拉起主备
- 一键拉起逻辑复制
- 添加宿主机

重要限制：
- 前端只提交用户输入
- 前端不缓存数据库密码、DSN、SSH 凭据作为长期状态

#### B. 任务中心

要求：
- 展示任务状态、进度、耗时、错误
- 成功后自动刷新工作区
- 失败后给出重试与错误说明

#### C. 宿主机视图

建议补充：
- 宿主机列表
- 最近扫描结果
- 扫描到的 PostgreSQL 实例列表
- 一键导入按钮

### 4.3 数据结构

建议新增或补齐：

- `WorkspaceHost`
- `WorkspaceNode.connectionStatus`
- `WorkspaceNode.hostId`
- `WorkspaceNode.lastError`
- `Task.taskType`
- `Task.result`
- `Task.logs`

## 5. 分阶段落地

### Phase 0：文档与契约收口

输出：
- `README.md`
- `docs/need.md`
- `docs/design.md`
- `docs/apply.md`
- `docs/plan.md`
- `docs/user-manual.md`
- `docs/ops.md`

目标：
- 明确当前产品为单用户本地工具
- 明确当前稳定闭环只有手动接入数据库节点
- 明确当前后端真相源重构为第一优先级

### Phase 1：收回真相源到后端

后端：
- 保持工作区持久化由后端负责
- 新增脱敏输出与资源式写接口准备

前端：
- 停止把工作区和凭据整包长期保存在浏览器
- localStorage 仅保留 UI 临时状态

验收：
- 浏览器刷新后，工作区以后端数据为准
- 浏览器本地不再保存数据库密码、DSN、SSH 凭据

### Phase 2：连接模型重构

后端：
- 将连接状态从“单全局连接”提升到“按节点管理”
- 引入轻量 `ConnectionManager`
- 统一节点激活、连接测试、错误状态

前端：
- 明确节点连接状态展示
- 观测页面显式依赖当前激活节点

验收：
- 手动添加多个节点后，切换观测目标稳定可用
- 多节点切换不再互相覆盖连接

### Phase 3：工作区与观测接口改造

后端：
- `overview / snapshot / execute` 改为按 `clusterId / nodeId` 读取
- 后端从 `workspace + connectionManager` 聚合数据

前端：
- 不再构造 `requestNodes` 并回传整套节点连接参数
- 集群总览改为按资源 ID 查询

验收：
- `cluster overview` 不再依赖前端上传节点密码
- 观测接口与工作区资源边界一致

### Phase 4：补齐真实数据模型

后端：
- 扩展 workspace schema，加入 `Host / connectionStatus / task logs`

前端：
- 扩展 `workspace` 类型定义
- 节点列表可展示连接状态与错误

验收：
- 目标模型与真实 schema 一致
- 不再依赖页面临时状态承载宿主机或任务信息

### Phase 5：单机 provision 真实闭环

后端：
- 将 `POST /api/provision/single` 改为真实执行链
- 使用 `docker` provider 拉起 PostgreSQL
- 写回工作区并自动连接校验

前端：
- 展示单机拉起任务状态
- 成功后自动跳转观测页

验收：
- 点击按钮后可真实创建单机并进入观测

### Phase 6：主备与逻辑复制 provision 闭环

后端：
- 打通 `POST /api/provision/physical`
- 打通 `POST /api/provision/logical`
- 自动校验复制与订阅状态

前端：
- 展示主备 / 逻辑复制任务结果与拓扑

验收：
- 拉起后集群页可看到真实复制指标

### Phase 7：宿主机自动发现闭环

后端：
- 新增宿主机资源模型
- 实现 SSH 扫描与实例枚举
- 支持导入扫描结果为节点

前端：
- 新增宿主机管理页 / 对话框
- 支持导入扫描结果

验收：
- 添加一台机器后，至少能发现并导入一个 PostgreSQL 实例

### Phase 8：删除错误 fallback 与补自动化

后端：
- 补齐 workspace / provision / discovery / overview 契约测试

前端：
- 删除 provision 失败后的本地模板 fallback
- 增加关键流程 E2E

验收：
- 失败就是明确失败，不再生成假资源
- 手动接入、节点切换、单机拉起、宿主机导入可自动验证

## 6. 风险与应对

1. 当前单连接模型阻塞多节点观测
- 应对：优先完成 Phase 2，否则后续阶段风险都高

2. 前端仍持有工作区和凭据导致状态漂移
- 应对：优先完成 Phase 1，收回真相源到后端

3. Docker / 本机环境差异影响 provision 成功率
- 应对：先只承诺 `docker` provider 可用，再补 `local`

4. SSH 扫描稳定性不足
- 应对：先做 Linux + SSH MVP，再演进到 agent

5. 复制初始化步骤复杂
- 应对：单机先闭环，再拆主备和逻辑复制，不并行铺开

## 7. 完成定义

1. 文档口径与实现状态一致
2. 工作区、连接状态、任务状态以后端为唯一真相源
3. 浏览器不再长期保存数据库密码、DSN、SSH 凭据
4. 多节点观测基于 `nodeId` 连接注册表稳定运行
5. 至少一个单机 provision 与一个宿主机扫描闭环可用
6. 主链路具备自动化验证
