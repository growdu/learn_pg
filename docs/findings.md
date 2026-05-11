# 研究发现 — PG Kernel Visualizer

> 记录技术调研、方案选型理由、踩坑记录

---

## 1. 技术选型研究

### 1.1 PostgreSQL 18 内核探针方案

**发现：** PG 18 内部函数符号表可在 `--enable-debug` 编译时获取。

**方案对比：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| eBPF uprobe | 无侵入，实时内核级 | 需要特权容器，macOS 不支持 |
| `LD_PRELOAD` 共享库 | 无需修改 PG 源码 | 只能拦截公开 API，精度低 |
| 日志解析 | 无特权依赖，跨平台 | 延迟高，丢失内部细节 |
| 编译时插桩 | 最精确 | 需重新编译 PG，维护成本高 |

**结论：** 首选 eBPF (Aya/Rust)，降级方案为日志解析模式。

### 1.2 PG Wire Protocol 实现

**发现：** 无需 libpq，直接通过 TCP 连接实现协议握手。

关键步骤：
1. 发送 StartupMessage (user, database, options)
2. 接收 AuthenticationOk
3. 发送 PasswordMessage 或 SASLInitialResponse
4. 接收 ReadyForQuery

**参考：** PostgreSQL 协议文档 https://www.postgresql.org/docs/current/protocol.html

### 1.3 eBPF Aya 框架调研

**发现：** Aya 是纯 Rust eBPF 框架，无需 C 依赖。

核心组件：
- `aya::Aya` — 加载和管理 eBPF 程序
- `aya::programs::UProbe/KProbe/TracePoint` — 探针类型
- `ringbuf::RingBuffer` — 内核到用户空间高效传输

**限制：** 需要 Linux kernel 5.8+ 和 BTF 支持。

### 1.4 Tauri vs 直接 Web 部署

**发现：** 需求要求桌面跨平台（iOS/Android/Mac/Win）+ Web。

分析：
- Tauri 2.x 支持所有目标平台，体积小（~10MB）
- 但 Docker 环境下 Web 部署更简单（nginx 单镜像）
- 矛盾点：macOS/Windows 桌面端 eBPF 需要 Docker Desktop 容器

**结论：** 采用渐进策略：
- 云原生部署（Docker）→ Web 端（Tauri 不必需）
- 桌面端 → 通过 Tauri + Docker 容器中的 eBPF 采集器解决

### 1.5 WAL 文件格式（PG 18）

**关键发现：** PG 18 WAL 格式与之前版本基本一致。

结构：
```
XLogLongPageHeaderData (24 bytes)
XLogPageHeaderData (24 bytes)
XLogRecord (24 bytes header + variable)
  └── XLogRecordBlockHeader[]
  └── XLogRecordDataHeader[]
  └── data payload
```

RmgrId (Resource Manager):
- HEAP = 0, Btree = 1, Hash = 2, Gin = 3, Gist = 4, SpGist = 5
- BRIN = 6, Gin = 9, Generic = 10, LogicalMsg = 11

### 1.6 CLOG 文件格式（PG 18）

每页 8KB，每个事务 2 bits，状态：
- 00 = in-progress
- 01 = committed
- 10 = aborted
- 11 = reserved

每页记录 8KB * 8 / 2 = 32,768 事务状态 = 4,096 事务/页。

---

## 2. 架构设计决策

### 2.1 进程隔离策略

```
方案A（单一进程）：Tauri Rust 后端直接管理 eBPF
方案B（独立进程）：Go 后端 + 独立 Rust eBPF 采集器，通过 WS 通信
```

**选择：** 方案B
- 原因：eBPF 需要特权，独立进程隔离更安全
- Go 后端专注业务逻辑，Rust 采集器专注内核探针
- 通信：WebSocket（JSON），简单可靠

### 2.2 前端状态管理

**发现：** 使用 Zustand 管理采集事件流。

```typescript
// 事件滚动窗口：保留最近 1000 条
// 每条事件：type + timestamp + pid + seq + data
```

### 2.3 Docker 多架构构建

使用 `docker buildx` 支持 amd64 + arm64：

```bash
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64/v8 ...
```

---

## 3. 待验证假设

| 假设 | 验证方法 | 状态 |
|------|----------|------|
| Aya eBPF 可在 Docker 容器中正常运行 | 运行 collector/Dockerfile | pending |
| PG 18 符号名与 PG 16/17 兼容 | 检查 pg符号表 | pending |
| Go PG Wire Protocol 客户端可连接 postgres:18 | 端到端测试 | pending |
| 无 eBPF 环境下日志解析模式可行 | 配置 PG 日志级别 | pending |
| D3.js 力导向图能处理 100+ 锁节点 | 性能测试 | pending |

---

*最后更新：2026-03-30*