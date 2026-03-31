# PG Kernel Visualizer 运维手册

> PostgreSQL 内核学习可视化平台 - 运维指南

---

## 1. 系统架构

### 1.1 组件概览

```
┌─────────────────────────────────────────────────────────────┐
│                      Docker Compose                         │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  PostgreSQL  │   Backend    │   Frontend  │   Collector    │
│     :5432    │    :3000     │     :80     │    (可选)       │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬────────┘
       │              │              │               │
       │              │              │        ┌──────┴──────┐
       │              │              │        │  WebSocket  │
       │              │              │        │   :8080     │
       │              │              │        └─────────────┘
       │         ┌────┴─────┐         │
       │         │  pg_wal  │         │
       │         │  pg_clog │         │
       │         └──────────┘         │
       └──────────────────────────────┘
```

### 1.2 端口映射

| 服务 | 端口 | 用途 |
|------|------|------|
| PostgreSQL | 5432 | 数据库连接 |
| Backend API | 3000 | REST API |
| Backend WS | 8080 | WebSocket 实时事件 |
| Frontend | 80 | Web UI |
| Collector | 8090 | eBPF 采集器 (可选) |

---

## 2. 快速部署

### 2.1 环境要求

- Docker 20.10+
- Docker Compose 2.0+
- 2GB+ 可用内存
- 10GB+ 可用磁盘

### 2.2 启动命令

```bash
# 完整环境 (包含 eBPF 采集器)
docker compose up -d

# 仅核心服务 (不需要特权)
docker compose up -d postgres backend frontend

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f backend
```

---

## 3. 配置管理

### 3.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PG_HOST` | localhost | PostgreSQL 主机 |
| `PG_PORT` | 5432 | PostgreSQL 端口 |
| `PG_USER` | postgres | PostgreSQL 用户 |
| `PG_PASSWORD` | postgres | PostgreSQL 密码 |
| `API_PORT` | 3000 | Backend API 端口 |
| `WS_PORT` | 8080 | WebSocket 端口 |
| `ENABLE_EBPF` | true | 启用 eBPF 采集 |
| `LOG_LEVEL` | info | 日志级别 |

### 3.2 修改配置

```bash
# 停止服务
docker compose down

# 编辑 .env 文件
vim .env

# 重启服务
docker compose up -d
```

---

## 4. 监控与日志

### 4.1 查看日志

```bash
# 所有服务日志
docker compose logs -f

# 单个服务
docker compose logs -f backend

# 最近 100 行
docker compose logs --tail=100 postgres
```

### 4.2 健康检查

```bash
# Backend 健康检查
curl http://localhost:3000/health

# PostgreSQL 就绪
docker compose exec postgres pg_isready -U postgres
```

### 4.3 资源监控

```bash
# 查看容器资源使用
docker stats

# 查看特定容器
docker stats pgv-backend pgv-frontend
```

---

## 5. 备份与恢复

### 5.1 数据卷

```bash
# 查看数据卷
docker volume ls | grep pgv-

# 备份数据卷
docker run --rm -v pgv-pg_data:/data -v $(pwd):/backup alpine tar czf /backup/pg_data_backup.tar.gz /data

# 恢复数据卷
docker run --rm -v pgv-pg_data:/data -v $(pwd):/backup alpine tar xzf /backup/pg_data_backup.tar.gz -C /
```

### 5.2 定时备份 (Cron)

```bash
# 编辑 crontab
crontab -e

# 添加每日备份 (凌晨 2 点)
0 2 * * * cd /path/to/project && docker run --rm -v pgv-pg_data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/pg_$(date +\%Y\%m\%d).tar.gz /data
```

---

## 6. 升级与迁移

### 6.1 版本升级

```bash
# 拉取最新镜像
docker compose pull

# 停止服务
docker compose down

# 重新启动
docker compose up -d
```

### 6.2 数据迁移

```bash
# 导出数据
docker compose exec -T postgres pg_dump -U postgres postgres > dump.sql

# 导入数据
docker compose exec -T postgres psql -U postgres postgres < dump.sql
```

---

## 7. 故障排查

### 7.1 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Backend 无法连接 PG | PG 未就绪 | 等待 PG health check 通过 |
| WebSocket 连接失败 | 端口未开放 | 检查防火墙设置 |
| eBPF 探针加载失败 | 权限不足 | 使用日志解析模式 |
| 磁盘空间不足 | WAL 文件过多 | 清理旧 WAL 文件 |

### 7.2 调试命令

```bash
# 进入容器调试
docker compose exec backend sh
docker compose exec postgres bash

# 查看网络连接
docker compose exec backend ping postgres

# 检查端口
docker compose exec backend netstat -tlnp
```

---

## 8. 安全配置

### 8.1 更改默认密码

```bash
# 修改 PostgreSQL 密码
docker compose exec postgres psql -U postgres -c "ALTER USER postgres PASSWORD 'your_password'"

# 更新环境变量
echo "PG_PASSWORD=your_password" >> .env
```

### 8.2 启用 SSL

PostgreSQL 默认配置中已启用 `sslmode=prefer`，如需强制 SSL：

```bash
# 在 docker-compose.yml 中添加
environment:
  - POSTGRES_HOST_AUTH_METHOD=md5
```

---

## 9. 性能调优

### 9.1 PostgreSQL 参数

```yaml
# docker-compose.yml
postgres:
  command:
    - "postgres"
    - "-cshared_buffers=512MB"
    - "-ceffective_cache_size=1GB"
    - "-cmax_connections=100"
    - "-cwork_mem=16MB"
```

### 9.2 资源限制

```yaml
# docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M
```

---

## 10. 卸载

```bash
# 停止并删除服务
docker compose down -v

# 删除镜像
docker rmi pgv-backend pgv-frontend pgv-collector

# 删除数据卷
docker volume rm pgv-pg_data
```

---

*最后更新: 2026-03-31*