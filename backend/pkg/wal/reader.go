package wal

import (
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// WAL page layout (verified against PG 18.1 binary with pg_waldump):
//   First page of segment: 40-byte (0x28) XLogLongPageHeaderData
//   Continuation pages:    20-byte XLogShortPageHeaderData
//
// XLogLongPageHeaderData layout (40 bytes total):
//   Off 0  (2): magic     = 0xD118 (LE)
//   Off 2  (2): info      = 0x0006 (LE)
//   Off 4  (4): page_size = 0x01000000 (BE = 16777216 = 16MB)
//   Off 8  (4): xlp_tli   = BE uint32
//   Off 12 (4): xlp_seg_size = BE uint32
//   Off 16 (4): xlp_xlog_blcknz = BE uint32
//   Off 20 (20): WAL data starts here (off 0x14 = 20 in page, but file offset 0x28)
//   → WAL records actually start at file byte 0x28 = 40
//
// WAL address (walAddr) uses MIXED ENDIAN encoding:
//   high 32 bits: big-endian (segment number)
//   low 32 bits:  little-endian (offset within WAL segment)
//
// WAL record header fields (LE):
//   xl_tot_len: offset 0,  uint32 (LE)
//   xl_xid:     offset 4,  uint32 (LE)
//   xl_prev:    offset 8,  uint32 (LE)
//   xl_info:    offset 12, uint8
//   xl_rmid:    offset 13, uint8
//   padding:    offset 14-15, 2 bytes
//   xl_crc:     offset 20, uint32 (LE)
//   Total fixed header: 24 bytes
const PageSize             = 8192
const XLogPageHeaderSize     = 20   // XLogShortPageHeaderData
const XLogLongPageHeaderSize = 40   // XLogLongPageHeaderData (40 bytes, not 20!)
const WALSegmentSize         = 16777216 // 0x1000000
const XLogRecordHeaderSize   = 24
const WALRecordAlign         = 8

// XLogRecordHeaderSize is the fixed header size
// Rmgr names for PG 18
var RmgrNames = map[uint8]string{
	0:  "XLOG",
	1:  "Heap2",
	2:  "Heap",
	3:  "Btree",
	4:  "Hash",
	5:  "Gist",
	6:  "SpGist",
	7:  "Gin",
	8:  "BRIN",
	9:  "Standby",
	10: "Heap3",
	11: "Logical",
}

// Record represents a parsed WAL record
type Record struct {
	LSN          string // e.g. "0/16D4F30"
	LSNValue     uint64
	PageOffset   uint32
	RecordLen    uint32
	PayloadLen   uint32
	RmgrID       uint8
	RmgrName     string
	Operation    string
	Info         uint8
	Xid          uint32
	PrevLSN      string
	PrevLSNValue uint64
	CRC          uint32
	Data         []byte
	Blocks       []BlockRef
	Details      map[string]interface{}
}

// BlockRef represents a block reference in WAL record
type BlockRef struct {
	ID         uint8  `json:"id"`
	ForkNum    uint8  `json:"forkNum"`
	BlockNum   uint32 `json:"blockNum"`
	HasImage   bool   `json:"hasImage"`
	HasData    bool   `json:"hasData"`
	WillInit   bool   `json:"willInit"`
	SameRel    bool   `json:"sameRel"`
	DataLen    uint16 `json:"dataLen"`
	ImageLen   uint16 `json:"imageLen,omitempty"`
	RelSpcNode uint32 `json:"relSpcNode,omitempty"`
	RelDbNode  uint32 `json:"relDbNode,omitempty"`
	RelNode    uint32 `json:"relNode,omitempty"`
}

// WALReader reads and parses WAL files
type WALReader struct {
	dataDir string
}

// NewWALReader creates a new WAL reader for given data directory
func NewWALReader(dataDir string) *WALReader {
	return &WALReader{dataDir: dataDir}
}

// ListWALSegments returns all WAL segment files
func (w *WALReader) ListWALSegments() ([]string, error) {
	walDir := filepath.Join(w.dataDir, "pg_wal")
	entries, err := os.ReadDir(walDir)
	if err != nil {
		return nil, fmt.Errorf("cannot read pg_wal directory: %w", err)
	}

	var segments []string
	for _, e := range entries {
		if !e.IsDir() && isWALSegmentName(e.Name()) {
			segments = append(segments, filepath.Join(walDir, e.Name()))
		}
	}
	sort.Strings(segments)
	return segments, nil
}

// ReadRecords reads WAL records from a segment file.
// segNum is the WAL segment number extracted from the filename (e.g. 4 from "000000010000000000000004").
func (w *WALReader) ReadRecords(segmentFile string, segNum uint64, startOffset, limit int) ([]Record, error) {
	data, err := os.ReadFile(segmentFile)
	if err != nil {
		return nil, err
	}

	log.Printf("[WAL] ReadRecords: file=%s size=%d startOffset=%d limit=%d",
		segmentFile, len(data), startOffset, limit)

	var records []Record
	var pending []byte
	var pendingLen int
	var pendingLSN uint64
	var pendingOffset uint32

	pagesScanned := 0
	bytesExamined := 0

	for pageStart := 0; pageStart+PageSize <= len(data); pageStart += PageSize {
		page := data[pageStart : pageStart+PageSize]
		headerSize := XLogPageHeaderSize
		isFirstPage := pageStart == 0
		if isFirstPage {
			headerSize = XLogLongPageHeaderSize
		}
		if len(page) < headerSize {
			break
		}

		// WAL address: compute from segment file name (segNum) + file offset.
		// pageAddr read from the page header is a hint; use it only for the
		// "start of page" value in debug logs, not for LSN computation.
		walAddrHint := readLE64(page[8:16])
		magic := readLE16(page[0:2])
		info := readLE16(page[2:4])

		// Validate WAL page header magic. Valid PG 18 WAL pages
		// always have magic == 0xD118 (LE). Skip pages with invalid
		// magic to avoid parsing garbage data.
		if magic != 0xD118 {
			log.Printf("[WAL]   page %d: start=%d hdrSize=%d magic=0x%04X INVALID (expected 0xD118), skipping",
				pagesScanned, pageStart, headerSize, magic)
			pagesScanned++
			continue
		}

		pagesScanned++
		bytesExamined += headerSize

		log.Printf("[WAL]   page %d: start=%d hdrSize=%d magic=0x%04X info=0x%04X walAddrHint=0x%X",
			pagesScanned-1, pageStart, headerSize, magic, info, walAddrHint)

		offset := headerSize

		// PG 13+ removed xlp_len from XLogPageHeaderData.
		// page_len == 0 is NOT a skip condition.
		// Instead, scan for WAL records until we run out of page space.
		// If the page is empty, the first record won't be valid (rec_len==0 breaks).

		if len(pending) > 0 {
			available := PageSize - headerSize
			need := pendingLen - len(pending)
			take := need
			if take > available {
				take = available
			}
			pending = append(pending, page[headerSize:headerSize+take]...)
			if len(pending) == pendingLen {
				record := buildRecord(pending, pendingLSN, pendingOffset)
				records = append(records, record)
				if limit > 0 && len(records) >= limit {
					return records, nil
				}
				pending = nil
				pendingLen = 0
				// Continue parsing remaining records on this page
				offset = headerSize + take
			} else {
				// Still waiting for more data; advance offset past what we consumed
				offset = headerSize + take
				continue
			}
		} else if pageStart > 0 {
			// Non-first page: data starts immediately after standard 20-byte header.
			// No rem_len field in PG 18 standard page header.
			offset = headerSize
		}

		for offset+XLogRecordHeaderSize <= PageSize {
			if startOffset > 0 && pageStart+offset < startOffset {
				offset++
				continue
			}

			recLen := int(readLE32(page[offset : offset+4]))
			if recLen == 0 {
				break
			}
			if recLen < XLogRecordHeaderSize {
				break
			}
			lsnValue := (segNum << 32) | uint64(offset)
			if offset+recLen > PageSize {
				pending = append([]byte(nil), page[offset:PageSize]...)
				pendingLen = recLen
				pendingLSN = lsnValue
				pendingOffset = uint32(offset)
				break
			}

			record := buildRecord(page[offset:offset+recLen], lsnValue, uint32(offset))
			records = append(records, record)
			if limit > 0 && len(records) >= limit {
				return records, nil
			}

			offset += alignRecordLength(recLen)
		}
	}

	log.Printf("[WAL] ReadRecords done: scanned %d pages, found %d records",
		pagesScanned, len(records))
	return records, nil
}

// TailRecords returns the newest parsed records across recent WAL segments.
func (w *WALReader) TailRecords(limit int) ([]Record, error) {
	if limit <= 0 {
		limit = 100
	}

	segments, err := w.ListWALSegments()
	if err != nil {
		return nil, err
	}
	if len(segments) == 0 {
		return []Record{}, nil
	}

	var records []Record
	for i := len(segments) - 1; i >= 0 && len(records) < limit*2; i-- {
		segNum := extractSegNum(filepath.Base(segments[i]))
		segmentRecords, err := w.ReadRecords(segments[i], segNum, 0, 0)
		if err != nil {
			continue
		}
		if len(segmentRecords) == 0 {
			continue
		}
		records = append(segmentRecords, records...)
	}

	sort.Slice(records, func(i, j int) bool {
		return records[i].LSNValue < records[j].LSNValue
	})
	if len(records) > limit {
		records = records[len(records)-limit:]
	}
	return records, nil
}

// ParseLSN converts LSN string to components
func ParseLSN(lsn string) (uint32, uint32, error) {
	parts := strings.Split(lsn, "/")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid LSN format: %s", lsn)
	}
	var hi, lo uint32
	fmt.Sscanf(parts[0], "%X", &hi)
	fmt.Sscanf(parts[1], "%X", &lo)
	return hi, lo, nil
}

// FormatLSN formats high/low as LSN string
func FormatLSN(hi, lo uint32) string {
	return fmt.Sprintf("%X/%08X", hi, lo)
}

// FormatLSN64 formats a WAL pointer from a single uint64 value.
func FormatLSN64(lsn uint64) string {
	hi := uint32(lsn >> 32)
	lo := uint32(lsn)
	return FormatLSN(hi, lo)
}

// HexEncode returns hex string of data
func HexEncode(data []byte) string {
	return hex.EncodeToString(data)
}

func lookupRmgrName(rmgrID uint8) string {
	if name, ok := RmgrNames[rmgrID]; ok {
		return name
	}
	return fmt.Sprintf("RMgr%d", rmgrID)
}

func buildRecord(raw []byte, lsnValue uint64, pageOffset uint32) Record {
	xid := readLE32(raw[4:8])
	prevLSNValue := readLE64(raw[8:16])
	info := raw[16]
	rmgrID := raw[17]
	crc := readLE32(raw[20:24])
	op := ParseRecordInfo(rmgrID, info)
	payload := append([]byte(nil), raw[XLogRecordHeaderSize:]...)
	blocks := parseBlockReferences(payload)
	details := ParseRMgrData(rmgrID, info, payload)
	if len(blocks) > 0 {
		details["block_ref_count"] = len(blocks)
	}

	return Record{
		LSN:          FormatLSN64(lsnValue),
		LSNValue:     lsnValue,
		PageOffset:   pageOffset,
		RecordLen:    uint32(len(raw)),
		PayloadLen:   uint32(len(payload)),
		RmgrID:       rmgrID,
		RmgrName:     lookupRmgrName(rmgrID),
		Operation:    op.OpName,
		Info:         info,
		Xid:          xid,
		PrevLSN:      FormatLSN64(prevLSNValue),
		PrevLSNValue: prevLSNValue,
		CRC:          crc,
		Data:         payload,
		Blocks:       blocks,
		Details:      details,
	}
}

func parseBlockReferences(payload []byte) []BlockRef {
	var blocks []BlockRef
	var lastRel struct {
		spc uint32
		db  uint32
		rel uint32
		ok  bool
	}

	for offset := 0; offset+4 <= len(payload); {
		id := payload[offset]
		if id == 254 || id == 255 || id > 32 {
			break
		}

		forkFlags := payload[offset+1]
		dataLen := readLE16(payload[offset+2 : offset+4])
		offset += 4

		ref := BlockRef{
			ID:       id,
			ForkNum:  forkFlags & 0x0F,
			HasImage: forkFlags&0x10 != 0,
			HasData:  forkFlags&0x20 != 0,
			WillInit: forkFlags&0x40 != 0,
			SameRel:  forkFlags&0x80 != 0,
			DataLen:  dataLen,
		}

		if ref.HasImage {
			if offset+8 > len(payload) {
				break
			}
			ref.ImageLen = readLE16(payload[offset : offset+2])
			offset += 8
		}

		if ref.SameRel && lastRel.ok {
			ref.RelSpcNode = lastRel.spc
			ref.RelDbNode = lastRel.db
			ref.RelNode = lastRel.rel
		} else {
			if offset+12 > len(payload) {
				break
			}
			ref.RelSpcNode = readLE32(payload[offset : offset+4])
			ref.RelDbNode = readLE32(payload[offset+4 : offset+8])
			ref.RelNode = readLE32(payload[offset+8 : offset+12])
			lastRel = struct {
				spc uint32
				db  uint32
				rel uint32
				ok  bool
			}{ref.RelSpcNode, ref.RelDbNode, ref.RelNode, true}
			offset += 12
		}

		if offset+4 > len(payload) {
			break
		}
		ref.BlockNum = readLE32(payload[offset : offset+4])
		offset += 4

		if ref.HasData {
			if offset+int(ref.DataLen) > len(payload) {
				break
			}
			offset += int(ref.DataLen)
		}

		blocks = append(blocks, ref)
	}

	return blocks
}

func isWALSegmentName(name string) bool {
	if len(name) != 24 {
		return false
	}
	for _, ch := range name {
		if !strings.ContainsRune("0123456789ABCDEF", ch) {
			return false
		}
	}
	return true
}

func alignRecordLength(length int) int {
	return (length + WALRecordAlign - 1) &^ (WALRecordAlign - 1)
}

// extractSegNum extracts the segment number from a WAL segment filename.
// Filename format: 24-character hex string like "000000010000000000000004".
// The last 8 hex digits = segment number within the timeline.
func extractSegNum(filename string) uint64 {
	if len(filename) >= 8 {
		var segNum uint64
		fmt.Sscanf(filename[len(filename)-8:], "%x", &segNum)
		return segNum
	}
	return 0
}

// readLE32 reads a little-endian uint32
func readLE32(b []byte) uint32 {
	return uint32(b[0]) |
		uint32(b[1])<<8 |
		uint32(b[2])<<16 |
		uint32(b[3])<<24
}

// readBE32 reads a big-endian uint32 (used for WAL page header fields in PG 18)
func readBE32(b []byte) uint32 {
	return uint32(b[0])<<24 |
		uint32(b[1])<<16 |
		uint32(b[2])<<8 |
		uint32(b[3])
}

// readBE64 reads a big-endian uint64 (used for WAL page address in PG 18)
func readBE64(b []byte) uint64 {
	return uint64(b[0])<<56 |
		uint64(b[1])<<48 |
		uint64(b[2])<<40 |
		uint64(b[3])<<32 |
		uint64(b[4])<<24 |
		uint64(b[5])<<16 |
		uint64(b[6])<<8 |
		uint64(b[7])
}

// readMixedEndian64 reads the WAL address (walAddr) stored at offset 8 of
// XLogLongPageHeaderData. In PG 18, walAddr is a pure little-endian uint64
// stored directly (not mixed-endian):
//   bytes[8:16] as LE64 = segment_number<<32 | offset_within_segment
// Verified: bytes 00000000 02000000 at off=8 gives 0x200000000 (seg=2, off=0).
func readMixedEndian64(b []byte) uint64 {
	return readLE64(b[0:8])
}

// readLE64 reads a little-endian uint64
func readLE64(b []byte) uint64 {
	return uint64(readLE32(b[:4])) | uint64(readLE32(b[4:8]))<<32
}

func readLE16(b []byte) uint16 {
	return uint16(b[0]) | uint16(b[1])<<8
}
