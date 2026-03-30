# PostgreSQL 内核学习可视化平台 — 概要设计

## 1. 背景与目标

本项目旨在构建一个交互式 Web 应用，辅助开发者深入理解 PostgreSQL 内核的实现原理。重点关注以下核心模块的可视化展示：

- 事务系统（事务状态、生命周期）
- 并发控制（锁、MVCC）
- WAL（预写日志）机制
- CLOG（事务日志）存储
- 存储引擎（内存页、磁盘块、Buffer Pool）
- SQL 执行过程（规划与执行链路）

核心价值：**将看不见的内核运行时状态，转化为可观测的动态可视化**。

---

## 2. 整体架构

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (Web UI)                      │
│   React + D3.js / Three.js / WebGL 可视化层                   │
└──────────┬──────────────────────┬──────────────────────────┘
           │                      │
    ┌──────▼──────┐        ┌───────▼───────┐
    │  状态收集层  │        │  命令交互层   │
    │  (Agent)    │        │  (CLI/Web)   │
    └──────┬──────┘        └───────┬───────┘
           │                       │
    ┌──────▼───────────────────────▼───────┐
    │         Core Engine (Rust/Go)         │
    │  eBPF Probe / Dynamic Instrumentation  │
    └──────┬───────────────────────┬───────┘
           │                       │
    ┌──────▼──────┐        ┌───────▼───────┐
    │  PG 实例    │        │  文件系统观察  │
    │  (被测)     │        │  (data/log)   │
    └─────────────┘        └───────────────┘
```

### 2.2 模块层次

| 层级 | 职责 | 技术选型 |
|------|------|---------|
| 可视化层 | 数据渲染、交互、控制台 | React + D3.js / Three.js |
| 通信层 | 前端与后端实时数据通道 | WebSocket (JSON over WS) |
| 核心引擎 | 数据采集、命令转发、状态管理 | Go/Rust |
| 采集层 | eBPF / tracepoints / 进程内存快照 | BCC/libbpf + Go |
| 连接层 | 与 PG 进程的交互 | PostgreSQL 客户端协议 + 控制连接 |

---

## 3. 核心功能模块设计

### 3.1 数据写入可视化

**功能描述：** 动态展示一条 INSERT/UPDATE 语句从客户端到持久化存储的完整路径。

**采集点（Pipeline）：**
1. 客户端解析 → 生成 Parse 消息
2. 绑定参数 → Bind 消息
3. 执行器启动 → ExecutorStart
4. 堆元组构建 → heap_form_tuple
5. Buffer 分配 → BufferAlloc（SMGR）
6. WAL 记录写入 → XLogInsert
7. 数据页修改 → PageAddItem
8. CLOG 更新 → TransactionLogUpdate
9. 两阶段提交确认 → 2PC（若涉及）

**可视化输出：**
- 时间线视图：各阶段耗时与顺序
- 内存视图：Buffer Pool 中对应页的变化（脏页标记）
- WAL 视图：WAL record 的生成与 flush 过程
- 文件视图：data page 和 WAL 文件的块级变化

### 3.2 数据读取可视化

**采集点：**
1. 查询解析 → parser_outlines
2. 规划器输出 → planner 生成的 PlanTree
3. 扫描执行 → SeqScan / IndexScan / BitmapHeapScan
4. MVCC 可见性判断 → HeapTupleSatisfiesMVCC
5. Buffer Hit/Miss 与 pin/unpin
6. TID 列表回表（IndexOnlyScan 时无回表）

**可视化输出：**
- 执行计划树（树形图，含 cost 标注）
- Buffer Pool 热图（被访问页的频率与状态）
- MVCC 可见性判断过程（xmin/xmax vs 当前事务 Snapshot）
- 磁盘 I/O 事件标注

### 3.3 事务执行可视化

**采集点：**
1. 事务开始 → BeginTransactionBlock
2. CommandId 推进
3. Subtransaction 创建（savepoints）
4. XID 分配（VirtualTransactionId / LWLock）
5. 锁等待链（LockAcquire / LockWaitDie）
6. 事务提交 → CommitTransaction
7. 异步 commit 的 background writer flush

**可视化输出：**
- 事务状态机图（idle → active → idle in transaction → in error）
- 锁等待图（waits-for graph，检测死锁）
- XID 环（分配递增可视化）
- CLOG 页写入顺序

### 3.4 WAL & CLOG 专题

**WAL 可视化：**
- WAL record 结构分解（RmgrId, Info bits, data payload）
- WAL buffer 的 ring buffer 结构
- WAL writer 触发时机与批量写入
- Checkpoint 过程中的 REDO point 计算

**CLOG 可视化：**
- CLOG page 结构（每个事务 2 bits，共 4×512 个事务/页）
- Subtrans 父事务链追踪
- 在途事务（in-progress）与已提交/已终止状态的演进

### 3.5 SQL 执行过程

**支持展示的 SQL 类型：**
- DML：SELECT, INSERT, UPDATE, DELETE
- DDL：CREATE TABLE, ALTER TABLE, DROP TABLE（表结构变更）
- Transaction control：BEGIN, COMMIT, ROLLBACK, SAVEPOINT

每个 SQL 类型展示其特有的执行路径（例如 UPDATE 的 HeapTuple 标记 + index 维护）。

### 3.6 运行时数据结构快照

通过定时快照或触发式快照，采集 PG 进程内存中的关键数据结构：

- `PGPROC` 数组（进程/锁状态）
- `PGXACT` 数组（事务状态）
- `BufferDesc` 表（Buffer Pool 元数据）
- `RelCache` 表（表结构缓存）
- `SlruCtl`（CLOG/SUBTRANS 等 SLRU 缓存）

可视化呈现为实时更新的内存结构图。

---

## 4. 技术方案细节

### 4.1 数据采集方案

**优先级一：eBPF（推荐）**
- 利用 eBPF tracepoints 挂载 PG 内核关键函数
- 不修改 PG 源码，不影响被测实例性能
- 覆盖 `exec_simple_query`, `heap_insert`, `heap_update`, `XLogInsert`, `LockAcquire`, `TransactionIdCommitTree` 等关键路径
- 使用 BCC (Berkeley Packet Filter) Python bindings 或 `libbpf` + Go

**优先级二：动态插桩（备用）**
- 编译 PG 时启用 `--enable-debug` 并注入探针
- 使用 `LD_PRELOAD` 共享库拦截关键函数入口

**优先级三：进程内存快照**
- 对运行中的 PG 进程做 `ptrace` 快照
- 解析 `struct PGPROC`, `PGXACT`, `BufferDesc` 等关键结构
- 需要 PG 源码中的头文件来对齐内存布局

**数据存储：**
- 采集数据以流式方式经 WebSocket 推送至前端
- 后端维护一个滚动窗口（最近 N 条事件）
- 重要快照数据可落盘以支持回放

### 4.2 前端可视化方案

**技术栈：**
- React 18 + TypeScript
- D3.js 用于流程图、时间线、状态机
- Three.js 用于 3D 内存布局可视化（可选）
- 状态管理：Zustand

**核心视图组件：**
| 组件 | 用途 |
|------|------|
| PipelineView | SQL 执行路径的阶段时间线 |
| BufferHeatmap | Buffer Pool 页的访问频率/状态 |
| LockGraph | 锁等待与死锁检测图 |
| WALViewer | WAL record 结构与内容解析 |
| CLOGViewer | CLOG page 状态可视化 |
| MemoryStructView | 运行时数据结构的树状/图形展示 |

### 4.3 命令交互层

- 内置 SQL 控制台：用户执行 SQL，触发对应的可视化采集
- CLI 工具：`pg-visualize` 命令行，支持 `--sql "SELECT..."` 和 `--pid <pid>`
- Web UI 提供 SQL 输入框、执行按钮和可视化切换

---

## 5. 非功能需求

### 5.1 性能要求
- eBPF 采集 overhead < 1%（针对关键路径函数）
- WebSocket 推送延迟 < 100ms
- 前端渲染 60fps（动画流畅）

### 5.2 兼容性
- 支持 PostgreSQL 14+（内部结构差异需适配）
- 跨平台：Linux（eBPF 必需），macOS（仅模拟模式）

### 5.3 扩展性
- 采集层插件化：新增采集点只需定义 probe spec
- 可视化组件可复用/可组合
- 预留 SQL 引擎扩展接口（后续接入 parser/optimizer 演示）

---

## 6. 目录结构（预期）

```
pg-kernel-visualizer/
├── frontend/                  # React Web UI
│   ├── src/
│   │   ├── components/       # 可视化组件
│   │   ├── views/            # 页面视图
│   │   ├── hooks/            # WebSocket 等 hooks
│   │   └── stores/           # Zustand 状态
├── backend/                  # Go 后端核心引擎
│   ├── cmd/                  # CLI 入口
│   ├── collector/            # 数据采集器
│   │   ├── ebpf/             # eBPF 探针
│   │   └── snapshot/         # 内存快照
│   ├── ws/                   # WebSocket 服务
│   └── pg/                   # PG 客户端协议
├── docs/
│   ├── design.md             # 本文档
│   ├── api.md                # WebSocket API 定义
│   └── probes.md             # 采集点清单
└── README.md
```

---

## 7. 实施里程碑（建议）

| 阶段 | 目标 | 交付物 |
|------|------|--------|
| P0 | 最小可用：SQL 发送 + WAL/CLOG 静态可视化 | MVP Web UI + CLI |
| P1 | 数据写入Pipeline：INSERT 写入全路径动画 | PipelineView 完成 |
| P2 | 数据读取Pipeline：SELECT 执行计划 + MVCC | BufferHeatmap + 执行计划树 |
| P3 | 事务可视化：事务状态机 + 锁等待图 | LockGraph + 状态机 |
| P4 | 运行时快照：PGPROC/PGXACT 实时内存图 | MemoryStructView |
| P5 | 扩展：SQL 引擎（parser/optimizer 演示） | ... |

---

*本文档为概要设计，具体实现细节在后续详细设计中补充。*