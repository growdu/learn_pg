// SPDX-License-Identifier: GPL-2.0
// PostgreSQL userspace probes for the pg-collector.

#include <linux/types.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

enum event_kind {
    EVENT_KIND_WAL_INSERT = 1,
    EVENT_KIND_XACT_STATE = 3,
};

struct event_header_t {
    __u32 kind;
    __u32 size;
    __u64 timestamp;
    __u32 tid;
    __u32 pid;
};

struct wal_payload_t {
    __u64 xlog_ptr;
    __u32 record_len;
    __u32 xid;
    __u8 rmgr_id;
    __u8 info;
    __u16 _pad;
};

struct xact_payload_t {
    __u32 xid;
    __u32 top_xid;
    __u64 lsn;
    char state[16];
    char vxid[32];
};

struct event_t {
    struct event_header_t header;
    union {
        struct wal_payload_t wal;
        struct xact_payload_t xact;
    } payload;
};

struct wal_args_t {
    __u8 rmgr_id;
    __u8 info;
    __u16 _pad;
};

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

static __always_inline void fill_header(struct event_t *event, __u32 kind)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();

    event->header.kind = kind;
    event->header.size = sizeof(*event);
    event->header.timestamp = bpf_ktime_get_ns() / 1000;
    event->header.tid = (__u32)pid_tgid;
    event->header.pid = (__u32)(pid_tgid >> 32);
}

static __always_inline void clear_state(char state[16])
{
    __builtin_memset(state, 0, 16);
}

SEC("uprobe/XLogInsert")
int probe_xlog_insert_entry(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid = (__u32)pid_tgid;
    struct wal_args_t args = {};

    args.rmgr_id = (__u8)PT_REGS_PARM1(ctx);
    args.info = (__u8)PT_REGS_PARM2(ctx);
    bpf_map_update_elem(&wal_args, &tid, &args, BPF_ANY);
    return 0;
}

SEC("uretprobe/XLogInsert")
int probe_xlog_insert_return(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 tid = (__u32)pid_tgid;
    struct wal_args_t *args = bpf_map_lookup_elem(&wal_args, &tid);

    if (!args) {
        return 0;
    }

    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        bpf_map_delete_elem(&wal_args, &tid);
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_WAL_INSERT);
    event->payload.wal.xlog_ptr = PT_REGS_RC(ctx);
    event->payload.wal.record_len = 0;
    event->payload.wal.xid = 0;
    event->payload.wal.rmgr_id = args->rmgr_id;
    event->payload.wal.info = args->info;
    event->payload.wal._pad = 0;

    bpf_ringbuf_submit(event, 0);
    bpf_map_delete_elem(&wal_args, &tid);
    return 0;
}

SEC("uprobe/StartTransaction")
int probe_xact_begin(struct pt_regs *ctx)
{
    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_XACT_STATE);
    event->payload.xact.xid = 0;
    event->payload.xact.top_xid = 0;
    event->payload.xact.lsn = 0;
    clear_state(event->payload.xact.state);
    event->payload.xact.state[0] = 'b';
    event->payload.xact.state[1] = 'e';
    event->payload.xact.state[2] = 'g';
    event->payload.xact.state[3] = 'i';
    event->payload.xact.state[4] = 'n';
    __builtin_memset(event->payload.xact.vxid, 0, 32);
    bpf_ringbuf_submit(event, 0);
    return 0;
}

SEC("uretprobe/CommitTransaction")
int probe_xact_commit(struct pt_regs *ctx)
{
    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_XACT_STATE);
    event->payload.xact.xid = 0;
    event->payload.xact.top_xid = 0;
    event->payload.xact.lsn = 0;
    clear_state(event->payload.xact.state);
    event->payload.xact.state[0] = 'c';
    event->payload.xact.state[1] = 'o';
    event->payload.xact.state[2] = 'm';
    event->payload.xact.state[3] = 'm';
    event->payload.xact.state[4] = 'i';
    event->payload.xact.state[5] = 't';
    __builtin_memset(event->payload.xact.vxid, 0, 32);
    bpf_ringbuf_submit(event, 0);
    return 0;
}

SEC("uretprobe/AbortTransaction")
int probe_xact_abort(struct pt_regs *ctx)
{
    struct event_t *event = bpf_ringbuf_reserve(&events, sizeof(*event), 0);
    if (!event) {
        return 0;
    }

    __builtin_memset(event, 0, sizeof(*event));
    fill_header(event, EVENT_KIND_XACT_STATE);
    event->payload.xact.xid = 0;
    event->payload.xact.top_xid = 0;
    event->payload.xact.lsn = 0;
    clear_state(event->payload.xact.state);
    event->payload.xact.state[0] = 'a';
    event->payload.xact.state[1] = 'b';
    event->payload.xact.state[2] = 'o';
    event->payload.xact.state[3] = 'r';
    event->payload.xact.state[4] = 't';
    __builtin_memset(event->payload.xact.vxid, 0, 32);
    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
