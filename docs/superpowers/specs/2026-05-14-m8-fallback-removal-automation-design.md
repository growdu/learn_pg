# M8 删除错误 Fallback 与补自动化 — 设计文档

**日期**: 2026-05-14
**状态**: 已批准，待实现

## 目标

1. 删除 provision 失败后的本地模板 fallback
2. 提供"预览模式"与"真实创建"双模式，让用户明确选择
3. 补齐 Playwright E2E 测试覆盖关键流程
4. 补齐后端 API 单元测试

## 用户决策

| 决策 | 选择 |
|------|------|
| 测试框架 | Playwright 真浏览器 E2E |
| fallback 处理 | 预览模式 vs 真实创建 双模式 |
| E2E 环境 | 真实 Docker/Docker Compose |
| 测试文件位置 | `tests/e2e/` 独立目录 |

## 架构

```
tests/e2e/
  ├── playwright.config.ts      # Playwright 全局配置
  ├── docker-compose.e2e.yml    # E2E 依赖（PostgreSQL 测试实例等）
  ├── package.json               # E2E 测试 scripts
  ├── specs/
  │   ├── provision.spec.ts      # 单机 provision E2E
  │   ├── node-switch.spec.ts    # 节点切换 E2E
  │   ├── host-discovery.spec.ts # 宿主机导入 E2E
  │   ├── dsn-import.spec.ts     # DSN 导入 E2E
  │   ├── manual-connect.spec.ts  # 手动接入数据库 E2E
  │   └── template-preview.spec.ts # 预览模式 E2E
  └── helpers/
      ├── api.ts   # 后端 REST API 客户端
      └── docker.ts # Docker 操作辅助（容器清理等）
```

## 前端改动

### TemplateDialog 模式拆分

用户选择模板后，弹出模式选择：

```
┌─────────────────────────────────────┐
│  选择创建方式                         │
│                                      │
│  ○ 仅预览模板拓扑                      │
│    查看集群结构，不调用后端            │
│                                      │
│  ● 真实创建集群                        │
│    调用后端 provision，拉起真实 PG     │
│                                      │
│            [取消]  [下一步]            │
└─────────────────────────────────────┘
```

**预览模式**：
- 不调用任何 API
- 直接使用 `tpl.buildProject()` 在前端本地构建项目
- 展示集群拓扑预览图
- 完成后不写入 workspace

**真实创建模式**：
- 调用 `POST /api/provision/single` 或对应 API
- 成功 → 跳转集群页
- 失败 → 明确错误提示，无任何回退（不再生成假节点）

### 删除的 Fallback 逻辑

原 `handleTemplateConfirm` 中的 fallback 代码删除：

```go
// 删除前（伪代码）
if provisionOk {
    // 成功处理
} else {
    // Fallback: 本地生成假节点 ← 删除此逻辑
}
```

## 后端 API 测试补全

新增/补全 `backend/internal/api/*_test.go`：

| 文件 | 覆盖范围 |
|------|---------|
| `workspace_crud_test.go` | workspace CRUD |
| `provision_discovery_test.go` | discovery scan/import, DSN validate/import |
| `cluster_handler_test.go` | cluster overview |

## Playwright E2E 测试用例

| 用例 | 描述 |
|------|------|
| provision.spec.ts | 单机 provision 成功流程 |
| node-switch.spec.ts | 多节点集群切换 |
| host-discovery.spec.ts | 主机探测 + 导入 |
| dsn-import.spec.ts | DSN 校验 + 导入 |
| manual-connect.spec.ts | 手动添加节点 |
| template-preview.spec.ts | 预览模式正常展示 |

**E2E 环境要求**：
- Docker daemon 可用（用于 provision 真实拉起 PG 容器）
- 后端服务运行在 `http://localhost:8080`
- 前端服务运行在 `http://localhost:5173`

## 文档

- `docs/ops.md` — 联调检查清单（环境要求、启动顺序、常见问题）
- `tests/e2e/README.md` — E2E 测试运行说明

## 验收标准

1. provision 失败 → 明确错误，无假资源生成
2. 预览模式可正常展示拓扑，不调用 API
3. 6 条 Playwright E2E 用例全部通过
4. 后端核心 API handler 有单元测试覆盖