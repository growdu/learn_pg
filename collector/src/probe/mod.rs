//! Probe definitions for PostgreSQL kernel events.
//!
//! This module defines the event types and probe targets for
//! WAL insertion, buffer management, and transaction state tracking.

use serde::{Deserialize, Serialize};

/// WAL record RMGR IDs (Resource Manager IDs)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum RmgrId {
    XLOG = 0,
    Heap2 = 1,
    Heap = 2,
    Btree = 3,
    Hash = 4,
    Gist = 5,
    Spgist = 6,
    Gin = 7,
    Brin = 8,
    Standby = 9,
    Heap3 = 10,
    Logical = 11,
    /// Keep this last - it's the count of known RMGRs
    MaxRmgrId,
}

impl From<u8> for RmgrId {
    fn from(v: u8) -> Self {
        match v {
            0 => RmgrId::XLOG,
            1 => RmgrId::Heap2,
            2 => RmgrId::Heap,
            3 => RmgrId::Btree,
            4 => RmgrId::Hash,
            5 => RmgrId::Gist,
            6 => RmgrId::Spgist,
            7 => RmgrId::Gin,
            8 => RmgrId::Brin,
            9 => RmgrId::Standby,
            10 => RmgrId::Heap3,
            11 => RmgrId::Logical,
            _ => RmgrId::MaxRmgrId,
        }
    }
}

impl RmgrId {
    pub fn name(&self) -> &'static str {
        match self {
            RmgrId::XLOG => "XLOG",
            RmgrId::Heap2 => "Heap2",
            RmgrId::Heap => "Heap",
            RmgrId::Btree => "Btree",
            RmgrId::Hash => "Hash",
            RmgrId::Gist => "Gist",
            RmgrId::Spgist => "Spgist",
            RmgrId::Gin => "Gin",
            RmgrId::Brin => "BRIN",
            RmgrId::Standby => "Standby",
            RmgrId::Heap3 => "Heap3",
            RmgrId::Logical => "Logical",
            RmgrId::MaxRmgrId => "Unknown",
        }
    }
}

pub fn operation_name(rmgr_id: u8, info: u8) -> String {
    match rmgr_id {
        0 => match info & 0x0F {
            0x00 => "XLOG_NOOP".to_string(),
            0x01 => "XLOG/NEXTOID".to_string(),
            0x02 => "XLOG/SLRU".to_string(),
            op => format!("XLOG/OP_{}", op),
        },
        1 => match info {
            0x00 => "HEAP2/CLEAN".to_string(),
            0x10 => "HEAP2/NEW_CID".to_string(),
            0x20 => "HEAP2/VISIBLE".to_string(),
            0x30 => "HEAP2/FREEZE".to_string(),
            op => format!("HEAP2/OP_{}", op),
        },
        2 => match info {
            0x00 => "HEAP/INSERT".to_string(),
            0x10 => "HEAP/DELETE".to_string(),
            0x20 => "HEAP/UPDATE".to_string(),
            0x30 => "HEAP/HOT_UPDATE".to_string(),
            0x40 => "HEAP/TRUNCATE".to_string(),
            0x50 => "HEAP/TBLSPC_CREATE".to_string(),
            op => format!("HEAP/OP_{}", op),
        },
        3 => format!("BTREE/OP_{}", info & 0x0F),
        10 => format!("HEAP3/OP_{}", info),
        _ => format!("RMGR_{}/OP_{}", rmgr_id, info),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WalBlockRef {
    pub id: u8,
    pub fork_num: u8,
    pub block_num: u32,
    pub has_image: bool,
    pub has_data: bool,
    pub will_init: bool,
    pub same_rel: bool,
    pub data_len: u16,
    pub image_len: Option<u16>,
    pub rel_spc_node: Option<u32>,
    pub rel_db_node: Option<u32>,
    pub rel_node: Option<u32>,
}

/// Transaction state transitions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum XactState {
    Begin,
    Commit,
    Abort,
    Prepare,
    Rollback,
}

impl XactState {
    pub fn as_str(&self) -> &'static str {
        match self {
            XactState::Begin => "begin",
            XactState::Commit => "commit",
            XactState::Abort => "abort",
            XactState::Prepare => "prepare",
            XactState::Rollback => "rollback",
        }
    }
}

/// Lock mode for buffer and relation locks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LockMode {
    NoLock = 0,
    ForShare = 1,
    ForUpdate = 2,
    Exclusive = 3,
    ShareLock = 4,
    ShareUpdateExclusive = 5,
    AccessExclusive = 6,
}

impl LockMode {
    pub fn name(&self) -> &'static str {
        match self {
            LockMode::NoLock => "NoLock",
            LockMode::ForShare => "ForShare",
            LockMode::ForUpdate => "ForUpdate",
            LockMode::Exclusive => "Exclusive",
            LockMode::ShareLock => "ShareLock",
            LockMode::ShareUpdateExclusive => "ShareUpdateExclusive",
            LockMode::AccessExclusive => "AccessExclusive",
        }
    }
}

/// WAL Insert event data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalInsertEvent {
    /// WAL location pointer (e.g., "0/16D4F30")
    pub xlog_ptr: String,
    /// Numeric LSN value.
    pub lsn_value: u64,
    /// Length of the WAL record
    pub record_len: u32,
    /// Length of record payload after fixed WAL header
    pub payload_len: u32,
    /// Resource Manager ID
    pub rmgr_id: u8,
    /// Resource Manager name
    pub rmgr_name: String,
    /// Decoded operation name
    pub operation: String,
    /// Info flags from the WAL record header
    pub info: u8,
    /// Transaction ID that generated this WAL
    pub xid: u32,
    /// Block number within the relation (for Heap/Btree records)
    pub block_num: Option<u32>,
    /// Relation OID (if applicable)
    pub rel_oid: Option<u32>,
    /// Parsed WAL block references.
    pub blocks: Vec<WalBlockRef>,
    /// Event source: wal-file or ebpf-uprobe.
    pub source: String,
}

/// Buffer Pin/Unpin event data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BufferPinEvent {
    /// Buffer ID (0-indexed within buffer pool)
    pub buffer_id: u32,
    /// Whether this was a buffer hit (found in pool) or miss
    pub is_hit: bool,
    /// Relation file node number
    pub relfilenode: u64,
    /// Fork number (main, FSM, visibility map)
    pub fork_num: u8,
    /// Block number within the relation
    pub block_num: u32,
    /// Lock mode requested
    pub lock_mode: LockMode,
}

/// Transaction state change event data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XactStateEvent {
    /// Transaction ID
    pub xid: u32,
    /// Virtual transaction ID (backend id / local xid)
    pub vxid: String,
    /// New state
    pub state: String,
    /// LSN at commit/abort (for commit/abort only)
    pub lsn: Option<String>,
    /// Top-level transaction ID (for subtransactions)
    pub top_xid: Option<u32>,
}

/// Probe target: a function in PostgreSQL to instrument
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ProbeTarget {
    /// Symbol name to attach uprobe to
    pub symbol: &'static str,
    /// Shared library or executable path
    pub path: &'static str,
    /// Whether this is a uretprobe (return probe) vs uprobe (entry)
    pub is_return: bool,
    /// Description of what this probe captures
    pub description: &'static str,
}

/// All defined probe targets for PostgreSQL kernel events
pub const PROBE_TARGETS: &[(&str, ProbeTarget)] = &[
    // WAL Insert probes
    (
        "xlog_insert",
        ProbeTarget {
            symbol: "XLogInsert",
            path: "postgres",
            is_return: true,
            description: "Captures every WAL record insertion with RMGR info",
        },
    ),
    (
        "xlog_insert_allowed",
        ProbeTarget {
            symbol: "XLogInsertAllowed",
            path: "postgres",
            is_return: true,
            description: "Checks if WAL insertion is allowed (rate limiting)",
        },
    ),
    // Buffer management probes
    (
        "bufmgr_get_buf",
        ProbeTarget {
            symbol: "BufFetchOrCreate",
            path: "postgres",
            is_return: true,
            description: "Buffer fetch or creation event (hit/miss)",
        },
    ),
    (
        "bufmgr_unpin",
        ProbeTarget {
            symbol: "UnlockBuf",
            path: "postgres",
            is_return: false,
            description: "Buffer unpin event",
        },
    ),
    // Transaction state probes
    (
        "xact_begin",
        ProbeTarget {
            symbol: "StartTransaction",
            path: "postgres",
            is_return: false,
            description: "Transaction begin event",
        },
    ),
    (
        "xact_commit",
        ProbeTarget {
            symbol: "CommitTransaction",
            path: "postgres",
            is_return: true,
            description: "Transaction commit event with LSN",
        },
    ),
    (
        "xact_abort",
        ProbeTarget {
            symbol: "AbortTransaction",
            path: "postgres",
            is_return: true,
            description: "Transaction abort/rollback event",
        },
    ),
    // Lock probes
    (
        "lock_acquire",
        ProbeTarget {
            symbol: "LockAcquire",
            path: "postgres",
            is_return: true,
            description: "Lock acquisition attempt",
        },
    ),
    (
        "lock_release",
        ProbeTarget {
            symbol: "LockRelease",
            path: "postgres",
            is_return: true,
            description: "Lock release event",
        },
    ),
];

/// Runtime probe status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeStatus {
    pub name: String,
    pub enabled: bool,
    pub hit_count: u64,
    pub error_count: u64,
}

impl Default for ProbeStatus {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: false,
            hit_count: 0,
            error_count: 0,
        }
    }
}

/// Collects all probe statuses
pub fn all_probe_status() -> Vec<ProbeStatus> {
    probe_statuses(false)
}

pub fn probe_statuses(enabled: bool) -> Vec<ProbeStatus> {
    PROBE_TARGETS
        .iter()
        .map(|(name, _)| ProbeStatus {
            name: name.to_string(),
            enabled,
            hit_count: 0,
            error_count: 0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rmgr_id_name() {
        assert_eq!(RmgrId::XLOG.name(), "XLOG");
        assert_eq!(RmgrId::Heap.name(), "Heap");
        assert_eq!(RmgrId::Btree.name(), "Btree");
    }

    #[test]
    fn test_rmgr_id_from_u8() {
        assert_eq!(RmgrId::from(0u8), RmgrId::XLOG);
        assert_eq!(RmgrId::from(3u8), RmgrId::Btree);
        assert_eq!(RmgrId::from(99u8), RmgrId::MaxRmgrId);
    }

    #[test]
    fn test_xact_state_as_str() {
        assert_eq!(XactState::Begin.as_str(), "begin");
        assert_eq!(XactState::Commit.as_str(), "commit");
        assert_eq!(XactState::Abort.as_str(), "abort");
    }

    #[test]
    fn test_lock_mode_name() {
        assert_eq!(LockMode::NoLock.name(), "NoLock");
        assert_eq!(LockMode::ForShare.name(), "ForShare");
        assert_eq!(LockMode::Exclusive.name(), "Exclusive");
    }

    #[test]
    fn test_wal_insert_event() {
        let event = WalInsertEvent {
            xlog_ptr: "0/16D4F30".to_string(),
            lsn_value: 0x16D4F30,
            record_len: 128,
            payload_len: 104,
            rmgr_id: 2,
            rmgr_name: "Heap".to_string(),
            operation: "HEAP/INSERT".to_string(),
            info: 0,
            xid: 100,
            block_num: Some(42),
            rel_oid: Some(16384),
            blocks: vec![WalBlockRef {
                id: 0,
                fork_num: 0,
                block_num: 42,
                has_data: true,
                rel_node: Some(16384),
                ..WalBlockRef::default()
            }],
            source: "wal-file".to_string(),
        };

        assert_eq!(event.rmgr_id, 2);
        assert_eq!(event.record_len, 128);
        assert_eq!(event.block_num, Some(42));
        assert_eq!(event.operation, "HEAP/INSERT");
    }

    #[test]
    fn test_buffer_pin_event() {
        let event = BufferPinEvent {
            buffer_id: 42,
            is_hit: true,
            relfilenode: 16384,
            fork_num: 0,
            block_num: 0,
            lock_mode: LockMode::ForShare,
        };

        assert_eq!(event.buffer_id, 42);
        assert!(event.is_hit);
    }

    #[test]
    fn test_xact_state_event() {
        let event = XactStateEvent {
            xid: 100,
            vxid: "3/100".to_string(),
            state: "commit".to_string(),
            lsn: Some("0/16D500".to_string()),
            top_xid: None,
        };

        assert_eq!(event.xid, 100);
        assert_eq!(event.state, "commit");
    }

    #[test]
    fn test_all_probe_status() {
        let statuses = all_probe_status();
        assert_eq!(statuses.len(), 9); // 9 probe targets defined
        assert_eq!(statuses[0].name, "xlog_insert");
        assert!(!statuses[0].enabled);
    }
}
