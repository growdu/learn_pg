use crate::probe::{operation_name, BufferPinEvent, ProbeStatus, RmgrId, WalInsertEvent, XactStateEvent};
use crate::{next_seq, now_micros, WsEvent};
use anyhow::{anyhow, Context, Result};
use aya::maps::ring_buf::RingBuf;
use aya::maps::HashMap;
use aya::programs::UProbe;
use aya::Bpf;
use std::convert::TryInto;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

// ─────────────────────────────────────────────────────────────────────────────
// eBPF Probe Symbol Matching Requirements
// ─────────────────────────────────────────────────────────────────────────────
//
// probe.bpf.o 是预编译的，其 uprobes 必须精确 attach 到 PostgreSQL 进程的
// 目标符号。所有探针的符号名称在 probe/mod.rs 的 PROBE_TARGETS 中定义，
// 核心对应关系如下：
//
//   BPF Program               Target Symbol          Purpose
//   ───────────────────────────────────────────────────────────────────────
//   probe_xlog_insert_entry  XLogInsert             WAL Insert entry (saves rmid/info)
//   probe_xlog_insert_return XLogInsert             WAL Insert return (emits event)
//   probe_heap_insert_entry  heap_insert            HeapInsert entry (INSERT path)
//   probe_heap_update_entry simple_heap_update      UPDATE path (PG 18.3)
//   probe_heap_delete_entry simple_heap_delete      DELETE path (PG 18.3)
//   probe_buf_entry          ReadBuffer              Buffer fetch/create entry (PG 18.3)
//   probe_buf_return         ReadBuffer              Buffer fetch/create return (PG 18.3)
//   probe_xact_begin         StartTransactionCommand Transaction begin (PG 18.3)
//   probe_xact_commit        CommitTransactionCommand Transaction commit (PG 18.3)
//   probe_xact_abort         UserAbortTransactionBlock Transaction abort (PG 18.3)
//   probe_lock_acquire_entry LockAcquire            Lock acquire entry
//   probe_lock_acquire_return LockAcquire           Lock acquire return
//
// Note: heap_update, heap_delete, BufFetchOrCreate, BufTableLookup, StartTransaction,
// CommitTransaction, AbortTransaction, LockRelease do NOT exist as standalone symbols
// in PostgreSQL 18.3 (they have been inlined or renamed).
//
// CRITICAL: 这些符号的地址从 POSTGRES_BIN (或 /proc/<PID>/exe) 解析。
// 编译 probe.bpf.o 时使用的 PG 源码版本必须与运行时 attach 到的 postgres
// 二进制版本完全一致（包括 minor version）。如果版本不匹配，符号地址会偏移
// 导致数据读取越界或无法触发探针。
//
// 推荐做法：
//   1. 在目标机器上编译 probe.bpf.o，或
//   2. 使用同一 PG 镜像（postgres:18）同时提供二进制和编译环境，或
//   3. 使用 CO-RE (Compile Once Run Everywhere) + BTF 获取类型信息
//
// 如果 attach 失败，eBPF 采集器会打印警告并自动降级到 WAL 文件轮询模式。
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_KIND_WAL_INSERT: u32 = 1;
const EVENT_KIND_BUFFER_PIN: u32 = 2;
const EVENT_KIND_XACT_STATE: u32 = 3;
const EVENT_KIND_LOCK: u32 = 4;
const EVENT_HEADER_LEN: usize = 24;

// Payload offsets (after EVENT_HEADER_LEN = 24 bytes)
const WAL_PAYLOAD_OFFSET: usize = EVENT_HEADER_LEN;
const BUF_PAYLOAD_OFFSET: usize = EVENT_HEADER_LEN;
const XACT_PAYLOAD_OFFSET: usize = EVENT_HEADER_LEN;
const LOCK_PAYLOAD_OFFSET: usize = EVENT_HEADER_LEN;

// WAL payload size: 8 + 4 + 4 + 1 + 1 + 2 = 20 bytes
const WAL_PAYLOAD_SIZE: usize = 20;
// Buffer payload size: 4 + 1 + 1 + 1 + 1 + 4 + 4 = 16 bytes
const BUF_PAYLOAD_SIZE: usize = 16;
// Xact payload size: 4 + 4 + 8 + 16 + 32 = 64 bytes
const XACT_PAYLOAD_SIZE: usize = 64;
// Lock payload size: 4 + 1 + 1 + 2 + 32 = 40 bytes
const LOCK_PAYLOAD_SIZE: usize = 40;

#[derive(Debug, Clone)]
pub struct EbpfConfig {
    pub object_path: String,
    pub postgres_bin: String,
    pub postgres_pid: Option<i32>,
}

pub fn spawn_ebpf_collector(
    config: EbpfConfig,
    tx: mpsc::Sender<WsEvent>,
    shutdown: broadcast::Receiver<()>,
    poll_interval_ms: u64,
) -> Result<()> {
    let object_path = PathBuf::from(&config.object_path);
    if !object_path.exists() {
        return Err(anyhow!(
            "BPF object not found at {}. Build it with collector/build-ebpf.sh or set BPF_OBJECT_PATH.",
            config.object_path
        ));
    }

    let mut bpf = Bpf::load_file(&object_path)
        .with_context(|| format!("load BPF object {}", object_path.display()))?;

    let target_path = config
        .postgres_pid
        .map(|pid| format!("/proc/{}/exe", pid))
        .unwrap_or_else(|| config.postgres_bin.clone());
    let pid_filter = config.postgres_pid;

    // --- WAL Insert probes (mandatory) ---
    if attach_uprobe(&mut bpf, "probe_xlog_insert_entry", "XLogInsert", &target_path, pid_filter).is_err() {
        return Err(anyhow!("WAL probe 'probe_xlog_insert_entry' failed — eBPF cannot operate"));
    }
    let _ = attach_uprobe(&mut bpf, "probe_xlog_insert_return", "XLogInsert", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("WAL return probe failed (non-fatal): {}", e));

    // --- Heap probes (optional — populate xid/rel_oid for WAL events) ---
    let _ = attach_uprobe(&mut bpf, "probe_heap_insert_entry", "heap_insert", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("heap_insert probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_heap_update_entry", "simple_heap_update", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("simple_heap_update probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_heap_delete_entry", "simple_heap_delete", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("simple_heap_delete probe failed (non-fatal): {}", e));

    // --- Buffer Pin probes (optional) ---
    // PG 18.3: use ReadBuffer (0x4aeb70) — the public buffer acquisition API.
    // BufFetchOrCreate, BufTableLookup are internal and don't exist as standalone symbols.
    let _ = attach_uprobe(&mut bpf, "probe_buf_entry", "ReadBuffer", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("ReadBuffer entry probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_buf_return", "ReadBuffer", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("ReadBuffer return probe failed (non-fatal): {}", e));

    // --- Transaction State probes (optional) ---
    // PG 18.3 symbols:
    //   StartTransactionCommand    = 0x02138e0
    //   CommitTransactionCommand   = 0x0216270
    //   UserAbortTransactionBlock   = 0x0213f10
    let _ = attach_uprobe(&mut bpf, "probe_xact_begin", "StartTransactionCommand", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("StartTransactionCommand probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_xact_commit", "CommitTransactionCommand", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("CommitTransactionCommand probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_xact_abort", "UserAbortTransactionBlock", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("UserAbortTransactionBlock probe failed (non-fatal): {}", e));

    // --- Lock probes (optional) ---
    let _ = attach_uprobe(&mut bpf, "probe_lock_acquire_entry", "LockAcquire", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("LockAcquire entry probe failed (non-fatal): {}", e));
    let _ = attach_uprobe(&mut bpf, "probe_lock_acquire_return", "LockAcquire", &target_path, pid_filter)
        .map_err(|e| tracing::warn!("LockAcquire return probe failed (non-fatal): {}", e));
    // LockRelease probe removed — no standalone LockRelease symbol in PG 18.3

    let _probe_counts_map = bpf.take_map("probe_counts");

    let tick_interval_ms = poll_interval_ms;

    let bpf_owned = bpf;
    let bpf_ptr = std::sync::Arc::new(std::sync::Mutex::new(Some(bpf_owned)));

    // Ringbuf reader task
    let ringbuf_tx = tx.clone();
    let ringbuf_bpf = bpf_ptr.clone();
    let ringbuf_shutdown = shutdown.resubscribe();
    let mut ringbuf_shutdown_mut = ringbuf_shutdown;
    tokio::task::spawn_blocking(move || {
        eprintln!("RINGBUF READER: starting task");
        let mut total_seen: u64 = 0;
        let mut consecutive_empty: u64 = 0;
        loop {
            if ringbuf_shutdown_mut.try_recv().is_ok() {
                break;
            }
            let mut ringbuf_guard = ringbuf_bpf.lock().unwrap();
            if let Some(ref mut bpf_ref) = *ringbuf_guard {
                let ringbuf_map = bpf_ref.map("events");
                if let Some(raw_map) = ringbuf_map {
                    if let Ok(mut ringbuf) = RingBuf::try_from(raw_map) {
                        let mut batch: usize = 0;
                        while let Some(item) = ringbuf.next() {
                            if let Some(event) = parse_raw_event(item.as_ref()) {
                                if ringbuf_tx.blocking_send(event).is_err() {
                                    return;
                                }
                                batch += 1;
                                total_seen += 1;
                            }
                        }
                        if batch > 0 {
                            tracing::debug!("eBPF ringbuf: {} events this poll, total={}", batch, total_seen);
                            consecutive_empty = 0;
                        } else {
                            consecutive_empty += 1;
                            if consecutive_empty == 1 || consecutive_empty % 20 == 0 {
                                tracing::debug!("eBPF ringbuf: no events (poll #{})", consecutive_empty);
                            }
                        }
                    } else {
                        tracing::info!("eBPF ringbuf: RingBuf::try_from failed");
                        consecutive_empty += 1;
                    }
                } else {
                    tracing::info!("eBPF ringbuf: no events map found");
                }
            } else {
                tracing::debug!("eBPF ringbuf: bpf_ref is None");
            }
            drop(ringbuf_guard);
            std::thread::sleep(Duration::from_millis(50));
        }
    });

    // Heartbeat task — reads probe_counts every tick_interval_ms
    let heartbeat_bpf = bpf_ptr;
    let heartbeat_shutdown = shutdown.resubscribe();
    let mut heartbeat_shutdown_mut = heartbeat_shutdown;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(tick_interval_ms));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = heartbeat_shutdown_mut.recv() => break,
                _ = ticker.tick() => {
                    let probes: Vec<serde_json::Value> = {
                        let guard = heartbeat_bpf.lock().unwrap();
                        if let Some(ref bpf_ref) = *guard {
                            let statuses = crate::ebpf::read_probe_counts(bpf_ref);
                            statuses.into_iter().map(serde_json::to_value).filter_map(|r| r.ok()).collect()
                        } else {
                            vec![]
                        }
                    };
                    let evt = WsEvent {
                        event_type: "heartbeat".to_string(),
                        timestamp: now_micros(),
                        pid: std::process::id(),
                        seq: next_seq(),
                        data: serde_json::json!({
                            "mode": "ebpf-uprobe",
                            "source": "ebpf-collector",
                            "probes": probes,
                        }),
                    };
                    let _ = tx.send(evt).await;
                }
            }
        }
    });

    Ok(())
}

fn attach_uprobe(
    bpf: &mut Bpf,
    program_name: &str,
    symbol: &str,
    target_path: &str,
    pid_filter: Option<i32>,
) -> Result<()> {
    let program: &mut UProbe = bpf
        .program_mut(program_name)
        .with_context(|| format!("BPF program '{}' missing", program_name))?
        .try_into()
        .with_context(|| format!("BPF program '{}' is not a uprobe", program_name))?;

    tracing::debug!("[attach_uprobe] {}: loading bpf program...", program_name);
    if let Err(e) = program.load() {
        tracing::error!("[attach_uprobe] {}: load FAILED: {}", program_name, e);
        return Err(anyhow!("load uprobe program '{}': {}", program_name, e));
    }

    tracing::debug!("[attach_uprobe] {}: attaching to {}:{}", program_name, target_path, symbol);
    if let Err(e) = program.attach(Some(symbol), 0, target_path, pid_filter) {
        tracing::error!("[attach_uprobe] {}: attach FAILED: {}", program_name, e);
        return Err(anyhow!("attach {} to {}:{}: {}", program_name, target_path, symbol, e));
    }

    tracing::info!(
        "[attach_uprobe] {}: SUCCESS -> {}:{}",
        program_name,
        target_path,
        symbol
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------
fn parse_raw_event(raw: &[u8]) -> Option<WsEvent> {
    if raw.len() < EVENT_HEADER_LEN {
        return None;
    }

    let kind = read_u32(raw, 0);
    let timestamp = read_u64(raw, 8);
    let pid = read_u32(raw, 20);

    match kind {
        EVENT_KIND_WAL_INSERT => parse_wal_event(raw, timestamp, pid),
        EVENT_KIND_BUFFER_PIN => parse_buffer_pin_event(raw, timestamp, pid),
        EVENT_KIND_XACT_STATE => parse_xact_event(raw, timestamp, pid),
        EVENT_KIND_LOCK => parse_lock_event(raw, timestamp, pid),
        _ => None,
    }
}

fn wal_src_to_source(src: u8) -> String {
    match src {
        1 => "ebpf:heap_insert".to_string(),
        2 => "ebpf:heap_update".to_string(),
        3 => "ebpf:heap_delete".to_string(),
        4 => "ebpf:xlog".to_string(),
        _ => "ebpf:unknown".to_string(),
    }
}

// ---------------------------------------------------------------------------
// WAL Insert
// ---------------------------------------------------------------------------
fn parse_wal_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < WAL_PAYLOAD_OFFSET + WAL_PAYLOAD_SIZE {
        return None;
    }

    let p = WAL_PAYLOAD_OFFSET;
    let lsn_value = read_u64(raw, p);
    let record_len = read_u32(raw, p + 8);
    let xid = read_u32(raw, p + 12);
    let rmgr_id = raw[p + 16];
    let info = raw[p + 17];
    let src = raw[p + 18];
    let block_count = raw[p + 19];

    let event = WalInsertEvent {
        xlog_ptr: format_lsn(lsn_value),
        lsn_value,
        record_len,
        payload_len: 0,
        rmgr_id,
        rmgr_name: RmgrId::from(rmgr_id).name().to_string(),
        operation: operation_name(rmgr_id, info),
        info,
        xid,
        block_num: None,
        rel_oid: None,
        blocks: Vec::new(),
        source: wal_src_to_source(src),
        block_count,
    };

    Some(WsEvent {
        event_type: "wal_insert".to_string(),
        timestamp,
        pid,
        seq: next_seq(),
        data: serde_json::to_value(event).ok()?,
    })
}

// ---------------------------------------------------------------------------
// Buffer Pin
// ---------------------------------------------------------------------------
fn parse_buffer_pin_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < BUF_PAYLOAD_OFFSET + BUF_PAYLOAD_SIZE {
        return None;
    }

    let p = BUF_PAYLOAD_OFFSET;
    let buffer_id = read_u32(raw, p);
    let is_hit = raw[p + 4] != 0;
    let fork_num = raw[p + 5];
    let block_num = read_u32(raw, p + 8);
    let rel_node = read_u32(raw, p + 12);

    // Map rel_node to LockMode heuristically based on fork_num and block_num.
    // This is informational; precise lock mode requires reading the buffer
    // descriptor's BufFlags field (BM_MODE_MASK) which is not available here.
    let lock_mode = crate::probe::LockMode::NoLock;

    let event = BufferPinEvent {
        buffer_id,
        is_hit,
        relfilenode: rel_node as u64,
        fork_num,
        block_num,
        lock_mode,
    };

    Some(WsEvent {
        event_type: "buffer_pin".to_string(),
        timestamp,
        pid,
        seq: next_seq(),
        data: serde_json::to_value(event).ok()?,
    })
}

// ---------------------------------------------------------------------------
// Transaction State
// ---------------------------------------------------------------------------
fn parse_xact_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < XACT_PAYLOAD_OFFSET + XACT_PAYLOAD_SIZE {
        return None;
    }

    let p = XACT_PAYLOAD_OFFSET;
    let xid = read_u32(raw, p);
    let top_xid = read_u32(raw, p + 4);
    let lsn = read_u64(raw, p + 8);
    let state = cstr_from_bytes(&raw[p + 16..p + 32]);
    let vxid = cstr_from_bytes(&raw[p + 32..p + 64]);

    let event = XactStateEvent {
        xid,
        vxid,
        state,
        lsn: if lsn == 0 {
            None
        } else {
            Some(format_lsn(lsn))
        },
        top_xid: if top_xid == 0 { None } else { Some(top_xid) },
    };

    Some(WsEvent {
        event_type: "xact_state".to_string(),
        timestamp,
        pid,
        seq: next_seq(),
        data: serde_json::to_value(event).ok()?,
    })
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------
fn parse_lock_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < LOCK_PAYLOAD_OFFSET + LOCK_PAYLOAD_SIZE {
        return None;
    }

    let p = LOCK_PAYLOAD_OFFSET;
    let xid = read_u32(raw, p);
    let mode = raw[p + 4];
    let granted = raw[p + 5];
    let locktag_bytes = &raw[p + 8..p + 40];

    let lock_mode: crate::probe::LockMode = match mode {
        0 => crate::probe::LockMode::NoLock,
        1 => crate::probe::LockMode::ForShare,
        2 => crate::probe::LockMode::ForUpdate,
        3 => crate::probe::LockMode::Exclusive,
        4 => crate::probe::LockMode::ShareLock,
        5 => crate::probe::LockMode::ShareUpdateExclusive,
        6 => crate::probe::LockMode::AccessExclusive,
        _ => crate::probe::LockMode::NoLock,
    };

    let event = LockEvent {
        xid,
        mode: lock_mode,
        granted: granted != 0,
        locktag: cstr_from_bytes(locktag_bytes),
    };

    Some(WsEvent {
        event_type: "lock".to_string(),
        timestamp,
        pid,
        seq: next_seq(),
        data: serde_json::to_value(event).ok()?,
    })
}

// ---------------------------------------------------------------------------
// Lock event (sent over WebSocket)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LockEvent {
    pub xid: u32,
    pub mode: crate::probe::LockMode,
    pub granted: bool,
    pub locktag: String,
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
fn cstr_from_bytes(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

fn read_u32(raw: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(raw[offset..offset + 4].try_into().expect("u32 bytes"))
}

fn read_u64(raw: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(raw[offset..offset + 8].try_into().expect("u64 bytes"))
}

fn format_lsn(value: u64) -> String {
    format!("{:X}/{:08X}", (value >> 32) as u32, value as u32)
}

// ---------------------------------------------------------------------------
// Probe counts exported for heartbeat (called from main.rs)
// ---------------------------------------------------------------------------

/// Probe hit count indices — must match the BPF program constants.
/// Probe index constants — must match probe.bpf.c probe_counts map keys
#[allow(dead_code)]
pub const PROBE_IDX_WAL_INSERT: u32 = 0;
#[allow(dead_code)]
pub const PROBE_IDX_BUFFER_PIN: u32 = 1;
#[allow(dead_code)]
pub const PROBE_IDX_XACT_STATE: u32 = 2;
#[allow(dead_code)]
pub const PROBE_IDX_LOCK: u32 = 3;

/// Probe names in display order for heartbeat status.
const PROBE_NAMES: [&str; 4] = ["wal_insert", "buffer_pin", "xact_state", "lock"];

/// Read hit counts from the BPF probe_counts map.
/// Returns a Vec<ProbeStatus> with hit_count populated; caller merges into
/// the heartbeat payload in main.rs.
pub fn read_probe_counts(bpf: &Bpf) -> Vec<ProbeStatus> {
    let mut results = Vec::with_capacity(4);
    let map = match bpf.map("probe_counts") {
        Some(m) => match HashMap::try_from(m) {
            Ok(m) => m,
            Err(_) => return results,
        },
        None => return results,
    };
    for (idx, name) in PROBE_NAMES.iter().enumerate() {
        let key = idx as u32;
        let hit_count = map.get(&key, 0).unwrap_or(0);
        results.push(ProbeStatus {
            name: name.to_string(),
            enabled: true,
            hit_count,
            error_count: 0,
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_u32(raw: &mut [u8], offset: usize, value: u32) {
        raw[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(raw: &mut [u8], offset: usize, value: u64) {
        raw[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn parses_wal_event_payload() {
        let mut raw = vec![0u8; WAL_PAYLOAD_OFFSET + WAL_PAYLOAD_SIZE];
        write_u32(&mut raw, 0, EVENT_KIND_WAL_INSERT);
        write_u64(&mut raw, 8, 1234);
        write_u32(&mut raw, 20, 99);
        write_u64(&mut raw, WAL_PAYLOAD_OFFSET, 0x16D4F30);
        write_u32(&mut raw, WAL_PAYLOAD_OFFSET + 8, 128);
        write_u32(&mut raw, WAL_PAYLOAD_OFFSET + 12, 42);
        raw[WAL_PAYLOAD_OFFSET + 16] = 2; // Heap rmgr_id
        raw[WAL_PAYLOAD_OFFSET + 17] = 0; // info = INSERT
        raw[WAL_PAYLOAD_OFFSET + 18] = 1; // src: WAL_SRC_HEAP_INSERT
        raw[WAL_PAYLOAD_OFFSET + 19] = 1; // block_count

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "wal_insert");
        assert_eq!(event.timestamp, 1234);
        assert_eq!(event.pid, 99);
        assert_eq!(event.data["xlog_ptr"], "0/016D4F30");
        assert_eq!(event.data["source"], "ebpf:heap_insert");
        assert_eq!(event.data["operation"], "HEAP/INSERT");
        assert_eq!(event.data["block_count"], 1);
    }

    #[test]
    fn parses_buffer_pin_event() {
        let mut raw = vec![0u8; BUF_PAYLOAD_OFFSET + BUF_PAYLOAD_SIZE];
        write_u32(&mut raw, 0, EVENT_KIND_BUFFER_PIN);
        write_u64(&mut raw, 8, 5000);
        write_u32(&mut raw, 20, 42);
        write_u32(&mut raw, BUF_PAYLOAD_OFFSET, 99);     // buffer_id
        raw[BUF_PAYLOAD_OFFSET + 4] = 1;                // is_hit
        raw[BUF_PAYLOAD_OFFSET + 5] = 0;                // fork_num (main fork)
        write_u32(&mut raw, BUF_PAYLOAD_OFFSET + 8, 7);  // block_num
        write_u32(&mut raw, BUF_PAYLOAD_OFFSET + 12, 16384); // rel_node

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "buffer_pin");
        assert_eq!(event.timestamp, 5000);
        assert_eq!(event.data["buffer_id"], 99);
        assert_eq!(event.data["is_hit"], true);
        assert_eq!(event.data["fork_num"], 0);
        assert_eq!(event.data["block_num"], 7);
        assert_eq!(event.data["relfilenode"], 16384);
    }

    #[test]
    fn parses_xact_event_payload() {
        let mut raw = vec![0u8; XACT_PAYLOAD_OFFSET + XACT_PAYLOAD_SIZE];
        write_u32(&mut raw, 0, EVENT_KIND_XACT_STATE);
        write_u64(&mut raw, 8, 4321);
        write_u32(&mut raw, 20, 100);
        write_u32(&mut raw, XACT_PAYLOAD_OFFSET, 42);
        write_u64(&mut raw, XACT_PAYLOAD_OFFSET + 8, 0x16D500);
        raw[XACT_PAYLOAD_OFFSET + 16..XACT_PAYLOAD_OFFSET + 22].copy_from_slice(b"commit");
        raw[XACT_PAYLOAD_OFFSET + 32..XACT_PAYLOAD_OFFSET + 42].copy_from_slice(b"0/016D500\0");

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "xact_state");
        assert_eq!(event.timestamp, 4321);
        assert_eq!(event.data["xid"], 42);
        assert_eq!(event.data["state"], "commit");
        assert_eq!(event.data["lsn"], "0/0016D500");
    }

    #[test]
    fn parses_lock_event_granted() {
        let mut raw = vec![0u8; LOCK_PAYLOAD_OFFSET + LOCK_PAYLOAD_SIZE];
        write_u32(&mut raw, 0, EVENT_KIND_LOCK);
        write_u64(&mut raw, 8, 9000);
        write_u32(&mut raw, 20, 77);
        write_u32(&mut raw, LOCK_PAYLOAD_OFFSET, 42); // xid
        raw[LOCK_PAYLOAD_OFFSET + 4] = 6;              // mode = AccessExclusive
        raw[LOCK_PAYLOAD_OFFSET + 5] = 1;              // granted = true

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "lock");
        assert_eq!(event.timestamp, 9000);
        assert_eq!(event.data["xid"], 42);
        assert_eq!(event.data["granted"], true);
    }
}
