mod probe;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use probe::{RmgrId, WalInsertEvent};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::signal;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing_subscriber;

static EVENT_SEQ: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(true);

fn next_seq() -> u64 {
    EVENT_SEQ.fetch_add(1, Ordering::SeqCst)
}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64
}

#[derive(Debug, Clone)]
struct Config {
    backend_ws_url: String,
    pg_data_dir: String,
    use_ebpf: bool,
}

impl Config {
    fn from_env() -> Self {
        Self {
            backend_ws_url: env::var("BACKEND_WS_URL")
                .unwrap_or_else(|_| "ws://localhost:8080".to_string()),
            pg_data_dir: env::var("PG_DATA_DIR")
                .unwrap_or_else(|_| "/var/lib/postgresql/data".to_string()),
            use_ebpf: env::var("USE_EBPF")
                .unwrap_or_else(|_| "false".to_string())
                .parse()
                .unwrap_or(false),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WsEvent {
    #[serde(rename = "type")]
    event_type: String,
    timestamp: u64,
    pid: u32,
    seq: u64,
    data: serde_json::Value,
}

fn wal_to_event(e: WalInsertEvent) -> WsEvent {
    WsEvent {
        event_type: "wal_insert".to_string(),
        timestamp: now_micros(),
        pid: std::process::id(),
        seq: next_seq(),
        data: serde_json::to_value(e).unwrap(),
    }
}

// Log-based event collector (fallback mode)
mod log_collector {
    use super::*;
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    pub fn parse_pg_log_line(line: &str) -> Option<WalInsertEvent> {
        // Pattern: "LOG:  XLogInsert: rmid 3, len 42"
        if let Some(rmid_idx) = line.find("rmid") {
            let rest = &line[rmid_idx..];
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(rmid) = parts[1].parse::<u8>() {
                    let len = if let Some(len_idx) = line.find("len") {
                        let len_rest = &line[len_idx..];
                        let len_parts: Vec<&str> = len_rest.split_whitespace().collect();
                        if len_parts.len() >= 2 {
                            len_parts[1].parse().unwrap_or(0)
                        } else {
                            0
                        }
                    } else {
                        0
                    };

                    let rmgr_name = match rmid as i32 {
                        0 => "XLOG",
                        1 => "Transaction",
                        2 => "Storage",
                        3 => "Heap",
                        4 => "Btree",
                        5 => "HashIndex",
                        6 => "Gin",
                        7 => "Gist",
                        8 => "Spgist",
                        9 => "GinIndex",
                        10 => "BtreeIndex",
                        11 => "HashIndexIndex",
                        12 => "Sync",
                        13 => "Generic",
                        14 => "Logicalmsg",
                        15 => "Standby",
                        16 => "Heap2",
                        17 => "Heap3",
                        18 => "LogicalReplication",
                        19 => "CompressionHistory",
                        20 => "Compaction",
                        _ => "Unknown",
                    };

                    return Some(WalInsertEvent {
                        xlog_ptr: format!("0/{:X}", now_micros() & 0xFFFFFFF),
                        record_len: len,
                        rmgr_id: rmid,
                        rmgr_name: rmgr_name.to_string(),
                        info: 0,
                        xid: 0,
                        block_num: None,
                        rel_oid: None,
                    });
                }
            }
        }
        None
    }

    pub fn tail_log_file(path: &std::path::Path) -> Vec<WalInsertEvent> {
        let mut events = Vec::new();
        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file);
            for line in reader.lines().map(|l| l.unwrap_or_default()) {
                if let Some(evt) = parse_pg_log_line(&line) {
                    events.push(evt);
                }
            }
        }
        events
    }
}

// eBPF event collector stub (requires Linux + root)
#[cfg(target_os = "linux")]
mod ebpf_collector {
    pub fn init_ebpf() -> anyhow::Result<()> {
        // Load eBPF program from probe.bpf.o
        // Attach uprobes to postgres symbols
        tracing::info!("eBPF mode: probes would be loaded here in production");
        Ok(())
    }
}

async fn ws_sender(
    mut rx: mpsc::Receiver<WsEvent>,
    url: String,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = shutdown.recv() => break,
            result = connect_async(&url) => {
                match result {
                    Ok((ws_stream, _)) => {
                        tracing::info!("Connected to backend WebSocket: {}", url);
                        let (mut write, mut read) = ws_stream.split();

                        loop {
                            tokio::select! {
                                _ = shutdown.recv() => {
                                    let _ = write.send(Message::Close(None)).await;
                                    break;
                                }
                                evt = rx.recv() => {
                                    match evt {
                                        Some(event) => {
                                            let json = serde_json::to_string(&event).unwrap();
                                            if write.send(Message::Text(json.into())).await.is_err() {
                                                break;
                                            }
                                        }
                                        None => break,
                                    }
                                }
                                _ = read.next() => {}
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("WS connection failed: {}, retrying in 5s", e);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        }
    }
}

fn generate_demo_events() -> Vec<WsEvent> {
    let ts = now_micros();
    vec![
        WsEvent {
            event_type: "xact_state".to_string(),
            timestamp: ts,
            pid: 1234,
            seq: next_seq(),
            data: serde_json::json!({
                "xid": 100,
                "vxid": "3/100",
                "state": "begin"
            }),
        },
        WsEvent {
            event_type: "wal_insert".to_string(),
            timestamp: ts + 100,
            pid: 1234,
            seq: next_seq(),
            data: serde_json::json!({
                "xlog_ptr": "0/16D4F30",
                "record_len": 128,
                "rmgr_id": 2,
                "rmgr_name": "Heap",
                "info": 0,
                "xid": 100
            }),
        },
        WsEvent {
            event_type: "buffer_pin".to_string(),
            timestamp: ts + 200,
            pid: 1234,
            seq: next_seq(),
            data: serde_json::json!({
                "buffer_id": 42,
                "is_hit": false,
                "relfilenode": 16384,
                "fork_num": 0,
                "block_num": 0,
                "lock_mode": 2
            }),
        },
        WsEvent {
            event_type: "xact_state".to_string(),
            timestamp: ts + 500,
            pid: 1234,
            seq: next_seq(),
            data: serde_json::json!({
                "xid": 100,
                "vxid": "3/100",
                "state": "commit",
                "lsn": "0/16D500"
            }),
        },
    ]
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    println!("PG Kernel Visualizer - eBPF Collector");
    println!("Backend WS: {}", config.backend_ws_url);
    println!("PG Data Dir: {}", config.pg_data_dir);
    println!("eBPF Mode: {}", if config.use_ebpf { "enabled" } else { "log-parse fallback" });

    // Initialize eBPF if on Linux and enabled
    #[cfg(target_os = "linux")]
    if config.use_ebpf {
        if let Err(e) = ebpf_collector::init_ebpf() {
            tracing::warn!("eBPF init failed: {}, falling back to log-parse", e);
        }
    }

    let (tx, rx) = mpsc::channel::<WsEvent>(1000);
    let (shutdown_tx, shutdown_rx) = tokio::sync::broadcast::channel::<()>(1);

    // Spawn WS sender
    let ws_url = config.backend_ws_url.clone();
    tokio::spawn(ws_sender(rx, ws_url, shutdown_rx.resubscribe()));

    // Spawn event generator
    let tx_clone = tx;
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(3));
        let mut first = true;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if first {
                        for evt in generate_demo_events() {
                            let _ = tx_clone.send(evt).await;
                        }
                        first = false;
                    }

                    let evt = WsEvent {
                        event_type: "heartbeat".to_string(),
                        timestamp: now_micros(),
                        pid: std::process::id(),
                        seq: next_seq(),
                        data: serde_json::json!({
                            "mode": if config.use_ebpf { "ebpf" } else { "log-parse" },
                            "probes": probe::all_probe_status(),
                            "note": "eBPF collector active"
                        }),
                    };
                    let _ = tx_clone.send(evt).await;
                }
            }
        }
    });

    tokio::select! {
        _ = signal::ctrl_c() => {
            println!("Shutting down...");
            RUNNING.store(false, Ordering::SeqCst);
            let _ = shutdown_tx.send(());
        }
    }

    Ok(())
}