# M7 宿主机自动发现与导入 — 设计文档

**日期**: 2026-05-14
**状态**: 实现完成

## 目标

M7 提供手动输入 IP:port 探测远程 PostgreSQL 实例的能力，作为后续 SSH 扫描发现的 MVP。

## 用户决策

1. **SSH 扫描 vs 手动输入**: 选择手动输入 IP:port 探测（MVP）
2. **探测后行为**: 仅返回探测结果，导入由用户手动完成
3. **前端入口**: 项目页面内嵌"发现实例"入口（ClusterHomeView）
4. **探测方式**: TCP 连通性检测 + pg_isready PostgreSQL 验证

## 架构

```
前端 ClusterHomeView（添加 Tab）
    │
    │ POST /api/discovery/host/scan { host, port }
    ▼
后端 ServeDiscoveryHostScan
    │
    ├─ TCP 端口检测（portOpen）
    ├─ pg_isready 验证（pgIsReady）
    │
    ▼
返回 { success, instances: [{ host, port, version?, confidence }] }
    │
    ▼
前端展示结果列表（reachable / unreachable）
```

## API 设计

**POST /api/discovery/host/scan**

```json
// Request
{ "host": "192.168.1.100", "port": 5432 }

// Response
{
  "success": true,
  "instances": [{
    "host": "192.168.1.100",
    "port": 5432,
    "version": "postgres 16.6 on x86_64...",
    "service": "postgresql",
    "confidence": "high"
  }]
}
```

## 后端改动

### provision_discovery.go

1. **ServeDiscoveryHostScan** 重写：
   - 输入：`discoveryScanRequest{ Host, SSH{ User, Password, Port } }`（port 字段复用 SSH.Port）
   - 默认 port 5432
   - 行为：
     - `portOpen(addr, 900ms)` — TCP 连通性检测
     - `pgIsReady(host, port)` — pg_isready 验证

2. **portOpen** 签名调整为 `portOpen(addr string, timeout time.Duration) bool`

3. **pgIsReady(host, port)** 新增：
   - 尝试以"任意用户"连接 template1 或 postgres 数据库
   - 连通时返回 version 字符串和 true
   - 不可达时返回空字符串和 false

4. **discoveryInstance** 字段：
   - `Confidence`: "high"（pg_isready 验证成功）/ "low"（仅 TCP 连通）

## 前端改动

### ClusterHomeView.tsx

1. `scanPort` state 新增
2. **扫描表单**增加端口输入框（默认 5432）
3. **探测结果列表**显示 version 和 confidence 状态标记
4. 探测结果展示：
   - 有 version → 显示版本号 + ✓
   - 无 version → 显示"不可达" + ✗

## 验证

```bash
# 手动测试
curl -X POST http://localhost:8080/api/discovery/host/scan \
  -H "Content-Type: application/json" \
  -d '{"host": "127.0.0.1", "port": 5432}'
```

## 已知限制

- pg_isready 验证需要 PG 配置为允许无密码或使用 trust/auth 方式
- 未实现 SSH 扫描（M7 后期迭代方向）
- 未实现多端口扫描（M7 MVP 仅为单一指定端口）