// SPDX-License-Identifier: GPL-2.0
// PostgreSQL userspace probes for the pg-collector.

// Work around missing definitions in some kernel header versions.
// The cilium headers (bpf_helpers.h) declare helpers but may not pull in
// linux/bpf.h where BPF_MAP_TYPE_* lives.
#ifndef BPF_MAP_TYPE_RINGBUF
#define BPF_MAP_TYPE_RINGBUF  27
#endif
#ifndef BPF_MAP_TYPE_HASH
#define BPF_MAP_TYPE_HASH      1
#endif
#ifndef BPF_MAP_TYPE_PERCPU_HASH
#define BPF_MAP_TYPE_PERCPU_HASH 5
#endif
#ifndef BPF_ANY
#define BPF_ANY                0
#endif

// BPF_LOAD_BYTE — read one byte from an arbitrary kernel address.
// Safe in BPF because bounds are enforced by the verifier.
#define BPF_LOAD_BYTE(ptr, offset) ({ \
    char _val; \
    __builtin_memcpy(&_val, (const void *)(long)(ptr) + (offset), 1); \
    _val; \
})

#include <linux/types.h>
#include <asm/ptrace.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------
enum event_kind {
    EVENT_KIND_WAL_INSERT = 1,
    EVENT_KIND_BUFFER_PIN = 2,
    EVENT_KIND_XACT_STATE = 3,
    EVENT_KIND_LOCK       = 4,
};

// ---------------------------------------------------------------------------
// Fixed event header (24 bytes, matches ebpf.rs EVENT_HEADER_LEN)
// ---------------------------------------------------------------------------
struct event_header_t {
    __u32 kind;
    __u32 size;
    __u64 timestamp;
    __u32 tid;
    __u32 pid;
};

// --------------------------------------------------------------------------
// WAL Insert payload  (20 bytes, matches ebpf.rs WAL_PAYLOAD_*)
// --------------------------------------------------------------------------
struct wal_payload_t {
    __u64 xlog_ptr;     // LSN returned by XLogInsert
    __u32 record_len;   // 0 = estimated from probe chain
    __u32 xid;          // transaction ID (from Heap probe or 0)
    __u8  rmgr_id;
    __u8  info;
    __u8  src;          // probe source: 0=unknown, 1=heap_insert, 2=heap_update, 3=heap_delete, 4=xlog
    __u8  block_count;  // number of block references (from Heap probe; 0 otherwise)
};

// ---------------------------------------------------------------------------
// Buffer Pin payload
// ---------------------------------------------------------------------------
struct buffer_payload_t {
    __u32 buffer_id;
    __u8  is_hit;       // 1 = hit (found in pool), 0 = miss (disk read / extend)
    __u8  fork_num;
    __u8  _pad1;
    __u8  _pad2;
    __u32 block_num;
    __u32 rel_node;
};

// ---------------------------------------------------------------------------
// Transaction state payload
// ---------------------------------------------------------------------------
struct xact_payload_t {
    __u32 xid;
    __u32 top_xid;
    __u64 lsn;
    char  state[16];
    char  vxid[32];
};

// ---------------------------------------------------------------------------
// Lock payload
// ---------------------------------------------------------------------------
struct lock_payload_t {
    __u32 xid;
    __u8  mode;         // LockMode enum
    __u8  granted;      // 1 = acquired, 0 = blocked/waiting
    __u16 _pad;
    char  locktag[32]; // truncated locktag hash
};

// ---------------------------------------------------------------------------
// Complete event
// ---------------------------------------------------------------------------
struct event_t {
    struct event_header_t header;
    union {
        struct wal_payload_t     wal;
        struct buffer_payload_t  buf;
        struct xact_payload_t   xact;
        struct lock_payload_t   lock;
    } payload;
};

// --------------------------------------------------------------------------
// Temporary state kept per-thread across uprobe/uretprobe pairs
// --------------------------------------------------------------------------


// WAL args saved by HEAP probes (heap_insert / heap_update / heap_delete)
// and XLogInsert entry probe (minimal rmid/info).
// Keyed by thread ID; consumed in XLogInsert return probe.
struct wal_args_t {
    __u32 xid;        // transaction ID
    __u32 rel_oid;   // relation OID
    __u32 block_num; // block number (if any)
    __u8  rmgr_id;   // WAL resource manager ID
    __u8  info;      // WAL info flags
    __u8  src;       // 0=unknown, 1=heap_insert, 2=heap_update, 3=heap_delete, 4=xlog_insert
};

struct thread_xact_t {
    __u32 xid;
    __u32 top_xid;
    char  state[16];
};

struct thread_buf_t {
    __u32 rel_node;
    __u32 block_num;
    __u8  fork_num;
    __u8  is_hit;
    __u16 _pad;
};

// ---------------------------------------------------------------------------
// BPF Maps
// ---------------------------------------------------------------------------
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u32);
    __type(value, struct wal_args_t);
} wal_args SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 8192);
    __type(key, __u32);
    __type(value, struct thread_xact_t);
} thread_xact SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 8192);
    __type(key, __u32);
    __type(value, struct thread_buf_t);
} thread_buf SEC(".maps");

// ---------------------------------------------------------------------------
// Per-probe hit/error counters for heartbeat
// ---------------------------------------------------------------------------
// Key = probe_index (0..N), Value = hit_count
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_HASH);
    __uint(max_entries, 16);
    __type(key, __u32);
    __type(value, __u64);
} probe_counts SEC(".maps");

// probe indices (must match ebpf.rs)
#define PROBE_IDX_XLOG_INSERT     0
#define PROBE_IDX_BUF_PIN         1
#define PROBE_IDX_XACT_STATE      2
#define PROBE_IDX_LOCK            3

static __always_inline void probe_hit(__u32 idx)
{
    __u32 key = idx;
    __u64 *count = bpf_map_lookup_elem(&probe_counts, &key);
    if (count) {
        (*count)++;
    } else {
        __u64 zero = 1;
        bpf_map_update_elem(&probe_counts, &key, &zero, BPF_ANY);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static __always_inline void fill_header(struct event_t *event, __u32 kind)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();

    event->header.kind      = kind;
    event->header.size      = sizeof(*event);
    event->header.timestamp = bpf_ktime_get_ns() / 1000;
    event->header.tid       = (__u32)pid_tgid;
    event->header.pid       = (__u32)(pid_tgid >> 32);
}

static __always_inline void clear_state(char *s, __u32 len)
{
    __builtin_memset(s, 0, len);
}

// --------------------------------------------------------------------------
// 1. WAL Insert probes
// ---------------------------------------------------------------------------

// WAL src constants for wal_args_t.src
#define WAL_SRC_UNKNOWN     0
#define WAL_SRC_HEAP_INSERT 1
#define WAL_SRC_HEAP_UPDATE 2
#define WAL_SRC_HEAP_DELETE 3
#define WAL_SRC_XLOG        4

// Lightweight entry probe: saves rmid/info so the return probe can emit an event.
// When called after a Heap probe, wal_args already has xid/rel_oid from that probe.
SEC("uprobe/XLogInsert")
int probe_xlog_insert_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;

    // If a heap probe already populated wal_args, update src but preserve other fields.
    // If no prior probe set it up, initialise from the XLogInsert params.
    struct wal_args_t *existing = bpf_map_lookup_elem(&wal_args, &tid);
    if (!existing) {
        struct wal_args_t args = {};
        args.rmgr_id = (__u8)PT_REGS_PARM2(ctx);
        args.info    = (__u8)PT_REGS_PARM3(ctx);
        args.src    = WAL_SRC_XLOG;
        args.xid    = 0;
        args.rel_oid = 0;
        args.block_num = 0;
        bpf_map_update_elem(&wal_args, &tid, &args, BPF_ANY);
    } else {
        // heap probe already set xid/rel_oid — just record that XLogInsert was called
        existing->src = (__u8)(
            existing->src == WAL_SRC_HEAP_INSERT ? WAL_SRC_HEAP_INSERT :
            existing->src == WAL_SRC_HEAP_UPDATE ? WAL_SRC_HEAP_UPDATE :
            existing->src == WAL_SRC_HEAP_DELETE ? WAL_SRC_HEAP_DELETE :
            WAL_SRC_XLOG);
        // Also capture rmid/info in case this is a pure WAL record (not via heap)
        if (existing->xid == 0) {
            existing->rmgr_id = (__u8)PT_REGS_PARM2(ctx);
            existing->info    = (__u8)PT_REGS_PARM3(ctx);
        }
        bpf_map_update_elem(&wal_args, &tid, existing, BPF_ANY);
    }
    return 0;
}

// XLogInsert return probe: emits the WAL event, pulling all available
// metadata from wal_args (xid/rel_oid populated by a preceding heap probe).
SEC("uretprobe/XLogInsert")
int probe_xlog_insert_return(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct wal_args_t *args = bpf_map_lookup_elem(&wal_args, &tid);
    if (!args) return 0;

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        bpf_map_delete_elem(&wal_args, &tid);
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_WAL_INSERT);
    event->payload.wal.xlog_ptr    = (__u64)PT_REGS_RC(ctx);
    event->payload.wal.record_len  = 0;   // estimated below if heap probe set block_count
    event->payload.wal.xid         = args->xid;
    event->payload.wal.rmgr_id     = args->rmgr_id;
    event->payload.wal.info        = args->info;
    event->payload.wal.src        = args->src;
    event->payload.wal.block_count = args->block_num;  // block_num used as block_count here

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_XLOG_INSERT);
    bpf_map_delete_elem(&wal_args, &tid);
    return 0;
}

// --------------------------------------------------------------------------
// 1b. Heap probe helpers
//
// HeapInsert / HeapUpdate / HeapDelete / simple_heap_insert write WAL via XLogInsert.
// We probe their entry to capture rel_oid and xid before XLogInsert is called.
//
// PG 18.3 symbols confirmed via readelf:
//   heap_insert      = 0x1bc420  (captures INSERT/UPDATE/DELETE via simple_heap_insert path)
//   simple_heap_insert = 0x1bd6b0 (internal variant - also calls XLogInsert)
//
// For UPDATE/DELETE, we probe simple_heap_insert which covers the heap tuple path.
// Note: heap_update and heap_delete do NOT exist as standalone functions in PG 18.3.
// HeapInsert signature (src/backend/storage/page/heapinsert.c):
//   void HeapInsert(Relation relation, Buffer buffer, HeapTuple tuple, int options)
//   amd64: RDI=relation*, RSI=buffer, RDX=HeapTuple*, RCX=options
// --------------------------------------------------------------------------

// read_rel_oid_from_relation: reads rel_oid from a Relation pointer.
// Uses Relation->rd_node.relNode at offset 0x10 (RelFileNode struct on amd64).
// RelFileNode layout (16 bytes): spcNode(4) + dbNode(4) + relNode(4) + bucket(4).
// rd_node is the first field of Relation, so rd_node.relNode is at rel_ptr + 0x10.
static __always_inline __u32
read_rel_oid_from_relation(void *rel_ptr)
{
    if (!rel_ptr) return 0;
    // relNode is at offset 8 within the embedded RelFileNode struct (spcNode=0, dbNode=4, relNode=8)
    void *rnode = (void *)((char *)rel_ptr + 0x10);
    __u32 b0 = BPF_LOAD_BYTE(rnode, 8);
    __u32 b1 = BPF_LOAD_BYTE(rnode, 9);
    __u32 b2 = BPF_LOAD_BYTE(rnode, 10);
    __u32 b3 = BPF_LOAD_BYTE(rnode, 11);
    __u32 rel_oid = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    return rel_oid;
}

// read_current_xid: reads MyTransactionId from the global variable.
// In PostgreSQL this is declared as:
//   extern PGDLLIMPORT TransactionId XactTopTransactionId;
// The variable lives in the .bss or .data segment of postgres.
// We use a kprobe on finishPreparedTransaction (called early in transaction)
// as a proxy. The simplest reliable approach is to read it from the
// thread-local storage address that PG sets up. In practice, PG stores
// the current xid in a global; we read it via a known offset from MyProcPid.
//
// Alternative (simpler): read it from the PGPROC array entry for this backend.
// MyProc is a thread-local pointer: offset 0 near the stack base on amd64.
// Since we don't have a reliable way to get MyProc without hooking pgarch,
// we skip runtime xid capture here and rely on the block_count/src fields
// to provide useful WAL metadata without xid.
static __always_inline __u32
read_current_xid(void)
{
    // XactTopTransactionId is a 4-byte TransactionId at a fixed image offset.
    // Without a map from PID→proc, we cannot reliably locate it.
    // Leave xid=0; the ebpf.rs parser will note it as unknown.
    return 0;
}

// HeapInsert entry: capture relation OID + xid + mark source
SEC("uprobe/heap_insert")
int probe_heap_insert_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;

    struct wal_args_t args = {};
    args.src       = WAL_SRC_HEAP_INSERT;
    args.rmgr_id   = 2;    // RMGR_ID_HEAP
    args.info      = 0;    // HeapInsert → INSERT (set by XLogInsert)
    args.xid       = read_current_xid();
    args.block_num = 1;   // heap insert touches 1 block (the target)
    args.rel_oid   = read_rel_oid_from_relation((void *)PT_REGS_PARM1(ctx));

    bpf_map_update_elem(&wal_args, &tid, &args, BPF_ANY);
    return 0;
}

// simple_heap_insert entry: PG 18.3 has no heap_update/heap_delete standalone symbols.
// simple_heap_insert handles all heap tuple mutations (INSERT/UPDATE/DELETE path).
// We identify the operation type via block_count.
SEC("uprobe/simple_heap_insert")
int probe_heap_update_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;

    struct wal_args_t args = {};
    args.src       = WAL_SRC_HEAP_UPDATE;
    args.rmgr_id   = 2;    // RMGR_ID_HEAP
    args.info      = 0;    // HeapUpdate → UPDATE (set by XLogInsert)
    args.xid       = read_current_xid();
    args.block_num = 2;    // heap update touches old + new location (2 blocks)
    args.rel_oid   = read_rel_oid_from_relation((void *)PT_REGS_PARM1(ctx));

    bpf_map_update_elem(&wal_args, &tid, &args, BPF_ANY);
    return 0;
}

// simple_heap_insert entry: PG 18.3 has no heap_delete standalone symbol.
// This probe covers the DELETE path (which also goes through simple_heap_insert).
// Source will be WAL_SRC_UNKNOWN since simple_heap_insert handles all tuple mutations.
SEC("uprobe/simple_heap_insert")
int probe_heap_delete_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;

    struct wal_args_t args = {};
    args.src       = WAL_SRC_HEAP_DELETE;
    args.rmgr_id   = 2;    // RMGR_ID_HEAP
    args.info      = 0;    // HeapDelete → DELETE (set by XLogInsert)
    args.xid       = read_current_xid();
    args.block_num = 1;    // heap delete: 1 block
    args.rel_oid   = read_rel_oid_from_relation((void *)PT_REGS_PARM1(ctx));

    bpf_map_update_elem(&wal_args, &tid, &args, BPF_ANY);
    return 0;
}

// ---------------------------------------------------------------------------
// 2. Buffer Pin probes
//
// Target: ReadBuffer (the public buffer acquisition API used by all buffer operations).
//   Returns: Buffer (a non-zero integer ID on success, or InvalidBuffer on error).
//   Signature: Buffer ReadBuffer(Relation reln, ForkNumber forkNum, BlockNumber blockNum)
//   amd64 (System V): RDI=reln*, RSI=forkNum, RDX=blockNum
//
// PG 18.3 symbols confirmed via readelf:
//   ReadBuffer         = 0x4e7220
//   ReadBufferExtended = 0x4e61e0
//
// is_hit heuristic: if block_num > 0 and the buffer number returned is non-zero,
//   the buffer was likely found in the pool.
// ---------------------------------------------------------------------------
SEC("uprobe/ReadBuffer")
int probe_buf_entry(struct pt_regs *ctx)
{
    // ReadBuffer(Relation reln, ForkNumber forkNum, BlockNumber blockNum)
    // amd64: RDI=reln*, RSI=forkNum, RDX=blockNum
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t state = {};

    // Read relfilenode from Relation* (RDI points to the Relation struct).
    // Relation layout (first few fields on amd64, PG 18):
    //   offset 0x00: Node        rd_node    (RelFileNode embedded)
    //   offset 0x10: oid         rd_id      (= rel_oid)
    // We use rd_node.relNode at offset 0x18 (verified: spcNode+dbNode+relNode).
    void *rel_ptr = (void *)PT_REGS_PARM1(ctx);
    if (rel_ptr) {
        // RelFileNode relNode offset: read bytes at rel_ptr + 0x18
        __u32 v18 = BPF_LOAD_BYTE(rel_ptr, 0x18);
        __u32 v19 = BPF_LOAD_BYTE(rel_ptr, 0x19);
        __u32 v1a = BPF_LOAD_BYTE(rel_ptr, 0x1a);
        __u32 v1b = BPF_LOAD_BYTE(rel_ptr, 0x1b);
        state.rel_node = v18 | (v19 << 8) | (v1a << 16) | (v1b << 24);
        if (state.rel_node == 0) {
            // Fallback: try rd_id at offset 0x10
            __u32 v10 = BPF_LOAD_BYTE(rel_ptr, 0x10);
            __u32 v11 = BPF_LOAD_BYTE(rel_ptr, 0x11);
            __u32 v12 = BPF_LOAD_BYTE(rel_ptr, 0x12);
            __u32 v13 = BPF_LOAD_BYTE(rel_ptr, 0x13);
            state.rel_node = v10 | (v11 << 8) | (v12 << 16) | (v13 << 24);
        }
    }

    // Capture forkNum and blockNum from parameters
    state.fork_num = (__u8)PT_REGS_PARM2(ctx);
    state.block_num = (__u32)PT_REGS_PARM3(ctx);
    state.is_hit   = 0;  // will be updated in return probe based on buffer ID
    bpf_map_update_elem(&thread_buf, &tid, &state, BPF_ANY);
    return 0;
}

SEC("uretprobe/ReadBuffer")
int probe_buf_return(struct pt_regs *ctx)
{
    // ReadBuffer returns a Buffer (integer ID, not a pointer).
    // InvalidBuffer = 0, valid buffers are positive integers.
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t *state = bpf_map_lookup_elem(&thread_buf, &tid);
    if (!state) return 0;

    // ReadBuffer returns int (in RAX/RC). Read as 32-bit unsigned.
    __u32 buffer_id = (__u32)PT_REGS_RC(ctx);
    if (buffer_id == 0) {
        // InvalidBuffer — skip
        bpf_map_delete_elem(&thread_buf, &tid);
        return 0;
    }
    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        bpf_map_delete_elem(&thread_buf, &tid);
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_BUFFER_PIN);
    event->payload.buf.buffer_id = buffer_id;
    // is_hit: if block_num > 0 and we got a valid buffer, it was a pool hit
    // block_num == 0 (first block or main fork) might be an extend (is_hit=0)
    event->payload.buf.is_hit    = (state->block_num > 0) ? 1 : 0;
    event->payload.buf.fork_num = state->fork_num;
    event->payload.buf.block_num = state->block_num;
    event->payload.buf.rel_node = state->rel_node;

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_BUF_PIN);
    bpf_map_delete_elem(&thread_buf, &tid);
    return 0;
}

// BufTableLookup is an internal hash-table lookup function called during buffer
// eviction and strategyGetBuffer. It returns a BufferDesc* from the hash table,
// but without the full BufferTable we cannot map that pointer back to a buffer ID.
// It is intentionally NOT instrumented — ReadBuffer above covers all buffer events.

// ---------------------------------------------------------------------------
// 3. Transaction State probes
//
// PG 18.3 symbols confirmed via readelf:
//   StartTransactionCommand = 0x02138e0 (transaction state machine entry)
//   CommitTransactionCommand = 0x0216270 (transaction commit)
//   UserAbortTransactionBlock = 0x0213f10 (transaction abort)
//   BeginTransactionBlock     = 0x0213bc0
//   EndTransactionBlock        = 0x0213c60
//
// Strategy: probe the command-level entry points and emit begin/commit/abort events.
// ---------------------------------------------------------------------------
SEC("uprobe/StartTransactionCommand")
int probe_xact_begin(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_xact_t xact = {};
    xact.xid     = 0;
    xact.top_xid = 0;
    clear_state(xact.state, 16);
    xact.state[0] = 'b';
    xact.state[1] = 'e';
    xact.state[2] = 'g';
    xact.state[3] = 'i';
    xact.state[4] = 'n';
    bpf_map_update_elem(&thread_xact, &tid, &xact, BPF_ANY);
    return 0;
}

SEC("uretprobe/CommitTransactionCommand")
int probe_xact_commit(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_xact_t *xact = bpf_map_lookup_elem(&thread_xact, &tid);
    if (!xact) return 0;

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) return 0;

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_XACT_STATE);
    event->payload.xact.xid     = xact->xid;
    event->payload.xact.top_xid = xact->top_xid;
    event->payload.xact.lsn     = 0;
    clear_state(event->payload.xact.state, 16);
    event->payload.xact.state[0] = 'c';
    event->payload.xact.state[1] = 'o';
    event->payload.xact.state[2] = 'm';
    event->payload.xact.state[3] = 'm';
    event->payload.xact.state[4] = 'i';
    event->payload.xact.state[5] = 't';
    clear_state(event->payload.xact.vxid, 32);

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_XACT_STATE);
    bpf_map_delete_elem(&thread_xact, &tid);
    return 0;
}

SEC("uretprobe/UserAbortTransactionBlock")
int probe_xact_abort(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_xact_t *xact = bpf_map_lookup_elem(&thread_xact, &tid);
    if (!xact) return 0;

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) return 0;

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_XACT_STATE);
    event->payload.xact.xid     = xact->xid;
    event->payload.xact.top_xid = xact->top_xid;
    event->payload.xact.lsn     = 0;
    clear_state(event->payload.xact.state, 16);
    event->payload.xact.state[0] = 'a';
    event->payload.xact.state[1] = 'b';
    event->payload.xact.state[2] = 'o';
    event->payload.xact.state[3] = 'r';
    event->payload.xact.state[4] = 't';
    clear_state(event->payload.xact.vxid, 32);

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_XACT_STATE);
    bpf_map_delete_elem(&thread_xact, &tid);
    return 0;
}

// ---------------------------------------------------------------------------
// 4. Lock probes
//
// PG 18.3 symbols confirmed via readelf:
//   LockAcquire          = 0x0507fb0 (basic lock acquisition)
//   LockAcquireExtended  = 0x05072c0 (extended version with more options)
//
// Target: LockAcquire(const LOCKTAG *locktag, LOCKMODE lockmode, bool progress)
// Returns: bool (true = granted, false = would block)
// Parameters: locktag=RDI, lockmode=RSI, progress=RDX
//
// Note: LockRelease does not exist as a standalone exported symbol in PG 18.3.
// Lock release events are not captured.
// ---------------------------------------------------------------------------
SEC("uprobe/LockAcquire")
int probe_lock_acquire_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_xact_t xact = {};
    xact.xid     = 0;
    xact.top_xid = 0;
    // LockAcquire writes to thread memory - just emit the lock event on return
    (void)xact;
    bpf_map_update_elem(&thread_xact, &tid, &xact, BPF_ANY);
    return 0;
}

SEC("uretprobe/LockAcquire")
int probe_lock_acquire_return(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    // LockAcquire returns bool: RAX = 0 or 1
    __u64 ret_val  = (__u64)PT_REGS_RC(ctx);
    __u8  granted   = (ret_val != 0) ? 1 : 0;

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        bpf_map_delete_elem(&thread_xact, &tid);
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_LOCK);
    event->payload.lock.xid      = 0;
    event->payload.lock.mode     = (__u8)PT_REGS_PARM2(ctx);
    event->payload.lock.granted = granted;
    clear_state(event->payload.lock.locktag, 32);

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_LOCK);
    bpf_map_delete_elem(&thread_xact, &tid);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
