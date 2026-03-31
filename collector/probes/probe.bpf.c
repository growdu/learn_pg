// SPDX-License-Identifier: GPL-2.0
// eBPF probe definitions for PostgreSQL kernel events
// Compile with: clang -target bpf -O2 -g -c probe.bpf.c -o probe.bpf.o

#include <uapi/linux/ptrace.h>
#include <linux/bpf.h>

// WAL event structure
struct wal_event_t {
    __u64 timestamp;
    __u32 pid;
    __u32 xid;
    __u32 record_len;
    __u8 rmgr_id;
    __u8 info;
    __u64 xlog_ptr;
    char rmgr_name[16];
};

// Buffer pin event structure
struct buffer_event_t {
    __u64 timestamp;
    __u32 pid;
    __u32 buffer_id;
    __u32 relfilenode;
    __u8 fork_num;
    __u32 block_num;
    __u8 is_hit;
    __u8 lock_mode;
};

// Transaction state event structure
struct xact_event_t {
    __u64 timestamp;
    __u32 pid;
    __u32 xid;
    __u32 top_xid;
    char vxid[32];
    char state[16];
    char lsn[24];
};

// Ring buffer map for passing events to userspace
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

// Hash map to track in-flight transactions
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);
    __type(value, __u64);
} xact_map SEC(".maps");

// Uprobe: XLogInsert (return)
SEC("uprobe/postgres:XLogInsert")
int probe_wal_insert(struct pt_regs *ctx) {
    // In production, we would extract parameters from pt_regs
    // and write to the ring buffer
    return 0;
}

// Uprobe: XLogInsertAllowed (return)
SEC("uprobe/postgres:XLogInsertAllowed")
int probe_wal_insert_allowed(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: StartTransaction (entry)
SEC("uprobe/postgres:StartTransaction")
int probe_xact_begin(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: CommitTransaction (return)
SEC("uprobe/postgres:CommitTransaction")
int probe_xact_commit(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: AbortTransaction (return)
SEC("uprobe/postgres:AbortTransaction")
int probe_xact_abort(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: BufFetchOrCreate (return)
SEC("uprobe/postgres:BufFetchOrCreate")
int probe_buffer_pin(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: UnlockBuf (entry)
SEC("uprobe/postgres:UnlockBuf")
int probe_buffer_unpin(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: LockAcquire (return)
SEC("uprobe/postgres:LockAcquire")
int probe_lock_acquire(struct pt_regs *ctx) {
    return 0;
}

// Uprobe: LockRelease (return)
SEC("uprobe/postgres:LockRelease")
int probe_lock_release(struct pt_regs *ctx) {
    return 0;
}

char LICENSE[] SEC("license") = "GPL";