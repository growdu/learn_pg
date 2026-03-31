# PG Kernel Visualizer 部署指南

> PostgreSQL 内核学习可视化平台 - 部署手册

---

## 1. 部署方式

### 1.1 支持的部署模式

| 模式 | 描述 | 适用场景 |
|------|------|----------|
| **Docker Compose** | 单机容器编排 | 开发/测试/小规模生产 |
| **Kubernetes** | 集群化部署 | 大规模生产环境 |
| **Swarm** | Docker 原生集群 | 中等规模部署 |

---

## 2. Docker Compose 部署 (推荐)

### 2.1 前置条件

- Linux/macOS/Windows (WSL2)
- Docker 20.10+
- Docker Compose 2.0+
- 2GB+ RAM
- 10GB+ 磁盘空间

### 2.2 部署步骤

#### Step 1: 克隆项目

```bash
git clone https://github.com/growdu/learn_pg.git
cd learn_pg
```

#### Step 2: 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑配置 (可选)
vim .env
```

#### Step 3: 启动服务

```bash
# 完整环境
docker compose up -d

# 仅核心服务
docker compose up -d postgres backend frontend
```

#### Step 4: 验证部署

```bash
# 检查服务状态
docker compose ps

# 测试健康端点
curl http://localhost:3000/health

# 访问 Web UI
# 浏览器打开: http://localhost
```

### 2.3 部署拓扑

```
                    ┌──────────────┐
                    │   外部访问    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼────┐  ┌──▼────┐  ┌────▼─────┐
         │Frontend │  │Backend│  │Collector │
         │  :80    │  │:3000  │  │  :8090   │
         └────┬────┘  └──┬────┘  └────┬─────┘
              │         │            │
              │    ┌────▼────┐       │
              │    │WebSocket│◄──────┘
              │    │  :8080  │
              │    └────┬────┘
              │         │
         ┌────▼─────────▼─────┐
         │    PostgreSQL      │
         │      :5432        │
         │  pg_wal, pg_clog  │
         └───────────────────┘
```

---

## 3. 生产环境部署

### 3.1 生产配置

```bash
# 创建生产环境配置文件
cat > .env.production << 'EOF'
# PostgreSQL
PG_HOST=postgres
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=secure_password_change_me
PG_DATABASE=postgres
PG_DATA_DIR=/var/lib/postgresql/data

# Backend
API_PORT=3000
WS_PORT=8080
LOG_LEVEL=warn

# Collector
ENABLE_EBPF=true
BACKEND_WS_URL=ws://backend:8080
EOF
```

### 3.2 启动生产环境

```bash
# 使用生产配置
docker compose --env-file .env.production up -d

# 或修改 docker-compose.yml 中的默认值
```

### 3.3 生产环境建议

| 配置项 | 建议值 | 说明 |
|--------|--------|------|
| `shared_buffers` | 1/4 内存 | PostgreSQL 缓冲池 |
| `max_connections` | 100-200 | 最大连接数 |
| `wal_level` | replica | WAL 级别 |
| `max_wal_senders` | 10 | WAL 发送器数量 |

---

## 4. Kubernetes 部署

### 4.1 使用 Helm (可选)

```bash
# 添加 Helm 仓库
helm repo add pg-visualizer https://charts.example.com

# 安装
helm install pgv pg-visualizer/pg-visualizer \
  --set postgres.image=postgres:18 \
  --set backend.replicaCount=2
```

### 4.2 手动部署 YAML

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgv-backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pgv-backend
  template:
    spec:
      containers:
      - name: backend
        image: ghcr.io/growdu/learn_pg-backend:latest
        ports:
        - containerPort: 3000
        env:
        - name: PG_HOST
          value: "postgres"
```

---

## 5. Docker Swarm 部署

### 5.1 初始化 Swarm

```bash
# 初始化 Swarm 集群
docker swarm init

# 创建overlay网络
docker network create -d overlay pgv-net
```

### 5.2 部署服务

```bash
# 部署 PostgreSQL
docker service create \
  --name pgv-postgres \
  --network pgv-net \
  --mount type=volume,source=pgv-pg_data,destination=/var/lib/postgresql/data \
  postgres:18

# 部署 Backend
docker service create \
  --name pgv-backend \
  --network pgv-net \
  -e PG_HOST=pgv-postgres \
  -p 3000:3000 \
  -p 8080:8080 \
  ghcr.io/growdu/learn_pg-backend:latest
```

---

## 6. 负载均衡配置

### 6.1 Nginx 反向代理

```nginx
# nginx.conf
upstream pgv_backend {
    server localhost:3000;
}

upstream pgv_ws {
    server localhost:8080;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://pgv_frontend;
    }

    location /api {
        proxy_pass http://pgv_backend;
    }

    location /ws {
        proxy_pass http://pgv_ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

### 6.2 SSL/TLS 配置

```nginx
server {
    listen 443 ssl http2;
    ssl_certificate /etc/ssl/certs/your-cert.crt;
    ssl_certificate_key /etc/ssl/private/your-key.key;
    # ...其他配置
}
```

---

## 7. 高可用配置

### 7.1 Backend 高可用

```yaml
# docker-compose.yml
services:
  backend:
    deploy:
      replicas: 2
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.pgv.rule=PathPrefix(`/api`)"
```

### 7.2 PostgreSQL 高可用

推荐使用 Patroni + etcd/Consul 构建高可用 PostgreSQL 集群。

详细配置请参考: [Patroni Documentation](https://patroni.readthedocs.io/)

---

## 8. 容器健康检查

### 8.1 健康检查配置

```yaml
# docker-compose.yml
services:
  backend:
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  postgres:
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
```

### 8.2 自动恢复

```yaml
services:
  backend:
    restart: on-failure
    deploy:
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
```

---

## 9. 监控集成

### 9.1 Prometheus 配置

```yaml
# docker-compose.yml
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  backend:
    expose:
      - "3000"
    labels:
      - "prometheus.io/scrape=true"
      - "prometheus.io/port=3000"
```

### 9.2 Grafana 仪表板

导入预配置的 Grafana Dashboard:
- PostgreSQL 性能监控
- 容器资源使用
- WebSocket 连接状态

---

## 10. 验证清单

部署完成后，验证以下项目:

- [ ] 所有容器运行中 (`docker compose ps`)
- [ ] Backend 健康检查通过 (`curl http://localhost:3000/health`)
- [ ] WebSocket 连接正常
- [ ] Frontend 可访问 (`http://localhost`)
- [ ] 可以执行 SQL 查询
- [ ] WAL/CLOG 文件可访问
- [ ] 磁盘空间充足 (`docker system df`)

---

## 11. 快速回滚

```bash
# 查看历史版本
docker compose ps -a

# 回滚到上一个版本
docker compose rollback

# 或指定版本
docker compose up -d --scale backend=1
```

---

*最后更新: 2026-03-31*