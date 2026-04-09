use crate::probe::{operation_name, RmgrId, WalInsertEvent, XactStateEvent};
use crate::{next_seq, WsEvent};
use anyhow::{anyhow, Context, Result};
use aya::maps::ring_buf::RingBuf;
use aya::programs::UProbe;
use aya::Bpf;
use std::convert::TryInto;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

const EVENT_KIND_WAL_INSERT: u32 = 1;
const EVENT_KIND_XACT_STATE: u32 = 3;
const EVENT_HEADER_LEN: usize = 24;

#[derive(Debug, Clone)]
pub struct EbpfConfig {
    pub object_path: String,
    pub postgres_bin: String,
    pub postgres_pid: Option<i32>,
}

pub fn spawn_ebpf_collector(
    config: EbpfConfig,
    tx: mpsc::Sender<WsEvent>,
    mut shutdown: broadcast::Receiver<()>,
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

    attach_uprobe(
        &mut bpf,
        "probe_xlog_insert_entry",
        "XLogInsert",
        &target_path,
        pid_filter,
    )?;
    attach_uprobe(
        &mut bpf,
        "probe_xlog_insert_return",
        "XLogInsert",
        &target_path,
        pid_filter,
    )?;
    attach_uprobe(
        &mut bpf,
        "probe_xact_begin",
        "StartTransaction",
        &target_path,
        pid_filter,
    )?;
    attach_uprobe(
        &mut bpf,
        "probe_xact_commit",
        "CommitTransaction",
        &target_path,
        pid_filter,
    )?;
    attach_uprobe(
        &mut bpf,
        "probe_xact_abort",
        "AbortTransaction",
        &target_path,
        pid_filter,
    )?;

    let mut ringbuf = RingBuf::try_from(
        bpf.take_map("events")
            .context("BPF ring buffer map 'events' missing")?,
    )
    .context("open BPF ring buffer")?;

    tokio::task::spawn_blocking(move || loop {
        if shutdown.try_recv().is_ok() {
            break;
        }

        while let Some(item) = ringbuf.next() {
            if let Some(event) = parse_raw_event(item.as_ref()) {
                if tx.blocking_send(event).is_err() {
                    return;
                }
            }
        }

        std::thread::sleep(Duration::from_millis(50));
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
    program
        .load()
        .with_context(|| format!("load uprobe program '{}'", program_name))?;
    program
        .attach(Some(symbol), 0, target_path, pid_filter)
        .with_context(|| format!("attach {} to {}:{}", program_name, target_path, symbol))?;
    tracing::info!("attached {} to {}:{}", program_name, target_path, symbol);
    Ok(())
}

fn parse_raw_event(raw: &[u8]) -> Option<WsEvent> {
    if raw.len() < EVENT_HEADER_LEN {
        return None;
    }

    let kind = read_u32(raw, 0);
    let timestamp = read_u64(raw, 8);
    let pid = read_u32(raw, 20);

    match kind {
        EVENT_KIND_WAL_INSERT => parse_wal_event(raw, timestamp, pid),
        EVENT_KIND_XACT_STATE => parse_xact_event(raw, timestamp, pid),
        _ => None,
    }
}

fn parse_wal_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < EVENT_HEADER_LEN + 18 {
        return None;
    }

    let payload = EVENT_HEADER_LEN;
    let lsn_value = read_u64(raw, payload);
    let record_len = read_u32(raw, payload + 8);
    let xid = read_u32(raw, payload + 12);
    let rmgr_id = raw[payload + 16];
    let info = raw[payload + 17];

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
        source: "ebpf-uprobe".to_string(),
    };

    Some(WsEvent {
        event_type: "wal_insert".to_string(),
        timestamp,
        pid,
        seq: next_seq(),
        data: serde_json::to_value(event).ok()?,
    })
}

fn parse_xact_event(raw: &[u8], timestamp: u64, pid: u32) -> Option<WsEvent> {
    if raw.len() < EVENT_HEADER_LEN + 64 {
        return None;
    }

    let payload = EVENT_HEADER_LEN;
    let xid = read_u32(raw, payload);
    let top_xid = read_u32(raw, payload + 4);
    let lsn = read_u64(raw, payload + 8);
    let state = cstr_from_bytes(&raw[payload + 16..payload + 32]);
    let vxid = cstr_from_bytes(&raw[payload + 32..payload + 64]);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wal_event_payload() {
        let mut raw = vec![0u8; EVENT_HEADER_LEN + 18];
        write_u32(&mut raw, 0, EVENT_KIND_WAL_INSERT);
        write_u64(&mut raw, 8, 1234);
        write_u32(&mut raw, 20, 99);
        write_u64(&mut raw, EVENT_HEADER_LEN, 0x16D4F30);
        write_u32(&mut raw, EVENT_HEADER_LEN + 8, 128);
        write_u32(&mut raw, EVENT_HEADER_LEN + 12, 42);
        raw[EVENT_HEADER_LEN + 16] = 2;
        raw[EVENT_HEADER_LEN + 17] = 0;

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "wal_insert");
        assert_eq!(event.timestamp, 1234);
        assert_eq!(event.pid, 99);
        assert_eq!(event.data["xlog_ptr"], "0/016D4F30");
        assert_eq!(event.data["source"], "ebpf-uprobe");
        assert_eq!(event.data["operation"], "HEAP/INSERT");
    }

    #[test]
    fn parses_xact_event_payload() {
        let mut raw = vec![0u8; EVENT_HEADER_LEN + 64];
        write_u32(&mut raw, 0, EVENT_KIND_XACT_STATE);
        write_u64(&mut raw, 8, 4321);
        write_u32(&mut raw, 20, 100);
        write_u32(&mut raw, EVENT_HEADER_LEN, 42);
        write_u64(&mut raw, EVENT_HEADER_LEN + 8, 0x16D500);
        raw[EVENT_HEADER_LEN + 16..EVENT_HEADER_LEN + 22].copy_from_slice(b"commit");
        raw[EVENT_HEADER_LEN + 32..EVENT_HEADER_LEN + 36].copy_from_slice(b"3/42");

        let event = parse_raw_event(&raw).expect("event");
        assert_eq!(event.event_type, "xact_state");
        assert_eq!(event.timestamp, 4321);
        assert_eq!(event.data["xid"], 42);
        assert_eq!(event.data["state"], "commit");
        assert_eq!(event.data["lsn"], "0/016D500");
    }

    fn write_u32(raw: &mut [u8], offset: usize, value: u32) {
        raw[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(raw: &mut [u8], offset: usize, value: u64) {
        raw[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
}
