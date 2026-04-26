# PG Kernel Visualizer

> PostgreSQL 内核学习可视化平台 — 详细设计文档

## 目录

1. [项目概述](#1-项目概述)
2. [技术选型与理由](#2-技术选型与理由)
3. [系统架构](#3-系统架构)
4. [模块详细设计](#4-模块详细设计)
5. [数据模型与 API](#5-数据模型与-api)
6. [前端设计](#6-前端设计)
7. [eBPF 采集层设计](#7-ebpf-采集层设计)
8. [Go 后端服务设计](#8-go-后端服务设计)
9. [目录结构](#9-目录结构)
10. [实施计划](#10-实施计划)

---

## 1. 项目概述

### 1.1 背景

PostgreSQL 是功能最为丰富的开源关系型数据库之一，但其内核代码复杂度高，运行过程对开发者不可见。本项目旨在构建一个交互式可视化平台，将 PG 内核的运行时行为转化为直观的动态图形，帮助开发者理解事务、并发、WAL、CLOG、Buffer Pool 等核心机制。

### 1.2 目标

- **学习辅助**：通过动态可视化降低 PG 内核学习门槛
- **运行时可观测**：将内存结构、文件块、数据流以动画方式呈现
- **跨平台**：支持桌面端（Windows/macOS/Linux/iOS/Android）和 Web 端
- **扩展预留**：保留对 SQL 引擎（parser/optimizer）的扩展接口

### 1.3 范围

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | SQL 执行 + 写入 Pipeline 可视化 | MVP 核心价值 |
| P1 | 读取 Pipeline + MVCC 可视化 | 扩展至 SELECT |
| P2 | 事务 + 锁等待可视化 | 状态机 + 死锁检测 |
| P3 | WAL/CLOG 专题可视化 | 专题深入 |
| P4 | 运行时数据结构快照 | PGPROC/PGXACT |
| P5 | SQL 引擎扩展 | Parser/Optimizer |

---

## 2. 技术选型与理由

### 2.1 选型总览

| 层级 | 技术 | 选型理由 |
|------|------|----------|
| 桌面跨平台框架 | Tauri 2.x | Rust 后端 + Web 前端，原生性能，体积小，跨全平台 |
| 前端 UI 框架 | React 18 + TypeScript | 生态成熟，组件丰富 |
| 可视化图表 | D3.js v7 | 完全控制 SVG，适合复杂关系图 |
| 3D 可视化（可选） | Three.js | 内存结构 3D 布局 |
| 状态管理 | Zustand | 轻量，TypeScript 支持好 |
| WebSocket 通信 | ws (Go) + 前端原生 API | 实时推送采集事件 |
| 后端 API 服务 | Go 1.21+ | 用户指定，高并发，易维护 |
| eBPF 采集 | Rust + libbpf-rs + Aya | 用户指定，原生 Rust 集成，kernel 5.x+ 支持 |
| 容器化部署 | Docker + Docker Compose | 全组件容器化，开发/生产/测试一致环境 |
| CI/CD | GitHub Actions + Docker Buildx | 多架构构建，自动化测试 |

### 2.2 为什么选 Tauri

- 需求明确要求跨平台桌面（iOS/Android/Mac/Win）+ Web
- Go/Rust 技术栈贯穿全栈，Tauri 天然支持 Rust 后端
- Electron 体积过大（~150MB），Tauri 仅 ~10MB
- WebView2 (Windows) / WebKit (macOS/Linux) 跨平台一致性好

### 2.3 为什么 eBPF 用 Rust

- 用户明确要求 Rust 实现 eBPF 部分
- Aya 是纯 Rust eBPF 框架（无 C 依赖），与 Tauri 的 Rust 后端可共享库
- libbpf-rs 提供底层绑配，Tauri 可直接调用

### 2.4 云原生设计原则

- **不可变基础设施**：所有组件通过 Dockerfile 镜像化
- **环境一致性**：开发、测试、生产使用同一 Docker Compose 编排
- **特权隔离**：eBPF 采集器使用特权容器，核心数据平面分离
- **多架构支持**：x86_64 + arm64/v8 双架构构建
- **降级容错**：eBPF 不可用时自动降级为日志解析模式

---

## 3. 系统架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│              Desktop / Mobile / Web (Tauri)              │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                    WebView                             │ │
│  │  ┌────────────────────────────────────────────────┐  │ │
│  │  │              React Frontend                    │  │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │  │ │
│  │  │  │PipelineV│ │BufferHM │ │ LockGraph    │  │  │ │
│  │  │  │  视图    │ │ 热图    │ │  锁等待图    │  │  │ │
│  │  │  └──────────┘ └──────────┘ └──────────────┘  │  │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │  │ │
│  │  │  │WALViewer │ │CLOGViewer│ │MemoryStruct │  │  │ │
│  │  │  │  WAL视图 │ │CLOG视图 │ │  内存结构   │  │  │ │
│  │  │  └──────────┘ └──────────┘ └──────────────┘  │  │ │
│  │  └────────────────────┬─────────────────────────┘  │ │
│  │                       │ WebSocket (客户端)          │ │
│  └───────────────────────┼─────────────────────────────┘ │
│                          │ IPC / WebSocket               │
│  ┌───────────────────────▼─────────────────────────────┐ │
│  │              Tauri Rust Backend                      │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │ │
│  │  │ WS Server│  │ PG Client│  │ 命令/快照管理    │  │ │
│  │  └─────┬────┘  └─────┬────┘  └────────┬─────────┘  │ │
│  └────────┼─────────────┼────────────────┼────────────┘ │
└───────────┼─────────────┼────────────────┼──────────────
            │             │                │
    ┌───────▼───────┐  ┌──▼────────┐  ┌───▼────────────┐
    │  eBPF Probe   │  │ PostgreSQL│  │  文件系统观察  │
    │  (独立进程)    │  │  被测实例  │  │ data/log/...  │
    └───────────────┘  └───────────┘  └───────────────┘

eBPF Probe 进程（Rust + Aya）通过 WebSocket 与 Tauri 后端通信
Tauri 后端通过 PostgreSQL Wire Protocol 与 PG 实例交互
```

### 3.2 进程模型

| 进程 | 语言 | 职责 | 部署位置 |
|------|------|------|---------|
| `pg-visualizer` (主进程) | Rust (Tauri) | 窗口管理、IPC、前端服务 | 本地 |
| `pg-collector` (子进程) | Rust (Aya) | eBPF 探针运行、数据采集 | 本地（独立进程） |
| PostgreSQL | C | 被测数据库实例 | 本地或远程 |
| 文件系统观察器 | Go (集成) | 监控 data directory 变化 | 本地 |

### 3.3 通信机制

```
Frontend (React)
    │
    │  Tauri Command (invoke) — Rust IPC 调用
    ▼
Tauri Rust Backend
    │
    ├─ WS ──► pg-collector (eBPF) — WebSocket (JSON)
    │
    ├─ Wire Protocol ──► PostgreSQL — 执行 SQL，采集返回
    │
    └─ 文件观察 ──► data/log 目录 — inotify/FSEvents
```

---

## 4. 模块详细设计

### 4.1 数据写入 Pipeline

#### 4.1.1 流程定义

一条 INSERT 语句经过以下阶段：

```
[客户端] → [PG Parser] → [Binder] → [Planner] → [Executor] → [SMGR/WAL]
  ↓          ↓           ↓          ↓           ↓            ↓
发送SQL    解析树       绑定参数    执行计划    堆元组构建    Buffer分配
                                              ↓            ↓
                                             WAL写入    数据页修改
                                                        ↓
                                                      CLOG更新
```

#### 4.1.2 采集点定义

| 序号 | 阶段名称 | eBPF Probe | 采集数据 |
|------|----------|-----------|---------|
| 1 | SQL Parse | `query__parse__start` / `query__parse__complete` | SQL 文本、解析耗时 |
| 2 | Binding | `postgres__exec_bind_message` | 参数类型、参数值 |
| 3 | Plan | `query__planner__start` / `query__planner__end` | PlanTree 结构、cost 估算 |
| 4 | Exec Start | `ExecutorStart` | 门户指针、扫描类型 |
| 5 | Tuple Form | `exec_helpers__heap_form_tuple` | 列数、数据类型、内存分配 |
| 6 | Buffer Alloc | `smgr__buf_alloc` | buffer id、relfilenode、forknum |
| 7 | WAL Insert | `xlog__insert__enter` / `xlog__insert__return` | XLogRecPtr、WAL record 大小、RmgrId |
| 8 | Page Modify | `bfatuple__insert_or_update` | page 偏移量、item 大小 |
| 9 | CLOG Update | `transactionlog__insert` | transactionId、状态 (committed/aborted) |
| 10 | Commit | `transaction__commit__done` | xact commit 时间戳、WAL LSN |

#### 4.1.3 可视化组件

- **PipelineView**：横向时间线，每个阶段为可点击节点，hover 显示耗时和详细数据
- **BufferBlockView**：8KB page 的可视化，INSERT 时新数据块高亮
- **WALRecordView**：十六进制展示 WAL record 结构，标注各字段含义
- **CLOGBitView**：显示事务状态位的变化过程

### 4.2 数据读取 Pipeline

#### 4.2.1 流程定义

```
[客户端] → [Parser] → [Planner] → [Executor] → [Buffer读取] → [MVCC判断] → [返回结果]
```

#### 4.2.2 采集点定义

| 序号 | 阶段名称 | eBPF Probe | 采集数据 |
|------|----------|-----------|---------|
| 1 | Parse | `query__parse__complete` | AST 树 |
| 2 | Plan | `query__planner__end` | PlanTree（包含节点类型、cost） |
| 3 | SeqScan/IndexScan | `exec__seqscan__init` / `exec__indexscan__init` | relation OID、scan type |
| 4 | Buffer Pin | `bufmgr__pin_buffer__enter` | buffer id、hit/miss |
| 5 | MVCC Check | `heap__tuple__satisfies__mvcc` | xmin/xmax、snapshot xmin/xmax |
| 6 | Index Lookup | `exec__index__fetch` | indexrelid、scan keys |
| 7 | Result | `exec__end` | 返回行数、总耗时 |

#### 4.2.3 可视化组件

- **PlanTreeView**：树形图展示执行计划，支持缩放和节点展开，显示 cost 和行数估算
- **BufferHeatmapView**：N×M 网格，N=buffer pool 数量方向，M=访问频率，颜色深浅表示访问密度
- **MVCCTimelineView**：时间线展示每条记录的 xmin/xmax 与当前 snapshot 的关系
- **IOTimelineView**：标注磁盘读事件的时间线

### 4.3 事务执行可视化

#### 4.3.1 事务状态机

```
           ┌──────────┐
           │   Idle   │  ← BEGIN
           └────┬─────┘
                │ BeginTransactionBlock
           ┌────▼─────┐
           │  Active  │  ← SQL 执行
           └────┬─────┘
                │ Commit / ROLLBACK
           ┌────▼─────┐
           │   Idle   │  (循环)
           └──────────┘

         ┌────────────────────────┐
         │ idle in transaction     │  ← BEGIN 后，SQL 出错
         └──────────┬──────────────┘
                    │ ROLLBACK / COMMIT
              回复 idle 状态
```

#### 4.3.2 采集点定义

| 序号 | 事件 | Probe | 数据 |
|------|------|-------|------|
| 1 | 事务开始 | `transaction__begin` | virtualxid, timestamp |
| 2 | XID 分配 | `transaction__assign_xid` | xid, vxid |
| 3 | 命令 ID 推进 | `command__increment` | commandId |
| 4 | Savepoint | `transaction__savepoint__create` | savepoint name |
| 5 | 锁请求 | `lock__acquire__request` | locktag, mode, pid |
| 6 | 锁等待 | `lock__wait__start` | locktag, waittime |
| 7 | 锁释放 | `lock__release` | locktag, pid |
| 8 | 提交 | `transaction__commit__log` | xid, xact commit LSN |
| 9 | 回滚 | `transaction__abort__log` | xid |

#### 4.3.3 可视化组件

- **TransactionStateView**：状态机图，高亮当前状态，动画展示状态转换
- **LockGraphView**：D3 力导向图，展示锁等待关系，红色高亮死锁环
- **XIDCounterView**：XID 分配递增的实时折线图
- **CLOGUpdateView**：CLOG 页中事务状态的演进动画

### 4.4 WAL & CLOG 专题

#### 4.4.1 WAL Record 结构

```c
// WAL record 头部（每条记录）
struct XLogRecord {
    uint32_t    xl_tot_len;     // 总长度
    uint32_t    xl_rmid;        // Resource Manager ID
    uint8_t     xl_info;        // 操作类型 + 标志位
    TransactionId xl_xid;       // 事务ID
    XLogRecPtr  xl_prev;        // 前一条 WAL 地址
    // 4-byte alignment
    uint8_t     xl_backup_blocks[1];  // backup information
    //随后是 RMgr 数据区和 block data
};
```

#### 4.4.2 CLOG Page 结构

```
┌─────────────────────────────────────────────────┐
│ 每个事务状态占 2 bits，8 个事务 = 1 byte          │
│ 每页 8KB / 2 = 4K 事务                          │
│ 每页记录 4096 / 32 * 8 = 1024 个事务？           │
│ 实际：8192 / 2 * 8 = 32768 / 8 = 4096 事务/页   │
└─────────────────────────────────────────────────┘
```

事务状态映射：
- `00` = in-progress（进行中）
- `01` = committed（已提交）
- `10` = aborted（已中止）
- `11` = reserved（保留）

#### 4.4.3 可视化组件

- **WALHexView**：十六进制视图，解析 WAL record 字段，标注含义
- **WALBufferView**：WAL buffer ring buffer 结构图，标注当前写入位置
- **CLOGPageView**：二维矩阵，0=进行中(灰), 1=已提交(绿), 2=已中止(红)
- **CheckpointView**：checkpoint 触发后的 REDO 点计算过程

### 4.5 运行时数据结构快照

定时采集 PG 进程内存中的关键数据结构：

#### 4.5.1 结构定义（简化版）

```rust
// 快照数据结构 (Rust)
struct PGSnapshot {
    timestamp: u64,
    proc_array: Vec<PGProc>,
    xact_array: Vec<PGXact>,
    buffer_desc_array: Vec<BufferDesc>,
}

struct PGProc {
    pid: u32,
    database_id: u32,
    role_id: u32,
    xid: u32,
    xmin: u32,
    transaction_id: u32,
    wait_event_type: String,
    wait_event: String,
    query_start: u64,
}

struct BufferDesc {
    buffer_id: u32,
    relfilenode: u64,
    fork_num: u8,
    block_num: u32,
    ref_count: u32,
    is_dirty: bool,
    usage_count: u8,
}
```

#### 4.5.2 可视化组件

- **MemoryGridView**：网格展示 Buffer Pool，彩色编码（脏/干净/固定）
- **ProcListView**：表格展示 PGPROC 数组，含搜索/过滤
- **XactStateView**：实时事务状态列表

---

## 5. 数据模型与 API

### 5.1 WebSocket 消息格式

所有采集事件通过 WebSocket 推送，采用 JSON 格式：

```typescript
// 事件基类
interface ProbeEvent {
  type: string;          // 事件类型，如 "wal_insert", "buffer_pin"
  timestamp: number;     // Unix 微秒时间戳
  pid: number;           // PG backend PID
  seq: number;           // 事件序列号（用于排序）
  data: Record<string, unknown>; // 事件特有数据
}

// 示例：WAL Insert 事件
interface WALInsertEvent extends ProbeEvent {
  type: "wal_insert";
  data: {
    xlog_ptr: string;       // "0/16D4F30" 格式
    record_len: number;
    rmgr_id: number;
    rmgr_name: string;
    info: number;
    xid: number;
  };
}

// 示例：Buffer Pin 事件
interface BufferPinEvent extends ProbeEvent {
  type: "buffer_pin";
  data: {
    buffer_id: number;
    is_hit: boolean;
    relfilenode: number;
    fork_num: number;
    block_num: number;
  };
}

// 示例：事务状态事件
interface XactEvent extends ProbeEvent {
  type: "xact_state";
  data: {
    xid: number;
    vxid: string;
    state: "begin" | "commit" | "abort" | "savepoint" | "release" | "rollback_to";
    savepoint_name?: string;
    lsn?: string;
  };
}

// 示例：锁等待事件
interface LockWaitEvent extends ProbeEvent {
  type: "lock_wait";
  data: {
    locktag_hash: string;
    mode: string;
    pid: number;
    wait_time_us: number;
  };
}
```

### 5.2 Tauri Command API

前端通过 Tauri invoke 调用 Rust 后端命令：

```typescript
// frontend/src/api/commands.ts

// 连接目标 PG 实例
async function connectPG(config: PGConfig): Promise<void>

// 执行 SQL 并触发采集
async function executeSQL(sql: string): Promise<ExecuteResult>

// 启动 eBPF 采集（指定 PID 或全局）
async function startCollection(options: CollectOptions): Promise<void>

// 停止采集
async function stopCollection(): Promise<void>

// 获取 Buffer Pool 快照
async function getBufferSnapshot(): Promise<BufferDesc[]>

// 获取 PGPROC 快照
async function getProcSnapshot(): Promise<PGProc[]>

// 获取 WAL 文件内容（指定 LSN 范围）
async function getWALRange(startLSN: string, endLSN: string): Promise<WALRecord[]>

// 监听事件流（前端 WebSocket 接收）
async function subscribeEvents(handler: (event: ProbeEvent) => void): Promise<void>

// 文件系统观察（监控 data directory）
async function watchDataDir(path: string): Promise<void>
```

### 5.3 类型定义

```typescript
// frontend/src/types/pg.ts

interface PGConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

interface CollectOptions {
  mode: "pid" | "global";
  target_pid?: number;
  enabled_probes: string[]; // 如 ["wal_insert", "buffer_pin", "xact_state"]
  sample_rate?: number;     // 采样率，1.0 = 全量
  buffer_size?: number;     // 事件缓冲区大小
}

interface BufferDesc {
  buffer_id: number;
  relfilenode: number;
  fork_num: number;
  block_num: number;
  ref_count: number;
  is_dirty: boolean;
  usage_count: number;
  last_access_time?: number;
}

interface WALRecord {
  lsn: string;
  record_len: number;
  rmgr_id: number;
  rmgr_name: string;
  info: number;
  xid: number;
  data: number[]; // hex bytes
}

interface PGProc {
  pid: number;
  database_id: number;
  role_id: number;
  xid: number;
  xmin: number;
  wait_event_type: string;
  wait_event: string;
  query: string;
  query_start: number;
  xact_start: number;
}
```

---

## 6. 前端设计

### 6.1 技术栈

- **React 18** + TypeScript（严格模式）
- **Tauri 2.x**（桌面 Shell，通过 `@tauri-apps/api` 调用命令）
- **D3.js v7**（可视化渲染引擎）
- **Zustand**（状态管理）
- **Vite**（构建工具）
- **TailwindCSS**（样式，仅用于布局辅助，D3 处理核心可视化样式）

### 6.2 页面结构

```
App
├── Layout
│   ├── Header (Logo + 连接状态 + 操作按钮)
│   ├── Sidebar (功能导航菜单)
│   └── MainContent
│       ├── SQLConsole (SQL 输入 + 执行)
│       ├── PipelineView (当前 Pipeline 可视化)
│       ├── BufferHeatmap (Buffer Pool 热图)
│       ├── LockGraph (锁等待图)
│       ├── WALViewer (WAL 记录查看)
│       ├── CLOGViewer (CLOG 页面查看)
│       └── MemoryStructView (运行时结构)
└── StatusBar (采集状态、事件计数)
```

### 6.3 核心组件设计

#### 6.3.1 PipelineView

```tsx
// 组件职责：展示 SQL 执行全流程的时间线动画

interface PipelineStage {
  id: string;
  name: string;
  duration_us: number;
  start_us: number;
  end_us: number;
  details: Record<string, unknown>;
  status: "pending" | "active" | "done" | "error";
}

function PipelineView({ stages }: { stages: PipelineStage[] }) {
  // 渲染横向时间线
  // 每个 stage = 一个节点，节点间连线
  // 动画：从左到右依次亮起
  // 点击节点：展开详细数据面板
  // 支持重放、暂停、倍速
}
```

#### 6.3.2 BufferHeatmapView

```tsx
// 组件职责：Buffer Pool 的 NxM 热图网格

interface BufferCell {
  buffer_id: number;
  hit_count: number;
  is_dirty: boolean;
  is_pinned: boolean;
  relfilenode: number;
}

function BufferHeatmapView({ buffers }: { buffers: BufferCell[] }) {
  // N 列（可配置，默认 32）
  // 每个 cell = 方形，hover 显示详情
  // 颜色编码：
  //   - 未使用：灰色
  //   - 冷（低访问）：蓝 → 绿
  //   - 热（高访问）：橙 → 红
  //   - 脏页：边框高亮红
}
```

#### 6.3.3 LockGraphView

```tsx
// 组件职责：D3 力导向图展示锁等待关系

function LockGraphView({ lockNodes, lockEdges }: {
  lockNodes: { id: string; pid: number; label: string }[];
  lockEdges: { source: string; target: string; wait_time: number }[];
}) {
  // 节点 = PID（或 lock 对象）
  // 边 = 等待关系（有向边 from waiter to holder）
  // 死锁检测：高亮形成环的路径
  // 支持缩放、拖拽、节点搜索
}
```

### 6.4 响应式设计

- **桌面**：三栏布局（侧边栏 200px + 内容区 + 详情面板 300px）
- **平板**：两栏（侧边栏可收起 + 内容区）
- **手机**：单栏（底部 Tab 切换，滑动切换视图）

---

## 7. eBPF 采集层设计

### 7.1 技术选型

- **框架**：Aya（纯 Rust eBPF 框架）
- **目标内核**：Linux 5.8+（支持 BTF）
- **部署**：作为独立子进程运行，通过 WebSocket 向 Tauri 后端推送数据

### 7.2 Probe 定义

```rust
// backend/collector/ebpf/src/probes.rs

// 定义所有需要挂载的探针
pub const PROBES: &[&str] = &[
    // 事务
    "transaction__begin",
    "transaction__commit__log",
    "transaction__abort__log",
    "transaction__savepoint__create",

    // WAL
    "xlog__insert__enter",
    "xlog__insert__return",
    "xlog__flush__enter",
    "xlog__flush__return",

    // Buffer
    "bufmgr__pin_buffer__enter",
    "bufmgr__pin_buffer__return",
    "bufmgr__unpin_buffer__enter",

    // 执行器
    "exec__simple_query__start",
    "exec__simple_query__end",
    "exec__end",

    // 锁
    "lock__acquire__request",
    "lock__acquire__acquired",
    "lock__wait__start",
    "lock__wait__end",

    // CLOG
    "transactionlog__insert",
    "transactionlog__fetch",
];
```

### 7.3 eBPF 程序结构

```rust
// backend/collector/ebpf/src/programs/

// WAL Insert 探针
#[tracepoint]  // 或使用 uprobe/kprobe
fn xlog_insert(ctx: BpfContext) -> u32 {
    let xlog_ptr = read_xlog_ptr_from_ctx(ctx);
    let record_len = read_record_len(ctx);
    let rmgr_id = read_rmgr_id(ctx);

    let event = WALInsertEvent {
        xlog_ptr,
        record_len,
        rmgr_id,
        timestamp: bpf_ktime_get_ns(),
        pid: get_current_pid(),
    };

    ringbuf_output(&EVENTS, &event);
    0
}

// Buffer Pin 探针
#[tracepoint]
fn buffer_pin(ctx: BpfContext) -> u32 {
    let buffer_id = read_buffer_id(ctx);
    let is_hit = read_buffer_hit_flag(ctx);

    let event = BufferPinEvent {
        buffer_id,
        is_hit,
        timestamp: bpf_ktime_get_ns(),
        pid: get_current_pid(),
    };

    ringbuf_output(&EVENTS, &event);
    0
}
```

### 7.4 用户态程序（Rust）

```rust
// backend/collector/ebpf/src/collector.rs

useaya::aya::Aya;
useaya::aya::programs::TracePoint;

// 加载 eBPF 程序并启动探针
pub struct EBpfCollector {
    aya: Aya,
    rb: PerfBuffer<ProbeEvent>,
}

impl EBpfCollector {
    pub fn attach(probes: &[&str]) -> Result<Self> {
        let mut aya = Aya::load()?;

        // 挂载所有探针
        for probe_name in probes {
            let prog = aya.program_mut(probe_name)?;
            let tracepoint = prog.attach_tracepoint(None, probe_name)?;
        }

        // 设置 ring buffer 接收
        let rb = aya.map("EVENTS")?.into_ringbuf()?;
        Ok(Self { aya, rb })
    }

    pub fn start(mut self, ws_sender: tokio::sync::mpsc::Sender<ProbeEvent>) {
        // 从 ring buffer 读取事件，通过 channel 发送到 WS 服务
    }
}
```

### 7.5 采集模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| 全局模式 | 挂载所有 PG backend 进程 | 学习演示 |
| PID 模式 | 仅采集指定 PID | 调试特定连接 |
| 采样模式 | 按采样率随机采集 | 生产环境低开销 |

---

## 8. Go 后端服务设计

### 8.1 项目结构

```
backend/
├── cmd/
│   └── server/
│       └── main.go           # 主入口
├── internal/
│   ├── config/
│   │   └── config.go         # 配置加载
│   ├── ws/
│   │   ├── hub.go            # WebSocket Hub（广播中心）
│   │   └── client.go         # 单个 WS 客户端
│   ├── collector/
│   │   └── collector.go      # 采集器管理（启动/停止 eBPF 子进程）
│   ├── pg/
│   │   ├── client.go         # PG Wire Protocol 客户端
│   │   └── parser.go         # 简单 SQL 解析
│   ├── fs/
│   │   └── watcher.go        # 文件系统观察（inotify）
│   ├── snapshot/
│   │   └── snapshot.go        # 内存快照管理
│   └── api/
│       └── handler.go        # Tauri command handler
├── pkg/
│   ├── event/
│   │   ├── event.go          # 事件类型定义
│   │   └── encoder.go       # JSON 编码
│   └── wal/
│       ├── reader.go         # WAL 文件读取
│       └── parser.go         # WAL record 解析
└── go.mod
```

### 8.2 核心模块

#### 8.2.1 WebSocket Hub

```go
// ws/hub.go
// 管理所有前端 WebSocket 连接，广播采集事件

type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
    mu         sync.RWMutex
}

func (h *Hub) Run() {
    for {
        select {
        case client := <-h.register:
            h.mu.Lock()
            h.clients[client] = true
            h.mu.Unlock()

        case client := <-h.unregister:
            h.mu.Lock()
            delete(h.clients, client)
            h.mu.Unlock()

        case message := <-h.broadcast:
            h.mu.RLock()
            for client := range h.clients {
                select {
                case client.send <- message:
                default:
                    close(client.send)
                }
            }
            h.mu.RUnlock()
        }
    }
}
```

#### 8.2.2 PG 客户端

```go
// pg/client.go
// 使用原生 PostgreSQL Wire Protocol 连接 PG，无需 libpq

type PGClient struct {
    conn    net.Conn
    buffers *bufio.Reader
}

// 支持的操作
func (c *PGClient) Execute(sql string) (*ExecuteResult, error)
func (c *PGClient) GetProcSnapshot() ([]PGProc, error)
func (c *PGClient) GetBufferMetadata() ([]BufferMeta, error)

// 连接管理
func (c *PGClient) Connect(addr, user, pass, db string) error
func (c *PGClient) Close() error
```

#### 8.2.3 文件系统观察器

```go
// fs/watcher.go
// 使用 inotify (Linux) / FSEvents (macOS) 监控 PG data directory

type DataDirWatcher struct {
    watcher notify.Watcher
    events  chan FileEvent
}

type FileEvent struct {
    Path    string
    Op      string  // "create", "modify", "delete"
    ModTime time.Time
}
```

### 8.3 Tauri Command 路由

```go
// api/handler.go
// 将 Go 函数暴露为 Tauri command

// [tauri::command]
func connect(config PGConfig) -> Result<(), Error>

// [tauri::command]
func execute_sql(sql string) -> Result<ExecuteResult, Error>

// [tauri::command]
func start_collector(options CollectOptions) -> Result<(), Error>

// [tauri::command]
func stop_collector() -> Result<(), Error>

// [tauri::command]
fn get_buffer_snapshot() -> Result<Vec<BufferDesc>, Error>

// [tauri::command]
fn get_proc_snapshot() -> Result<Vec<PGProc>, Error>

// [tauri::command]
fn get_wal_range(startLSN, endLSN string) -> Result<Vec<WALRecord>, Error>
```

---

## 9. 目录结构

```
pg-visualizer/
├── README.md                 # 本文档（详细设计）
├── design.md                 # 概要设计
├── need.md                   # 需求文档
├── CLAUDE.md                 # AI 开发指南
│
├── docker-compose.yml        # 生产环境 Docker Compose
├── docker-compose.dev.yml    # 开发环境 Docker Compose
├── docker-compose.test.yml   # CI 测试环境 Docker Compose
├── .env.example              # 环境变量模板
│
├── src-tauri/                 # Tauri + Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Tauri 配置
│   ├── src/
│   │   ├── main.rs           # Tauri 入口
│   │   ├── lib.rs            # 库入口
│   │   ├── commands/         # Tauri command handlers
│   │   │   ├── mod.rs
│   │   │   ├── pg.rs         # PG 连接命令
│   │   │   ├── collector.rs  # 采集器命令
│   │   │   └── snapshot.rs   # 快照命令
│   │   ├── ws/
│   │   │   ├── mod.rs
│   │   │   └── hub.rs        # WebSocket Hub
│   │   ├── collector/       # 采集器子进程管理
│   │   │   ├── mod.rs
│   │   │   └── process.rs    # 子进程启动/通信
│   │   └── pg/
│   │       ├── mod.rs
│   │       └── wire.rs       # PG Wire Protocol 实现
│   └── icons/                # 应用图标
│
├── backend/                   # Go 后端服务
│   ├── Dockerfile             # 生产镜像构建
│   ├── Dockerfile.dev        # 开发镜像构建（热重载）
│   ├── go.mod
│   ├── cmd/
│   │   └── server/
│   │       └── main.go       # 主入口
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go     # 配置加载（支持 env）
│   │   ├── ws/
│   │   │   ├── hub.go        # WebSocket Hub（广播中心）
│   │   │   └── client.go     # 单个 WS 客户端
│   │   ├── collector/
│   │   │   └── collector.go  # 采集器管理（启动/停止子进程）
│   │   ├── pg/
│   │   │   ├── client.go     # PG Wire Protocol 客户端
│   │   │   └── parser.go     # 简单 SQL 解析
│   │   ├── fs/
│   │   │   └── watcher.go    # 文件系统观察（inotify）
│   │   ├── snapshot/
│   │   │   └── snapshot.go   # 内存快照管理
│   │   └── api/
│   │       └── handler.go    # HTTP handler
│   └── pkg/
│       ├── event/
│       │   ├── event.go      # 事件类型定义
│       │   └── encoder.go    # JSON 编码
│       └── wal/
│           ├── reader.go     # WAL 文件读取
│           └── parser.go      # WAL record 解析
│
├── src/                      # React 前端
│   ├── Dockerfile             # 生产镜像构建
│   ├── Dockerfile.dev        # 开发镜像构建
│   ├── nginx.conf            # Nginx 配置（生产）
│   ├── vite.config.ts
│   ├── package.json
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── StatusBar.tsx
│   │   ├── sql/
│   │   │   └── SQLConsole.tsx
│   │   ├── pipeline/
│   │   │   └── PipelineView.tsx
│   │   ├── buffer/
│   │   │   └── BufferHeatmapView.tsx
│   │   ├── lock/
│   │   │   └── LockGraphView.tsx
│   │   ├── wal/
│   │   │   └── WALViewer.tsx
│   │   ├── clog/
│   │   │   └── CLOGViewer.tsx
│   │   └── memory/
│   │       └── MemoryStructView.tsx
│   ├── views/
│   │   ├── HomeView.tsx
│   │   ├── WriteView.tsx
│   │   ├── ReadView.tsx
│   │   ├── TransactionView.tsx
│   │   └── WALView.tsx
│   ├── hooks/
│   │   ├── useWebSocket.ts
│   │   ├── usePGConnection.ts
│   │   └── useTauriCommands.ts
│   ├── stores/
│   │   ├── eventStore.ts     # 采集事件状态（Zustand）
│   │   ├── pgStore.ts        # PG 连接状态
│   │   └── uiStore.ts        # UI 状态
│   ├── types/
│   │   ├── pg.ts             # PG 数据类型
│   │   └── events.ts         # 事件类型
│   └── styles/
│       └── index.css
│
├── collector/                 # eBPF 采集器（独立 Rust 项目）
│   ├── Dockerfile             # 生产镜像构建
│   ├── Dockerfile.dev        # 开发镜像构建
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # 入口：启动 + 连接 WS 后端
│   │   ├── probe/
│   │   │   ├── mod.rs
│   │   │   ├── xact.rs       # 事务探针
│   │   │   ├── wal.rs        # WAL 探针
│   │   │   ├── buffer.rs     # Buffer 探针
│   │   │   └── lock.rs       # 锁探针
│   │   ├── bpf/
│   │   │   ├── xact.bpf.c    # 事务 eBPF C 代码
│   │   │   ├── wal.bpf.c
│   │   │   ├── buffer.bpf.c
│   │   │   └── lock.bpf.c
│   │   └── event.rs          # 事件序列化
│   └── build.sh              # eBPF 程序编译脚本
│
├── k8s/                      # Kubernetes 部署（可选）
│   ├── values.yaml           # Helm values
│   └── deployment.yaml       # K8s manifests
│
├── docs/                     # 设计文档
│   ├── api.md               # WebSocket API 详细定义
│   ├── probes.md            # 探针完整清单
│   └── wal-format.md        # WAL 格式详解
│
└── tests/
    ├── e2e/                 # 端到端测试（Playwright）
    └── unit/                # 单元测试
```

---

## 10. 实施计划

### 阶段一：P0 — MVP（MVP）

**目标**：最小可用产品，验证核心链路

| 任务 | 负责人 | 交付物 |
|------|--------|--------|
| T0.1 项目初始化 | - | Tauri 项目创建、前端/后端/采集器目录结构 |
| T0.2 PG Wire Protocol 客户端 | - | Go 连接 PG、执行 SQL、解析结果 |
| T0.3 WebSocket Hub | - | Go WS 服务 + 前端订阅 |
| T0.4 静态 WAL 解析 | - | 读取 WAL 文件并解析为结构化数据 |
| T0.5 静态 CLOG 读取 | - | 读取 CLOG page 并解析事务状态 |
| T0.6 前端基础 UI | - | 布局 + SQL 控制台 + 静态数据展示 |
| T0.7 集成联调 | - | SQL 执行 → 静态数据 → 可视化完整链路 |

**验收**：用户输入 SQL → 前端显示 WAL record 和 CLOG 状态（静态，无动画）

### 阶段二：P1 — 写入 Pipeline

| 任务 | 交付物 |
|------|--------|
| T1.1 eBPF 探针框架 | Aya 探针加载 + 事件 ring buffer |
| T1.2 WAL Insert 探针 | 采集 XLogInsert 事件 |
| T1.3 Buffer Pin 探针 | 采集 buffer pin/unpin 事件 |
| T1.4 PipelineView 可视化 | 时间线动画组件 |
| T1.5 BufferHeatmap | Buffer 热图组件 |

**验收**：INSERT 语句 → 动态 Pipeline 动画（各阶段依次亮起）

### 阶段三：P2 — 读取 Pipeline + MVCC

| 任务 | 交付物 |
|------|--------|
| T2.1 Plan Tree 探针 | 采集 planner 输出 |
| T2.2 MVCC 可见性探针 | 采集 HeapTupleSatisfiesMVCC |
| T2.3 Buffer Hit/Miss 探针 | 采集 buffer 命中事件 |
| T2.4 PlanTreeView | 执行计划树可视化 |
| T2.5 MVCCTimelineView | MVCC 可见性时间线 |

**验收**：SELECT 语句 → 执行计划树 + MVCC 判断过程

### 阶段四：P3 — 事务可视化

| 任务 | 交付物 |
|------|--------|
| T3.1 事务状态探针 | 采集 begin/commit/abort |
| T3.2 锁探针 | 采集 lock acquire/wait/release |
| T3.3 TransactionStateView | 事务状态机动画 |
| T3.4 LockGraphView | 锁等待力导向图 + 死锁检测 |

**验收**：并发事务 → 状态机动画 + 锁等待图（含死锁高亮）

### 阶段五：P4 — 运行时快照

| 任务 | 交付物 |
|------|--------|
| T4.1 内存快照采集 | 读取 PG 进程内存结构 |
| T4.2 MemoryStructView | 实时内存结构图 |
| T4.3 文件观察器 | 监控 data directory 变化 |

**验收**：实时刷新 PGPROC/PGXACT/Buffer Pool 可视化

### 阶段六：P5 — 扩展

| 任务 | 交付物 |
|------|--------|
| P5.1 Parser 演示 | SQL 词法/语法分析树可视化 |
| P5.2 Optimizer 演示 | 规划器代价估算可视化 |
| P5.3 跨平台测试 | iOS/Android 兼容性测试 |

---

## 11. 云原生部署设计

### 11.1 设计目标

所有组件支持 Docker 容器化部署，前期验证测试完全基于 Docker 环境进行。

### 11.2 容器划分

| 容器镜像 | 语言/框架 | 职责 | 基础镜像 |
|----------|-----------|------|---------|
| `pg-visualizer-pg` | PostgreSQL (C) | 被观测数据库实例 | `postgres:18` |
| `pg-visualizer-backend` | Go 1.21+ | API 服务 + WebSocket Hub + 采集器管理 | `golang:1.21-alpine` |
| `pg-visualizer-collector` | Rust (Aya) | eBPF 探针运行（需要特权） | `rust:1.75-alpine` + BTF |
| `pg-visualizer-frontend` | React + Vite (Node) | 前端静态资源 | `nginx:alpine` |

### 11.3 Docker Compose 架构

```yaml
# docker-compose.yml
version: "3.9"

services:
  # 被观测的 PostgreSQL 实例
  postgres:
    image: postgres:18
    container_name: pg-visualizer-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    command:
      - "postgres"
      - "-cshared_buffers=256MB"
      - "-cmax_connections=100"
      - "-clog_min_messages=log"
      # 启用 WAL 详细日志以便采集
      - "-cwal_level=logical"
      - "-cmax_wal_senders=10"
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Go 后端服务
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: pg-visualizer-backend
    environment:
      PG_HOST: postgres          # Docker DNS name
      PG_PORT: 5432
      PG_USER: postgres
      PG_PASSWORD: postgres
      PG_DATABASE: postgres
      API_PORT: 3000
      COLLECTOR_WS_URL: ws://collector:8090
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  # eBPF 采集器（需要 privileged 权限）
  collector:
    build:
      context: ./collector
      dockerfile: Dockerfile
    container_name: pg-visualizer-collector
    environment:
      BACKEND_WS_URL: ws://backend:8080
      COLLECTOR_PORT: 8090
      PG_DATA_DIR: /var/lib/postgresql/data
    network_mode: host          # eBPF 需要 host 网络访问
    cap_add:
      - SYS_ADMIN               # eBPF 必需
      - SYS_RESOURCE
      - NET_RAW
      - NET_BIND_SERVICE
    security_opt:
      - seccomp=unconfined       # 允许所有 syscalls
    volumes:
      - /lib/modules:/lib/modules:ro  # 内核模块（BTF）
      - pg_data:/var/lib/postgresql/data
    depends_on:
      - postgres
    # 仅 Linux 支持 eBPF，macOS/Windows 跳过
    profiles:
      - "linux-only"

  # 前端（静态资源 + 可选 SSR）
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: pg-visualizer-frontend
    ports:
      - "80:80"                  # nginx serves static files
    depends_on:
      - backend
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost/"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  pg_data:

networks:
  default:
    name: pg-visualizer-net
```

### 11.4 镜像 Dockerfile 设计

#### 11.4.1 后端（Go）

```dockerfile
# backend/Dockerfile
FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" \
    -o /app/server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/server .

EXPOSE 3000 8080

# 健康检查
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/server"]
```

#### 11.4.2 eBPF 采集器（Rust）

```dockerfile
# collector/Dockerfile
FROM rust:1.75 AS builder

# 安装 BTF 生成依赖
RUN apt-get update && apt-get install -y \
    clang llvm libelf-dev libbpf-dev linux-headers-amd64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制源码（分开 COPY 利用缓存）
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# 重新复制完整源码并编译
COPY . .
RUN cargo build --release

FROM ubuntu:22.04
# 需要内核头文件以运行 eBPF
RUN apt-get update && apt-get install -y \
    libelf1 clang llvm libbpfcc-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/pg-collector /app/collector

# eBPF 程序在运行时加载，不需要预编译
# 但需要挂载 /sys/kernel/debug 和 /sys/fs/bpf

ENTRYPOINT ["/app/collector"]
```

#### 11.4.3 前端（Nginx）

```dockerfile
# frontend/Dockerfile
# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# 运行阶段
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -q --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

对应的 `frontend/nginx.conf`：

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # 前端 SPA 路由
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 代理后端 API
    location /api/ {
        proxy_pass http://backend:3000/;
        proxy_set_header Host $host;
    }

    # 代理 WebSocket
    location /ws/ {
        proxy_pass http://backend:8080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

### 11.5 前端构建 Dockerfile（带 Tauri）

若前端需要同时打包 Tauri 桌面应用（非纯 Web 部署），则使用多阶段构建：

```dockerfile
# frontend/Dockerfile (with Tauri)
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM tauri-builder:2.x AS tauri-builder
WORKDIR /app
# 复制前端构建产物和 Tauri 源码
COPY --from=frontend-builder /app/dist /app/src-tauri/dist
COPY src-tauri /app/src-tauri

RUN cargo tauri build --bundles none  # 仅构建二进制，不打包

# 最终镜像（桌面应用分发用）
FROM ubuntu:22.04
COPY --from=tauri-builder /app/src-tauri/target/release/pg-visualizer /usr/local/bin/
ENTRYPOINT ["pg-visualizer"]
```

### 11.6 环境变量配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PG_HOST` | PostgreSQL 主机 | `postgres` |
| `PG_PORT` | PostgreSQL 端口 | `5432` |
| `PG_USER` | 连接用户 | `postgres` |
| `PG_PASSWORD` | 连接密码 | `postgres` |
| `PG_DATABASE` | 默认数据库 | `postgres` |
| `API_PORT` | 后端 HTTP 端口 | `3000` |
| `COLLECTOR_PORT` | 采集器 WS 端口 | `8090` |
| `BACKEND_WS_URL` | 采集器连接后端 WS URL | `ws://backend:3000` |
| `ENABLE_EBPF` | 是否启用 eBPF | `true` (仅 Linux) |
| `LOG_LEVEL` | 日志级别 | `info` |

### 11.7 多架构支持

```yaml
# docker-compose.arm64.yml
services:
  backend:
    platform: linux/arm64/v8
    build:
      context: ./backend
      dockerfile: Dockerfile.arm64
  collector:
    platform: linux/arm64/v8
    build:
      context: ./collector
      dockerfile: Dockerfile.arm64
  # postgres 使用官方 multi-arch 镜像
  postgres:
    platform: linux/amd64  # x86 emulation for arm64 host
```

### 11.8 开发模式

```yaml
# docker-compose.dev.yml
version: "3.9"

services:
  postgres:
    image: postgres:18
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
      - "8080:8080"
    volumes:
      - ./backend:/app       # 热重载
    environment:
      DEBUG: "true"
    command: ["air", "-c", ".air.toml"]

  collector:
    build:
      context: ./collector
      dockerfile: Dockerfile.dev
    volumes:
      - ./collector:/app    # 热重载
    network_mode: host
    cap_add:
      - SYS_ADMIN
    security_opt:
      - seccomp=unconfined

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app     # Vite HMR
    command: ["pnpm", "dev", "--host"]
    depends_on:
      - backend
```

对应的 `backend/Dockerfile.dev`：

```dockerfile
FROM golang:1.21-alpine
RUN go install github.com/air-verse/air@latest
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
EXPOSE 3000 8080
CMD ["air", "-c", ".air.toml"]
```

### 11.9 CI/CD 测试流水线

```yaml
# .github/workflows/test.yml
name: Docker Build & Test

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-images:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU (multi-arch)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build backend image
        run: |
          docker build -f backend/Dockerfile -t pg-visualizer-backend:${{ github.sha }} ./backend

      - name: Build frontend image
        run: |
          docker build -f frontend/Dockerfile -t pg-visualizer-frontend:${{ github.sha }} ./frontend

      - name: Build collector image
        run: |
          docker build -f collector/Dockerfile -t pg-visualizer-collector:${{ github.sha }} ./collector

      - name: Start stack for testing
        run: |
          docker compose -f docker-compose.test.yml up -d postgres backend frontend

      - name: Run integration tests
        run: |
          # 等待服务就绪
          sleep 10
          docker compose -f docker-compose.test.yml run --rm test-runner \
            pnpm test:integration

      - name: Stop stack
        if: always()
        run: docker compose -f docker-compose.test.yml down
```

对应的 `docker-compose.test.yml`（用于 CI）：

```yaml
# docker-compose.test.yml
version: "3.9"

services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres

  backend:
    image: pg-visualizer-backend:${GHA_SHA}
    environment:
      PG_HOST: postgres
      PG_PORT: 5432
      PG_USER: postgres
      PG_PASSWORD: postgres
      PG_DATABASE: postgres

  frontend:
    image: pg-visualizer-frontend:${GHA_SHA}

  test-runner:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./tests:/app/tests
    depends_on:
      - backend
      - frontend
    command: ["sleep", "infinity"]  # 等待手动测试或脚本执行
```

### 11.10 Kubernetes 部署（可选扩展）

```yaml
# k8s/values.yaml
# Helm chart values for production K8s deployment

backend:
  replicaCount: 2
  service:
    type: ClusterIP
    ports:
      api: 3000
      ws: 8080
  env:
    PG_HOST: postgres-svc
    PG_PORT: "5432"
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

collector:
  enabled: true  # Linux only
  # 需要 DaemonSet 运行在每个支持 eBPF 的节点
  daemonset:
    nodeSelector:
      ebpfsupported: "true"
    tolerations:
      - operator: Exists

frontend:
  replicaCount: 2
  service:
    type: LoadBalancer
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

postgres:
  enabled: true
  # 使用官方 bitnami/postgresql chart
  persistence:
    enabled: true
    size: 10Gi
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1
      memory: 1Gi
```

### 11.11 eBPF 采集器的特殊考量

#### 11.11.1 为什么需要特权容器

eBPF 验证器要求程序满足安全约束，但在容器内运行时：
- `/sys/kernel/debug` 和 `/sys/fs/bpf` 需要可写
- 需要 `CAP_SYS_ADMIN` 和 `CAP_NET_RAW`
- 需要内核 BTF (BPF Type Format) 信息

#### 11.11.2 备选方案（无 eBPF 环境）

若 eBPF 不可用（如非特权环境），采集器降级为 **日志解析模式**：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| eBPF 模式 | 实时采集内核函数调用 | Linux 5.8+，特权容器 |
| log 解析模式 | 解析 `log_min_messages=log` 的 PG 日志 | 所有环境，非特权 |
| 模拟模式 | 生成预定义事件数据用于演示 | 开发/演示 |

```go
// 采集器自动检测可用模式
func detectCollectionMode() CollectionMode {
    // 检查 eBPF 支持
    if haveEBPF, _ := checkEBPFSupport(); haveEBPF {
        return EBpfMode
    }
    // 检查 PG 日志详细度
    if isLogBased(), _ := checkPGLogs(); isLogBased() {
        return LogParseMode
    }
    return SimulationMode
}
```

Docker Compose 中通过环境变量 `ENABLE_EBPF=false` 强制使用日志解析模式。

#### 11.11.3 macOS / Windows 的特殊处理

桌面端（macOS/Windows）不直接支持 eBPF，架构调整为：

```
macOS / Windows (Tauri 桌面应用)
    │
    ├─ 前端：Tauri WebView（原生窗口）
    ├─ 后端：Tauri Rust Backend（本地 Go 服务通过 TCP 连接）
    └─ 采集器：通过 Docker Desktop 容器运行 eBPF 采集器
```

即：Tauri 应用连接 Docker 容器中的采集器和 PG 实例。

---

*本文档为详细设计，是 `design.md`（概要设计）的完整实现指南。*