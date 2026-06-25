# CLAUDE.md

## 项目信息

- **项目**: learn_pg (PostgreSQL 内核学习与可视化观测)
- **前端**: React + TypeScript + Vite (`./frontend/`)
- **后端**: Go (HTTP + WebSocket) (`./backend/`)
- **部署**: Docker Compose (开发) / 手动部署 (生产)

## 提交规范

### 禁止事项

**绝对禁止在 git commit message 中添加 `Co-Authored-By: Claude`**。

所有提交必须是单一作者（当前用户），不得包含任何 AI co-author 行。

### 原因

项目代码归属和个人提交历史清晰性要求。不允许混入 AI co-author 标识。

### 如何执行

当使用 `git commit` 时：
- 不要使用 `-m "..."` 以外的任何方式添加 co-author
- 不要在 commit message body 中添加 `Co-Authored-By:` 行
- 提交消息只需包含简短的 present tense 描述

### 已验证的合法格式

```bash
git commit -m "feat(backend): add ConnectionManager for nodeId->connection registry"
```

### 非合法格式（禁止）

```bash
git commit -m "feat: something

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

## 架构约束

- 浏览器不直接连接 PostgreSQL
- 浏览器不直接连接数据库宿主机
- 所有连接、编排、观测由后端统一处理
- 前端只消费后端提供的 API 和 WebSocket 数据
