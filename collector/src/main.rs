use serde::{Deserialize, Serialize};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{interval, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use tracing_subscriber;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProbeEvent {
    #[serde(rename = "type")]
    event_type: String,
    timestamp: u64,
    pid: u32,
    seq: u64,
    data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct Config {
    backend_ws_url: String,
    collector_port: u16,
    pg_data_dir: String,
}

impl Config {
    fn from_env() -> Self {
        Self {
            backend_ws_url: env::var("BACKEND_WS_URL")
                .unwrap_or_else(|_| "ws://localhost:8080".to_string()),
            collector_port: env::var("COLLECTOR_PORT")
                .unwrap_or_else(|_| "8090".to_string())
                .parse()
                .unwrap_or(8090),
            pg_data_dir: env::var("PG_DATA_DIR")
                .unwrap_or_else(|_| "/var/lib/postgresql/data".to_string()),
        }
    }
}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64
}

async fn send_events(mut rx: tokio::sync::mpsc::Receiver<ProbeEvent>) -> anyhow::Result<()> {
    let config = Config::from_env();

    loop {
        match connect_async(&config.backend_ws_url).await {
            Ok((ws_stream, _)) => {
                tracing::info!("Connected to backend WebSocket");
                let (mut write, _read) = ws_stream.split();

                while let Some(event) = rx.recv().await {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if write.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to connect to backend: {}, retrying in 5s", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

fn generate_demo_events() -> Vec<ProbeEvent> {
    let ts = now_micros();
    vec![
        ProbeEvent {
            event_type: "xact_state".to_string(),
            timestamp: ts,
            pid: 1234,
            seq: 1,
            data: serde_json::json!({
                "xid": 100,
                "vxid": "3/100",
                "state": "begin"
            }),
        },
        ProbeEvent {
            event_type: "wal_insert".to_string(),
            timestamp: ts + 100,
            pid: 1234,
            seq: 2,
            data: serde_json::json!({
                "xlog_ptr": "0/16D4F30",
                "record_len": 128,
                "rmgr_id": 2,
                "rmgr_name": "Heap",
                "info": 0,
                "xid": 100
            }),
        },
        ProbeEvent {
            event_type: "buffer_pin".to_string(),
            timestamp: ts + 200,
            pid: 1234,
            seq: 3,
            data: serde_json::json!({
                "buffer_id": 42,
                "is_hit": false,
                "relfilenode": 16384,
                "fork_num": 0,
                "block_num": 0
            }),
        },
        ProbeEvent {
            event_type: "xact_state".to_string(),
            timestamp: ts + 500,
            pid: 1234,
            seq: 4,
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
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    tracing::info!("PG Kernel Visualizer - eBPF Collector starting");
    tracing::info!("Backend WS: {}", config.backend_ws_url);
    tracing::info!("PG Data Dir: {}", config.pg_data_dir);

    let (tx, rx) = tokio::sync::mpsc::channel::<ProbeEvent>(1000);

    // Spawn event sender
    tokio::spawn(send_events(rx));

    // Demo: generate synthetic events every 3 seconds
    // In production, this would be replaced by eBPF probe events
    let mut ticker = interval(Duration::from_secs(3));
    let mut seq: u64 = 0;

    loop {
        ticker.tick().await;
        seq += 1;

        // Generate synthetic demo event for testing
        let event = ProbeEvent {
            event_type: "heartbeat".to_string(),
            timestamp: now_micros(),
            pid: 0,
            seq,
            data: serde_json::json!({
                "mode": "log-parse",
                "note": "Running in log-parse fallback mode (no eBPF)"
            }),
        };

        if tx.send(event).await.is_err() {
            tracing::warn!("Channel closed, stopping");
            return Ok(());
        }

        tracing::debug!("Sent heartbeat event #{}", seq);
    }

    Ok(())
}