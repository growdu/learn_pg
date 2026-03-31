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
    Transaction = 1,
    Storage = 2,
    Heap = 3,
    Btree = 4,
    HashIndex = 5,
    Gin = 6,
    Gist = 7,
    Spgist = 8,
    GinIndex = 9,
    BtreeIndex = 10,
    HashIndexIndex = 11,
    Sync = 12,
    Generic = 13,
    Logicalmsg = 14,
    Standby = 15,
    Heap2 = 16,
    Heap3 = 17,
    LogicalReplication = 18,
    CompressionHistory = 19,
    Compaction = 20,
    /// Keep this last - it's the count of known RMGRs
    MaxRmgrId,
}

impl From<u8> for RmgrId {
    fn from(v: u8) -> Self {
        match v {
            0 => RmgrId::XLOG,
            1 => RmgrId::Transaction,
            2 => RmgrId::Storage,
            3 => RmgrId::Heap,
            4 => RmgrId::Btree,
            5 => RmgrId::HashIndex,
            6 => RmgrId::Gin,
            7 => RmgrId::Gist,
            8 => RmgrId::Spgist,
            9 => RmgrId::GinIndex,
            10 => RmgrId::BtreeIndex,
            11 => RmgrId::HashIndexIndex,
            12 => RmgrId::Sync,
            13 => RmgrId::Generic,
            14 => RmgrId::Logicalmsg,
            15 => RmgrId::Standby,
            16 => RmgrId::Heap2,
            17 => RmgrId::Heap3,
            18 => RmgrId::LogicalReplication,
            19 => RmgrId::CompressionHistory,
            20 => RmgrId::Compaction,
            _ => RmgrId::MaxRmgrId,
        }
    }
}

impl RmgrId {
    pub fn name(&self) -> &'static str {
        match self {
            RmgrId::XLOG => "XLOG",
            RmgrId::Transaction => "Transaction",
            RmgrId::Storage => "Storage",
            RmgrId::Heap => "Heap",
            RmgrId::Btree => "Btree",
            RmgrId::HashIndex => "HashIndex",
            RmgrId::Gin => "Gin",
            RmgrId::Gist => "Gist",
            RmgrId::Spgist => "Spgist",
            RmgrId::GinIndex => "GinIndex",
            RmgrId::BtreeIndex => "BtreeIndex",
            RmgrId::HashIndexIndex => "HashIndexIndex",
            RmgrId::Sync => "Sync",
            RmgrId::Generic => "Generic",
            RmgrId::Logicalmsg => "Logicalmsg",
            RmgrId::Standby => "Standby",
            RmgrId::Heap2 => "Heap2",
            RmgrId::Heap3 => "Heap3",
            RmgrId::LogicalReplication => "LogicalReplication",
            RmgrId::CompressionHistory => "CompressionHistory",
            RmgrId::Compaction => "Compaction",
            RmgrId::MaxRmgrId => "Unknown",
        }
    }
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
    /// Length of the WAL record
    pub record_len: u32,
    /// Resource Manager ID
    pub rmgr_id: u8,
    /// Resource Manager name
    pub rmgr_name: String,
    /// Info flags from the WAL record header
    pub info: u8,
    /// Transaction ID that generated this WAL
    pub xid: u32,
    /// Block number within the relation (for Heap/Btree records)
    pub block_num: Option<u32>,
    /// Relation OID (if applicable)
    pub rel_oid: Option<u32>,
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
    PROBE_TARGETS
        .iter()
        .map(|(name, _)| ProbeStatus {
            name: name.to_string(),
            enabled: false,
            hit_count: 0,
            error_count: 0,
        })
        .collect()
}