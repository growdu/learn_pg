#[cfg(target_os = "linux")]
mod ebpf;
mod probe;
mod wal_file;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use probe::WalInsertEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    poll_interval_ms: u64,
    postgres_bin: String,
    postgres_pid: Option<i32>,
    bpf_object_path: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            backend_ws_url: env::var("BACKEND_WS_URL")
                .unwrap_or_else(|_| "ws://localhost:3000/ws".to_string()),
            pg_data_dir: env::var("PG_DATA_DIR")
                .unwrap_or_else(|_| "/var/lib/postgresql/data".to_string()),
            use_ebpf: env::var("USE_EBPF")
                .unwrap_or_else(|_| "false".to_string())
                .parse()
                .unwrap_or(false),
            poll_interval_ms: env::var("POLL_INTERVAL_MS")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .unwrap_or(3000),
            postgres_bin: env::var("POSTGRES_BIN")
                .unwrap_or_else(|_| "/usr/lib/postgresql/18/bin/postgres".to_string()),
            postgres_pid: env::var("POSTGRES_PID")
                .ok()
                .and_then(|pid| pid.parse().ok()),
            bpf_object_path: env::var("BPF_OBJECT_PATH")
                .unwrap_or_else(|_| "/app/probes/probe.bpf.o".to_string()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WsEvent {
    #[serde(rename = "type")]
    event_type: String,
    timestamp: u64,
    pid: u32,
    seq: u64,
    data: serde_json::Value,
}

pub(crate) fn wal_to_event(e: WalInsertEvent) -> WsEvent {
    WsEvent {
        event_type: "wal_insert".to_string(),
        timestamp: now_micros(),
        pid: std::process::id(),
        seq: next_seq(),
        data: serde_json::to_value(e).unwrap(),
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    println!("PG Kernel Visualizer - eBPF Collector");
    println!("Backend WS: {}", config.backend_ws_url);
    println!("PG Data Dir: {}", config.pg_data_dir);
    println!(
        "eBPF Mode: {}",
        if config.use_ebpf {
            "enabled"
        } else {
            "log-parse fallback"
        }
    );
    println!("Poll Interval: {}ms", config.poll_interval_ms);
    println!("Postgres Binary: {}", config.postgres_bin);
    if let Some(pid) = config.postgres_pid {
        println!("Postgres PID filter: {}", pid);
    }
    println!("BPF Object: {}", config.bpf_object_path);

    let (tx, rx) = mpsc::channel::<WsEvent>(1000);
    let (shutdown_tx, shutdown_rx) = tokio::sync::broadcast::channel::<()>(1);

    #[cfg(target_os = "linux")]
    let mut ebpf_active = false;
    #[cfg(not(target_os = "linux"))]
    let ebpf_active = false;
    #[cfg(target_os = "linux")]
    if config.use_ebpf {
        let ebpf_config = ebpf::EbpfConfig {
            object_path: config.bpf_object_path.clone(),
            postgres_bin: config.postgres_bin.clone(),
            postgres_pid: config.postgres_pid,
        };
        match ebpf::spawn_ebpf_collector(ebpf_config, tx.clone(), shutdown_rx.resubscribe()) {
            Ok(()) => {
                ebpf_active = true;
                tracing::info!("eBPF uprobes active");
            }
            Err(e) => {
                tracing::warn!("eBPF init failed: {}, falling back to WAL file polling", e);
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    if config.use_ebpf {
        tracing::warn!("eBPF requested but this collector was built for a non-Linux target");
    }

    // Spawn WS sender
    let ws_url = config.backend_ws_url.clone();
    tokio::spawn(ws_sender(rx, ws_url, shutdown_rx.resubscribe()));

    // Spawn event generator
    let tx_clone = tx;
    let poll_interval_ms = config.poll_interval_ms;
    let pg_data_dir = config.pg_data_dir.clone();
    let ebpf_requested = config.use_ebpf;
    let ebpf_enabled = ebpf_active;
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_millis(poll_interval_ms));
        let mut seen_lsns = HashSet::new();

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    for event in wal_file::collect_new_wal_events(&pg_data_dir, &mut seen_lsns, 256) {
                        let _ = tx_clone.send(wal_to_event(event)).await;
                    }

                    let evt = WsEvent {
                        event_type: "heartbeat".to_string(),
                        timestamp: now_micros(),
                        pid: std::process::id(),
                        seq: next_seq(),
                        data: serde_json::json!({
                            "mode": if ebpf_enabled { "ebpf-uprobe+wal-file" } else if ebpf_requested { "ebpf-requested/wal-file-active" } else { "wal-file" },
                            "probes": probe::probe_statuses(ebpf_enabled),
                            "note": "collector active",
                            "wal_events_seen": seen_lsns.len(),
                            "pg_data_dir": pg_data_dir.clone()
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
