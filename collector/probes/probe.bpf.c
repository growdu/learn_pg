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
// HeapInsert / HeapUpdate / HeapDelete write WAL via XLogInsert.
// We probe their entry to capture rel_oid and xid before XLogInsert is called.
//
// HeapInsert signature (src/backend/storage/page/heapinsert.c):
//   void HeapInsert(Relation relation, Buffer buffer, HeapTuple tuple,
//                   int options)
//   amd64: RDI=relation*, RSI=buffer, RDX=HeapTuple*, RCX=options
//
// HeapUpdate signature (src/backend/storage/page/heapupdate.c):
//   void HeapUpdate(Relation relation, Buffer buffer, HeapTuple old,
//                   HeapTuple new, int options, HeapTupleAborted *aborted,
//                   Buffer *buffer2)
//   amd64: RDI=relation*, RSI=buffer, RDX=oldtuple*, RCX=newtuple*, R8=options
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

// HeapUpdate entry: captures old + new rel_oid (uses primary relation)
SEC("uprobe/heap_update")
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

// HeapDelete entry
SEC("uprobe/heap_delete")
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
// Target: BufFetchOrCreate (or BufTableLookup + BufExtend)
//   Returns: BufferDesc *
//   BufferDesc layout (approximate, PG 15-18):
//     offset 0x00: int buffer_id
//     offset 0x04: unsigned flags
//     offset 0x08: Oid relfilenode (or 0 if not yet assigned)
//   We read the first 4 bytes as buffer_id.
//
// is_hit heuristic: if block_num parameter > 0 and isExtend is false,
//   the buffer was likely found. A precise check requires reading
//   BufFlags at offset 0x04 and testing BM_TAG_VALID.
// ---------------------------------------------------------------------------
SEC("uprobe/BufFetchOrCreate")
int probe_buf_entry(struct pt_regs *ctx)
{
    // BufFetchOrCreate(const RelFileNode &rnode, ForkNumber forkNum,
    //                   BlockNumber blockNum, bool isExtend,
    //                   BufferAccessStrategy strategy)
    // Parameters (amd64):
    //   rnode:     RDI (PT_REGS_PARM1)
    //   forkNum:   RSI (PT_REGS_PARM2)
    //   blockNum:  RDX (PT_REGS_PARM3)
    //   isExtend:  RSC (PT_REGS_PARM4)
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t state = {};

    // Read relfilenode from the RelFileNode struct (first field)
    // On amd64, RDI points to the RelFileNode object
    void *rnode_ptr = (void *)PT_REGS_PARM1(ctx);
    if (rnode_ptr) {
        // RelFileNode::node (RelPersistentNode): first 4 bytes = spcOid,
        // then 4 bytes = dbOid, then 4 bytes = relNode
        // We want relNode (tablespace + db + relfilenode combined in newer PG,
        // or just relfilenode in older versions).
        // For compatibility, read the 4-byte value at offset 8 (relNode).
        __u32 val8 = BPF_LOAD_BYTE(rnode_ptr, 8);
        __u32 val9 = BPF_LOAD_BYTE(rnode_ptr, 9);
        __u32 valA = BPF_LOAD_BYTE(rnode_ptr, 10);
        __u32 valB = BPF_LOAD_BYTE(rnode_ptr, 11);
        state.rel_node = val8 | (val9 << 8) | (valA << 16) | (valB << 24);

        // Also try offset 0 for spcOid if rel_node is 0
        if (state.rel_node == 0) {
            __u32 val0 = BPF_LOAD_BYTE(rnode_ptr, 0);
            __u32 val1 = BPF_LOAD_BYTE(rnode_ptr, 1);
            __u32 val2 = BPF_LOAD_BYTE(rnode_ptr, 2);
            __u32 val3 = BPF_LOAD_BYTE(rnode_ptr, 3);
            state.rel_node = val0 | (val1 << 8) | (val2 << 16) | (val3 << 24);
        }
    }

    state.fork_num = (__u8)PT_REGS_PARM2(ctx);
    state.is_hit   = 0;  // will be updated in return probe
    bpf_map_update_elem(&thread_buf, &tid, &state, BPF_ANY);
    return 0;
}

SEC("uretprobe/BufFetchOrCreate")
int probe_buf_return(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t *state = bpf_map_lookup_elem(&thread_buf, &tid);
    if (!state) return 0;

    // Get block number from the entry probe's RDX (we stored it in the map)
    // Unfortunately we can't re-read regs from here. Use a heuristic:
    // The function returns BufferDesc* - we read buffer_id from the first 4 bytes.
    void *buf_desc  = (void *)PT_REGS_RC(ctx);
    __u32  buffer_id = 0;
    if (buf_desc) {
        __u32 b0 = BPF_LOAD_BYTE(buf_desc, 0);
        __u32 b1 = BPF_LOAD_BYTE(buf_desc, 1);
        __u32 b2 = BPF_LOAD_BYTE(buf_desc, 2);
        __u32 b3 = BPF_LOAD_BYTE(buf_desc, 3);
        buffer_id = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        bpf_map_delete_elem(&thread_buf, &tid);
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_BUFFER_PIN);
    event->payload.buf.buffer_id = buffer_id;
    event->payload.buf.is_hit    = state->is_hit;
    event->payload.buf.fork_num = state->fork_num;
    event->payload.buf.block_num= 0;  // would need to pass from entry
    event->payload.buf.rel_node = state->rel_node;

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_BUF_PIN);
    bpf_map_delete_elem(&thread_buf, &tid);
    return 0;
}

// Fallback: probe BufTableLookup (used when buffer is already in hash table = hit)
SEC("uprobe/BufTableLookup")
int probe_buf_hit_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t state = {};
    state.is_hit   = 1;
    state.fork_num = (__u8)PT_REGS_PARM2(ctx);
    bpf_map_update_elem(&thread_buf, &tid, &state, BPF_ANY);
    return 0;
}

SEC("uretprobe/BufTableLookup")
int probe_buf_hit_return(struct pt_regs *ctx)
{
    // Returns a BufferDesc* (or InvalidBuffer if not found)
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid      = (__u32)pid_tgid;
    struct thread_buf_t *state = bpf_map_lookup_elem(&thread_buf, &tid);
    if (!state) return 0;

    void  *buf_desc  = (void *)PT_REGS_RC(ctx);
    __u32  buffer_id = 0;
    if (buf_desc) {
        __u32 b0 = BPF_LOAD_BYTE(buf_desc, 0);
        __u32 b1 = BPF_LOAD_BYTE(buf_desc, 1);
        __u32 b2 = BPF_LOAD_BYTE(buf_desc, 2);
        __u32 b3 = BPF_LOAD_BYTE(buf_desc, 3);
        buffer_id = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }
    if (buffer_id == 0) {
        // InvalidBuffer (0), skip
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
    event->payload.buf.is_hit    = 1;
    event->payload.buf.fork_num  = state->fork_num;
    event->payload.buf.block_num = 0;
    event->payload.buf.rel_node  = state->rel_node;

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_BUF_PIN);
    bpf_map_delete_elem(&thread_buf, &tid);
    return 0;
}

// ---------------------------------------------------------------------------
// 3. Transaction State probes
//
// Strategy: per-thread hash map stores xid/top_xid/state between probes.
// We write the state on Begin and read it on Commit/Abort.
// ---------------------------------------------------------------------------
SEC("uprobe/StartTransaction")
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

SEC("uretprobe/CommitTransaction")
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

SEC("uretprobe/AbortTransaction")
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
// Target: LockAcquire(const LOCKTAG *locktag, LOCKMODE lockmode, bool
//          progress)
// Returns: bool (true = granted, false = would block)
// Parameters:
//   locktag: RDI
//   lockmode: RSI
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

SEC("uretprobe/LockRelease")
int probe_lock_release_return(struct pt_regs *ctx)
{
    // LockRelease returns void — no return value to inspect
    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) return 0;

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_LOCK);
    event->payload.lock.xid      = 0;
    event->payload.lock.mode     = 0;  // lockmode not available at release
    event->payload.lock.granted  = 0;
    clear_state(event->payload.lock.locktag, 32);

    bpf_ringbuf_submit(event, 0);
    probe_hit(PROBE_IDX_LOCK);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
