# 实现文档（apply.md）

## 1. 目标
说明当前版本“多项目-多集群-多节点观测”能力的具体实现与落地范围，作为研发与联调参考。

## 2. 已实现能力

### 2.1 前端工作区重构
- 新增项目层、集群层、组件层、节点层的分层导航。
- 主页默认按“整体 -> 局部”组织：
  - 项目主页：项目级拓扑
  - 集群主页：集群级看板
  - 节点主页：节点级观测模块

涉及文件：
- `frontend/src/App.tsx`
- `frontend/src/components/layout/Sidebar.tsx`
- `frontend/src/components/workspace/ProjectHomeView.tsx`
- `frontend/src/components/workspace/ClusterHomeView.tsx`
- `frontend/src/components/workspace/ComponentHomeView.tsx`

### 2.2 模板化创建
- 支持物理复制模板、逻辑复制模板。
- 支持模板参数化节点数量、组件自动创建、命名规则。

涉及文件：
- `frontend/src/components/workspace/TemplateDialog.tsx`
- `frontend/src/types/template.ts`

### 2.3 集群同步状态可视化
- 集群主页轮询 `/api/cluster/overview`。
- 展示在线/异常节点与节点详情。
- 拓扑图支持边/节点交互。

涉及文件：
- `frontend/src/components/workspace/ClusterHomeView.tsx`
- `backend/internal/api/handler.go`

### 2.4 组件跨集群关系
- 组件主页支持：
  - 关系图（组件->集群）
  - 关联矩阵编辑
  - 树形关系与节点下钻

涉及文件：
- `frontend/src/components/workspace/ComponentHomeView.tsx`

## 3. 关键接口与数据流
1. 节点激活：前端调用 `/api/connect`，更新全局 PG 连接状态。
2. 集群观测：前端定时调用 `/api/cluster/overview`，更新集群看板。
3. 节点下钻：通过节点激活后进入节点观测视图（SQL/WAL/CLOG等）。

## 4. 当前限制
1. 部分节点内专题仍是 demo/样机数据。
2. 项目配置以前端存储为主，缺少后端统一持久化。
3. 未完成跨平台 Tauri 产品化闭环。

## 5. 联调建议
1. 先在单项目内创建 1 个物理复制集群 + 2 节点做验证。
2. 再创建逻辑复制集群验证 publisher/subscriber 状态显示。
3. 通过组件页关系图与集群页拓扑图交叉验证下钻路径。

## 6. 下一步实现清单
1. 完善复制链路指标细化（LSN/lag/sync state）
2. 将项目/集群/节点配置下沉到后端存储
3. 将节点专题页 demo 数据逐步替换为真实采集/查询结果
4. 增加自动化回归（页面层级与接口契约）
