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

	writeLE64(segment[8:16], 0)
	writeLE32(segment[16:20], 0)

	recordOffset := XLogLongPageHeaderSize
	recordLen := XLogRecordHeaderSize + 4
	writeLE32(segment[recordOffset:recordOffset+4], uint32(recordLen))
	writeLE32(segment[recordOffset+4:recordOffset+8], 42)
	writeLE64(segment[recordOffset+8:recordOffset+16], 0)
	segment[recordOffset+16] = 0x00
	segment[recordOffset+17] = 2
	writeLE32(segment[recordOffset+20:recordOffset+24], 0xDEADBEEF)
	copy(segment[recordOffset+24:recordOffset+28], []byte{1, 2, 3, 4})

	page1 := segment[PageSize : PageSize*2]
	writeLE64(page1[8:16], uint64(PageSize))
	writeLE32(page1[16:20], 0)

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
	writeLE64(segment[8:16], 0)
	writeLE32(segment[16:20], 0)

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

	writeLE64(segment[8:16], 0)
	writeLE32(segment[16:20], 0)
	fillerOffset := XLogLongPageHeaderSize
	fillerLen := 8120
	writeSyntheticRecord(segment, fillerOffset, uint32(fillerLen), 1, 2, 0x00, make([]byte, fillerLen-XLogRecordHeaderSize))

	startOffset := fillerOffset + fillerLen
	recordLen := XLogRecordHeaderSize + 32
	writeLE32(segment[startOffset:startOffset+4], uint32(recordLen))
	writeLE32(segment[startOffset+4:startOffset+8], 99)
	writeLE64(segment[startOffset+8:startOffset+16], 0)
	segment[startOffset+16] = 0x20
	segment[startOffset+17] = 2
	writeLE32(segment[startOffset+20:startOffset+24], 0)
	copy(segment[startOffset+24:PageSize], make([]byte, 8))

	page1 := segment[PageSize : PageSize*2]
	writeLE64(page1[8:16], uint64(PageSize))
	writeLE32(page1[16:20], uint32(recordLen-(PageSize-startOffset)))
	copy(page1[XLogPageHeaderSize:XLogPageHeaderSize+20], make([]byte, 20))

	if err := os.WriteFile(segmentPath, segment, 0o644); err != nil {
		t.Fatalf("write segment: %v", err)
	}

	reader := NewWALReader(dir)
	records, err := reader.ReadRecords(segmentPath, 0, 10)
	if err != nil {
		t.Fatalf("ReadRecords: %v", err)
	}
	if len(records) < 2 {
		t.Fatalf("len(records) = %d, want at least 2", len(records))
	}
	record := records[len(records)-1]
	if record.Xid != 99 {
		t.Fatalf("xid = %d, want 99", record.Xid)
	}
	if len(record.Data) != 32 {
		t.Fatalf("data len = %d, want 32", len(record.Data))
	}
}

func TestReadRecordsParsesBlockReferences(t *testing.T) {
	dir := t.TempDir()
	segmentPath := filepath.Join(dir, "000000010000000000000003")
	segment := make([]byte, PageSize)

	writeLE64(segment[8:16], 0)
	writeLE32(segment[16:20], 0)

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

func writeLE64(target []byte, value uint64) {
	writeLE32(target[:4], uint32(value))
	writeLE32(target[4:], uint32(value>>32))
}

func appendLE32(target []byte, value uint32) []byte {
	return append(target, byte(value), byte(value>>8), byte(value>>16), byte(value>>24))
}
