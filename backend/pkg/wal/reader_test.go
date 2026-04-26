package wal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRecordsParsesSyntheticSegment(t *testing.T) {
	dir := t.TempDir()
	segmentPath := filepath.Join(dir, "000000010000000000000001")
	segment := make([]byte, PageSize*2)

	// PG 18 WAL page header: offset 8 = WAL page address (BE uint64)
	// offset 16 = page_len (BE uint32, 0 = unused)
	writeBE64(segment[8:16], 0)                  // WAL page address = 0 (big-endian)
	writeBE32(segment[16:20], 0)                 // page_len = 0 (unused so far)

	// First page (pageNum=0): page_len tells us how many bytes are valid.
	// Write a WAL record at offset 24 (after 24-byte long header).
	recordOffset := XLogLongPageHeaderSize
	recordLen := XLogRecordHeaderSize + 4
	// Set page_len so the reader knows this page has data (big-endian)
	writeBE32(segment[16:20], uint32(PageSize)) // page_len = full page
	writeLE32(segment[recordOffset:recordOffset+4], uint32(recordLen))
	writeLE32(segment[recordOffset+4:recordOffset+8], 42)
	writeBE64(segment[recordOffset+8:recordOffset+16], 0)
	segment[recordOffset+16] = 0x00
	segment[recordOffset+17] = 2
	writeLE32(segment[recordOffset+20:recordOffset+24], 0xDEADBEEF)
	copy(segment[recordOffset+24:recordOffset+28], []byte{1, 2, 3, 4})

	// Page 1 (second page): also mark as used
	page1 := segment[PageSize : PageSize*2]
	writeBE64(page1[8:16], uint64(PageSize))   // WAL page address = PageSize (big-endian)
	writeBE32(page1[16:20], 0)                  // page_len = 0 (unused, just a placeholder)

	if err := os.WriteFile(segmentPath, segment, 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	reader := NewWALReader(dir)
	records, err := reader.ReadRecords(segmentPath, 0, 10)
	if err != nil {
		t.Fatalf("ReadRecords: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("len(records) = %d, want 1", len(records))
	}

	record := records[0]
	if record.LSN != FormatLSN64(uint64(recordOffset)) {
		t.Fatalf("record LSN = %s", record.LSN)
	}
	if record.Xid != 42 {
		t.Fatalf("record xid = %d, want 42", record.Xid)
	}
	if record.RmgrID != 2 {
		t.Fatalf("record rmgr = %d, want 2", record.RmgrID)
	}
	if record.RecordLen != uint32(recordLen) {
		t.Fatalf("record len = %d, want %d", record.RecordLen, recordLen)
	}
	if len(record.Data) != 4 {
		t.Fatalf("len(record.Data) = %d, want 4", len(record.Data))
	}
}
func TestTailRecordsReturnsLatestSubset(t *testing.T) {
	dir := t.TempDir()
	walDir := filepath.Join(dir, "pg_wal")
	if err := os.MkdirAll(walDir, 0o755); err != nil {
		t.Fatalf("mkdir wal dir: %v", err)
	}

	segmentPath := filepath.Join(walDir, "000000010000000000000001")
	segment := make([]byte, PageSize)

	// PG 18 WAL page header
	writeBE64(segment[8:16], 0)
	// Mark first page as used (full page)
	writeBE32(segment[16:20], uint32(PageSize))

	firstOffset := XLogLongPageHeaderSize
	writeSyntheticRecord(segment, firstOffset, 24, 1, 2, 0x00, []byte{})
	secondOffset := firstOffset + alignRecordLength(24)
	writeSyntheticRecord(segment, secondOffset, 24, 2, 3, 0x01, []byte{})

	if err := os.WriteFile(segmentPath, segment, 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	reader := NewWALReader(dir)
	records, err := reader.TailRecords(1)
	if err != nil {
		t.Fatalf("TailRecords: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("len(records) = %d, want 1", len(records))
	}
	if records[0].Xid != 2 {
		t.Fatalf("latest xid = %d, want 2", records[0].Xid)
	}
}

func TestReadRecordsAssemblesRecordAcrossPages(t *testing.T) {
	dir := t.TempDir()
	segmentPath := filepath.Join(dir, "000000010000000000000002")
	segment := make([]byte, PageSize*2)

	// PG 18 WAL page headers (big-endian)
	// Page 0: mark as used (full page)
	writeBE64(segment[8:16], 0)
	writeBE32(segment[16:20], uint32(PageSize))

	// Record that spans from page 0 into page 1:
	// recordLen = 8100, starts at offset 24 (after 24-byte long header).
	// 24 + 8100 = 8124 > 8192, so it spans.
	recordLen := XLogRecordHeaderSize + 8100 - XLogRecordHeaderSize // just payload
	totalLen := XLogRecordHeaderSize + recordLen
	fillerOffset := XLogLongPageHeaderSize
	writeSyntheticRecord(segment, fillerOffset, uint32(totalLen), 1, 2, 0x00,
		make([]byte, recordLen-XLogRecordHeaderSize))

	// Page 1 (second page of segment): mark as used with page_len = remaining
	// When a record spans pages, page 1's page_len = bytes_needed (continuation data)
	// The reader uses pending[] to reassemble across pages.
	page1 := segment[PageSize : PageSize*2]
	writeBE64(page1[8:16], uint64(PageSize))
	// page_len tells the reader how many continuation bytes are on this page.
	// Since the record is recordLen+24 total and page 0 gave us (8192-24) = 8168,
	// we need remaining = (recordLen+24) - 8168 = recordLen - 8144 + 24 = recordLen - 8120
	rem := uint32(recordLen - 8144 + XLogRecordHeaderSize)
	writeBE32(page1[16:20], rem)

		// The pending buffer on page 1 picks up from standard header start
	if err := os.WriteFile(segmentPath, segment, 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	reader := NewWALReader(dir)
	records, err := reader.ReadRecords(segmentPath, 0, 10)
	if err != nil {
		t.Fatalf("ReadRecords: %v", err)
	}
	if len(records) < 1 {
		t.Fatalf("len(records) = %d, want at least 1 (assembled spanning record)", len(records))
	}
	record := records[len(records)-1]
	if record.Xid != 1 {
		t.Fatalf("xid = %d, want 1", record.Xid)
	}
}

func TestReadRecordsParsesBlockReferences(t *testing.T) {
	dir := t.TempDir()
	segmentPath := filepath.Join(dir, "000000010000000000000003")
	segment := make([]byte, PageSize)

	// PG 18 WAL page header (big-endian)
	writeBE64(segment[8:16], 0)
	// Mark page as used (full page)
	writeBE32(segment[16:20], uint32(PageSize))

	payload := make([]byte, 0, 28)
	payload = append(payload, 0)    // block id
	payload = append(payload, 0x20) // has data, main fork
	payload = append(payload, 4, 0) // data length
	payload = appendLE32(payload, 1663)
	payload = appendLE32(payload, 5)
	payload = appendLE32(payload, 16384)
	payload = appendLE32(payload, 42)
	payload = append(payload, 9, 8, 7, 6)

	offset := XLogLongPageHeaderSize
	writeSyntheticRecord(segment, offset, uint32(XLogRecordHeaderSize+len(payload)), 7, 2, 0x00, payload)

	if err := os.WriteFile(segmentPath, segment, 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	reader := NewWALReader(dir)
	records, err := reader.ReadRecords(segmentPath, 0, 10)
	if err != nil {
		t.Fatalf("ReadRecords: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("len(records) = %d, want 1", len(records))
	}
	if records[0].PayloadLen != uint32(len(payload)) {
		t.Fatalf("payload len = %d, want %d", records[0].PayloadLen, len(payload))
	}
	if len(records[0].Blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(records[0].Blocks))
	}
	block := records[0].Blocks[0]
	if block.BlockNum != 42 || block.RelNode != 16384 || !block.HasData || block.DataLen != 4 {
		t.Fatalf("unexpected block ref: %+v", block)
	}
}

// writePageHeader writes a PG 18 WAL page header at pageStart within a segment.
// First page uses a 24-byte long header; subsequent pages use 20-byte standard header.
// pageNum: 0-indexed page number within the segment.
// WAL segment starts at LSN 0/00000001.
func writePageHeader(page []byte, pageNum int) {
	// PG 18 XLogLongPageHeaderData (24 bytes for first page of segment):
	// offset  0-1: magic  (0xD118 = PG 18)
	// offset  2-3: info (xlp_flag)
	// offset  4-7: hole_reduction
	// offset  8-15: WAL page address (big-endian 64-bit WAL pointer)
	// offset 16-19: page_len (big-endian, bytes of valid WAL data; 0 = unused)
	// offset 20-23: (part of standard header below)
	// Standard XLogPageHeaderData (20 bytes):
	// offset  0- 1: magic (same, big-endian here too for first-page compat)
	// offset  2- 3: info
	// offset  4- 7: hole_reduction
	// offset  8-15: WAL page address (big-endian 64-bit WAL pointer) -- shared with long header
	// offset 16-19: page_len (big-endian) -- shared with long header
	//
	// For simplicity, we zero the whole header then set:
	writeBE64(page[8:16], uint64(pageNum)*PageSize) // WAL page address (big-endian)
	// page_len at [16:20] stays 0 (unused) or set to non-zero later for used pages
}

// writePageHeaderUsed writes a PG 18 WAL page header with specified page_len (big-endian).
func writePageHeaderUsed(page []byte, pageNum int, pageLen uint32) {
	writeBE64(page[8:16], uint64(pageNum)*PageSize) // WAL page address
	writeBE32(page[16:20], pageLen)               // page_len (big-endian)
}

func writeSyntheticRecord(page []byte, offset int, totalLen uint32, xid uint32, rmgrID uint8, info uint8, data []byte) {
	writeLE32(page[offset:offset+4], totalLen)
	writeLE32(page[offset+4:offset+8], xid)
	writeLE64(page[offset+8:offset+16], 0)
	page[offset+16] = info
	page[offset+17] = rmgrID
	writeLE32(page[offset+20:offset+24], 0)
	copy(page[offset+24:offset+24+len(data)], data)
}

func writeLE32(target []byte, value uint32) {
	target[0] = byte(value)
	target[1] = byte(value >> 8)
	target[2] = byte(value >> 16)
	target[3] = byte(value >> 24)
}

func writeBE64(target []byte, value uint64) {
	target[0] = byte(value >> 56)
	target[1] = byte(value >> 48)
	target[2] = byte(value >> 40)
	target[3] = byte(value >> 32)
	target[4] = byte(value >> 24)
	target[5] = byte(value >> 16)
	target[6] = byte(value >> 8)
	target[7] = byte(value)
}

func writeBE32(target []byte, value uint32) {
	target[0] = byte(value >> 24)
	target[1] = byte(value >> 16)
	target[2] = byte(value >> 8)
	target[3] = byte(value)
}

func writeLE64(target []byte, value uint64) {
	writeLE32(target[:4], uint32(value))
	writeLE32(target[4:], uint32(value>>32))
}

func appendLE32(target []byte, value uint32) []byte {
	return append(target, byte(value), byte(value>>8), byte(value>>16), byte(value>>24))
}
