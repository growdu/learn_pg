use crate::probe::{operation_name, RmgrId, WalBlockRef, WalInsertEvent};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const PAGE_SIZE: usize = 8192;
const PAGE_HEADER_SIZE: usize = 20;
const LONG_PAGE_HEADER_SIZE: usize = 36;
const RECORD_HEADER_SIZE: usize = 24;
const RECORD_ALIGN: usize = 8;

pub fn collect_new_wal_events(
    data_dir: &str,
    seen_lsns: &mut HashSet<String>,
    limit: usize,
) -> Vec<WalInsertEvent> {
    let wal_dir = Path::new(data_dir).join("pg_wal");
    let segments = list_segments(&wal_dir);
    if segments.is_empty() {
        return Vec::new();
    }

    let mut events = Vec::new();
    for segment in segments
        .iter()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let Ok(records) = read_records(segment) else {
            continue;
        };
        for record in records {
            if seen_lsns.insert(record.xlog_ptr.clone()) {
                events.push(record);
            }
        }
    }

    if limit > 0 && events.len() > limit {
        events = events.split_off(events.len() - limit);
    }
    if seen_lsns.len() > 50_000 {
        seen_lsns.clear();
        for event in &events {
            seen_lsns.insert(event.xlog_ptr.clone());
        }
    }

    events
}

fn list_segments(wal_dir: &Path) -> Vec<PathBuf> {
    let mut segments = match fs::read_dir(wal_dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let file_name = path.file_name()?.to_str()?;
                if entry.file_type().ok()?.is_file() && is_segment_name(file_name) {
                    Some(path)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    segments.sort();
    segments
}

fn read_records(segment_path: &Path) -> std::io::Result<Vec<WalInsertEvent>> {
    let data = fs::read(segment_path)?;
    let mut events = Vec::new();
    let mut pending = Vec::new();
    let mut pending_len = 0usize;
    let mut pending_lsn = 0u64;

    for page_start in (0..data.len()).step_by(PAGE_SIZE) {
        if page_start + PAGE_SIZE > data.len() {
            break;
        }
        let page = &data[page_start..page_start + PAGE_SIZE];
        let header_size = if page_start == 0 {
            LONG_PAGE_HEADER_SIZE
        } else {
            PAGE_HEADER_SIZE
        };
        if page.len() < header_size {
            continue;
        }

        // PG 18 WAL page header: page_addr and page_len are BIG-endian.
        // The first page of a segment uses a 36-byte long header (XLogLongPageHeaderData);
        // subsequent pages use the standard 20-byte header (XLogPageHeaderData).
        let page_addr = read_be64(&page[8..16]);
        let rem_len = read_be32(&page[16..20]) as usize;
        let mut offset = header_size;
        if !pending.is_empty() {
            let available = PAGE_SIZE - header_size;
            let need = pending_len - pending.len();
            let take = need.min(available);
            pending.extend_from_slice(&page[header_size..header_size + take]);
            offset = header_size + take;
            if pending.len() == pending_len {
                events.push(parse_record_bytes(&pending, pending_lsn, "wal-file"));
                pending.clear();
                pending_len = 0;
                pending_lsn = 0;
            } else {
                continue;
            }
        } else if page_start > 0 && rem_len > 0 {
            if rem_len >= PAGE_SIZE - header_size {
                continue;
            }
            offset += rem_len;
        }

        while offset + RECORD_HEADER_SIZE <= PAGE_SIZE {
            let total_len = read_le32(&page[offset..offset + 4]) as usize;
            if total_len == 0 || total_len < RECORD_HEADER_SIZE || offset + total_len > PAGE_SIZE {
                if total_len >= RECORD_HEADER_SIZE && offset + total_len > PAGE_SIZE {
                    pending.extend_from_slice(&page[offset..PAGE_SIZE]);
                    pending_len = total_len;
                    pending_lsn = page_addr + offset as u64;
                }
                break;
            }

            let lsn_value = page_addr + offset as u64;
            events.push(parse_record_bytes(
                &page[offset..offset + total_len],
                lsn_value,
                "wal-file",
            ));

            offset += align(total_len);
        }
    }

    Ok(events)
}

pub fn parse_record_bytes(raw: &[u8], lsn_value: u64, source: &str) -> WalInsertEvent {
    let xid = read_le32(&raw[4..8]);
    let info = raw[16];
    let rmgr_id = raw[17];
    let payload = &raw[RECORD_HEADER_SIZE..];
    let blocks = parse_block_refs(payload);
    let first_block = blocks.first();
    WalInsertEvent {
        xlog_ptr: format_lsn(lsn_value),
        lsn_value,
        record_len: raw.len() as u32,
        payload_len: payload.len() as u32,
        rmgr_id,
        rmgr_name: RmgrId::from(rmgr_id).name().to_string(),
        operation: operation_name(rmgr_id, info),
        info,
        xid,
        block_num: first_block.map(|block| block.block_num),
        rel_oid: first_block.and_then(|block| block.rel_node),
        blocks,
        source: source.to_string(),
        block_count: 0, // wal-file parser computes full block info from raw WAL; field unused
    }
}

fn parse_block_refs(payload: &[u8]) -> Vec<WalBlockRef> {
    let mut blocks = Vec::new();
    let mut offset = 0usize;
    let mut last_rel: Option<(u32, u32, u32)> = None;

    while offset + 4 <= payload.len() {
        let id = payload[offset];
        if id == 254 || id == 255 || id > 32 {
            break;
        }

        let fork_flags = payload[offset + 1];
        let data_len = read_le16(&payload[offset + 2..offset + 4]);
        offset += 4;

        let mut block = WalBlockRef {
            id,
            fork_num: fork_flags & 0x0F,
            block_num: 0,
            has_image: fork_flags & 0x10 != 0,
            has_data: fork_flags & 0x20 != 0,
            will_init: fork_flags & 0x40 != 0,
            same_rel: fork_flags & 0x80 != 0,
            data_len,
            image_len: None,
            rel_spc_node: None,
            rel_db_node: None,
            rel_node: None,
        };

        if block.has_image {
            if offset + 8 > payload.len() {
                break;
            }
            block.image_len = Some(read_le16(&payload[offset..offset + 2]));
            offset += 8;
        }

        if block.same_rel {
            if let Some((spc, db, rel)) = last_rel {
                block.rel_spc_node = Some(spc);
                block.rel_db_node = Some(db);
                block.rel_node = Some(rel);
            }
        } else {
            if offset + 12 > payload.len() {
                break;
            }
            let spc = read_le32(&payload[offset..offset + 4]);
            let db = read_le32(&payload[offset + 4..offset + 8]);
            let rel = read_le32(&payload[offset + 8..offset + 12]);
            block.rel_spc_node = Some(spc);
            block.rel_db_node = Some(db);
            block.rel_node = Some(rel);
            last_rel = Some((spc, db, rel));
            offset += 12;
        }

        if offset + 4 > payload.len() {
            break;
        }
        block.block_num = read_le32(&payload[offset..offset + 4]);
        offset += 4;

        if block.has_data {
            let next_offset = offset + block.data_len as usize;
            if next_offset > payload.len() {
                break;
            }
            offset = next_offset;
        }

        blocks.push(block);
    }

    blocks
}

fn is_segment_name(name: &str) -> bool {
    name.len() == 24 && name.chars().all(|ch| matches!(ch, '0'..='9' | 'A'..='F'))
}

fn align(length: usize) -> usize {
    (length + RECORD_ALIGN - 1) & !(RECORD_ALIGN - 1)
}

fn read_le32(bytes: &[u8]) -> u32 {
    bytes[0] as u32 | (bytes[1] as u32) << 8 | (bytes[2] as u32) << 16 | (bytes[3] as u32) << 24
}

fn read_le16(bytes: &[u8]) -> u16 {
    bytes[0] as u16 | (bytes[1] as u16) << 8
}

fn read_le64(bytes: &[u8]) -> u64 {
    read_le32(&bytes[..4]) as u64 | ((read_le32(&bytes[4..8]) as u64) << 32)
}

fn read_be32(bytes: &[u8]) -> u32 {
    (bytes[0] as u32) << 24 | (bytes[1] as u32) << 16 | (bytes[2] as u32) << 8 | (bytes[3] as u32)
}

fn read_be64(bytes: &[u8]) -> u64 {
    (read_be32(&bytes[..4]) as u64) << 32 | (read_be32(&bytes[4..8]) as u64)
}

fn format_lsn(value: u64) -> String {
    let hi = (value >> 32) as u32;
    let lo = value as u32;
    format!("{:X}/{:08X}", hi, lo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_synthetic_segment() {
        let dir = unique_temp_dir();
        let wal_dir = dir.join("pg_wal");
        fs::create_dir_all(&wal_dir).expect("create wal dir");
        let segment = wal_dir.join("000000010000000000000001");

        let mut bytes = vec![0u8; PAGE_SIZE];
        // PG 18 WAL page header: page_addr and page_len are BIG-endian
        write_be64(&mut bytes[8..16], 0);
        write_be32(&mut bytes[16..20], 0);
        let offset = LONG_PAGE_HEADER_SIZE;
        write_le32(
            &mut bytes[offset..offset + 4],
            (RECORD_HEADER_SIZE + 4) as u32,
        );
        write_le32(&mut bytes[offset + 4..offset + 8], 77);
        bytes[offset + 16] = 0x01;
        bytes[offset + 17] = 3;
        bytes[offset + 24..offset + 28].copy_from_slice(&[1, 2, 3, 4]);
        fs::write(&segment, bytes).expect("write segment");

        let mut seen = HashSet::new();
        let events = collect_new_wal_events(dir.to_str().unwrap_or_default(), &mut seen, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].xid, 77);
        assert_eq!(events[0].record_len, (RECORD_HEADER_SIZE + 4) as u32);
        assert_eq!(events[0].payload_len, 4);
        assert_eq!(events[0].source, "wal-file");
    }

    #[test]
    fn deduplicates_seen_records() {
        let dir = unique_temp_dir();
        let wal_dir = dir.join("pg_wal");
        fs::create_dir_all(&wal_dir).expect("create wal dir");
        let segment = wal_dir.join("000000010000000000000001");

        let mut bytes = vec![0u8; PAGE_SIZE];
        write_be64(&mut bytes[8..16], 0);
        write_be32(&mut bytes[16..20], 0);
        let offset = LONG_PAGE_HEADER_SIZE;
        write_le32(&mut bytes[offset..offset + 4], RECORD_HEADER_SIZE as u32);
        bytes[offset + 17] = 3;
        fs::write(&segment, bytes).expect("write segment");

        let mut seen = HashSet::new();
        let first = collect_new_wal_events(dir.to_str().unwrap_or_default(), &mut seen, 10);
        let second = collect_new_wal_events(dir.to_str().unwrap_or_default(), &mut seen, 10);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
    }

    #[test]
    fn parses_record_spanning_two_pages() {
        let dir = unique_temp_dir();
        let wal_dir = dir.join("pg_wal");
        fs::create_dir_all(&wal_dir).expect("create wal dir");
        let segment = wal_dir.join("000000010000000000000002");

        let mut bytes = vec![0u8; PAGE_SIZE * 2];
        // PG 18 WAL page header: page_addr and page_len are BIG-endian
        write_be64(&mut bytes[8..16], 0);
        write_be32(&mut bytes[16..20], 0);
        let filler_offset = LONG_PAGE_HEADER_SIZE;
        let filler_len = 8128usize;
        write_le32(
            &mut bytes[filler_offset..filler_offset + 4],
            filler_len as u32,
        );
        write_le32(&mut bytes[filler_offset + 4..filler_offset + 8], 1);
        bytes[filler_offset + 17] = 3;

        let offset = filler_offset + filler_len;
        write_le32(
            &mut bytes[offset..offset + 4],
            (RECORD_HEADER_SIZE + 20) as u32,
        );
        write_le32(&mut bytes[offset + 4..offset + 8], 88);
        bytes[offset + 17] = 3;
        bytes[offset + 24..PAGE_SIZE].copy_from_slice(&[0u8; 4]);

        let page2 = &mut bytes[PAGE_SIZE..];
        // PG 18 WAL page header: BIG-endian
        write_be64(&mut page2[8..16], PAGE_SIZE as u64);
        write_be32(&mut page2[16..20], 16);
        page2[PAGE_HEADER_SIZE..PAGE_HEADER_SIZE + 16].copy_from_slice(&[0u8; 16]);

        fs::write(&segment, bytes).expect("write segment");

        let mut seen = HashSet::new();
        let events = collect_new_wal_events(dir.to_str().unwrap_or_default(), &mut seen, 10);
        assert!(events.len() >= 2);
        let event = events.last().expect("last event");
        assert_eq!(event.xid, 88);
        assert_eq!(event.record_len, (RECORD_HEADER_SIZE + 20) as u32);
    }

    #[test]
    fn parses_block_references() {
        let dir = unique_temp_dir();
        let wal_dir = dir.join("pg_wal");
        fs::create_dir_all(&wal_dir).expect("create wal dir");
        let segment = wal_dir.join("000000010000000000000004");

        let mut bytes = vec![0u8; PAGE_SIZE];
        // PG 18 WAL page header: BIG-endian
        write_be64(&mut bytes[8..16], 0);
        write_be32(&mut bytes[16..20], 0);

        let mut payload = Vec::new();
        payload.push(0);
        payload.push(0x20);
        payload.extend_from_slice(&[4, 0]);
        append_le32(&mut payload, 1663);
        append_le32(&mut payload, 5);
        append_le32(&mut payload, 16384);
        append_le32(&mut payload, 42);
        payload.extend_from_slice(&[9, 8, 7, 6]);

        let offset = LONG_PAGE_HEADER_SIZE;
        write_le32(
            &mut bytes[offset..offset + 4],
            (RECORD_HEADER_SIZE + payload.len()) as u32,
        );
        write_le32(&mut bytes[offset + 4..offset + 8], 91);
        bytes[offset + 17] = 2;
        bytes[offset + 24..offset + 24 + payload.len()].copy_from_slice(&payload);

        fs::write(&segment, bytes).expect("write segment");

        let mut seen = HashSet::new();
        let events = collect_new_wal_events(dir.to_str().unwrap_or_default(), &mut seen, 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].operation, "HEAP/INSERT");
        assert_eq!(events[0].block_num, Some(42));
        assert_eq!(events[0].rel_oid, Some(16384));
        assert_eq!(events[0].blocks.len(), 1);
    }

    fn unique_temp_dir() -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pgv-wal-{}", ts));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_le32(target: &mut [u8], value: u32) {
        target[0] = value as u8;
        target[1] = (value >> 8) as u8;
        target[2] = (value >> 16) as u8;
        target[3] = (value >> 24) as u8;
    }

    fn write_le64(target: &mut [u8], value: u64) {
        write_le32(&mut target[..4], value as u32);
        write_le32(&mut target[4..8], (value >> 32) as u32);
    }

    fn write_be32(target: &mut [u8], value: u32) {
        target[0] = (value >> 24) as u8;
        target[1] = (value >> 16) as u8;
        target[2] = (value >> 8) as u8;
        target[3] = value as u8;
    }

    fn write_be64(target: &mut [u8], value: u64) {
        write_be32(&mut target[..4], (value >> 32) as u32);
        write_be32(&mut target[4..8], value as u32);
    }

    fn append_le32(target: &mut Vec<u8>, value: u32) {
        target.push(value as u8);
        target.push((value >> 8) as u8);
        target.push((value >> 16) as u8);
        target.push((value >> 24) as u8);
    }
}
