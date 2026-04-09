package wal

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// WAL page size constant
const PageSize = 8192

const (
	XLogPageHeaderSize     = 20
	XLogLongPageHeaderSize = 36
	XLogRecordHeaderSize   = 24
	WALRecordAlign         = 8
)

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

// ReadRecords reads WAL records from a segment file
func (w *WALReader) ReadRecords(segmentFile string, startOffset, limit int) ([]Record, error) {
	data, err := os.ReadFile(segmentFile)
	if err != nil {
		return nil, err
	}

	var records []Record
	var pending []byte
	var pendingLen int
	var pendingLSN uint64
	var pendingOffset uint32

	for pageStart := 0; pageStart+PageSize <= len(data); pageStart += PageSize {
		page := data[pageStart : pageStart+PageSize]
		headerSize := XLogPageHeaderSize
		if pageStart == 0 {
			headerSize = XLogLongPageHeaderSize
		}
		if len(page) < headerSize {
			break
		}

		pageAddr := readLE64(page[8:16])
		remLen := int(readLE32(page[16:20]))
		offset := headerSize

		if len(pending) > 0 {
			available := PageSize - headerSize
			need := pendingLen - len(pending)
			take := need
			if take > available {
				take = available
			}
			pending = append(pending, page[headerSize:headerSize+take]...)
			offset = headerSize + take
			if len(pending) == pendingLen {
				record := buildRecord(pending, pendingLSN, pendingOffset)
				records = append(records, record)
				if limit > 0 && len(records) >= limit {
					return records, nil
				}
				pending = nil
				pendingLen = 0
			} else {
				continue
			}
		} else if pageStart > 0 && remLen > 0 {
			if remLen >= PageSize-headerSize {
				continue
			}
			offset += remLen
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
			lsnValue := pageAddr + uint64(offset)
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
		segmentRecords, err := w.ReadRecords(segments[i], 0, 0)
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

func readLE32(b []byte) uint32 {
	return uint32(b[0]) |
		uint32(b[1])<<8 |
		uint32(b[2])<<16 |
		uint32(b[3])<<24
}

func readLE64(b []byte) uint64 {
	return uint64(readLE32(b[:4])) | uint64(readLE32(b[4:8]))<<32
}

func readLE16(b []byte) uint16 {
	return uint16(b[0]) | uint16(b[1])<<8
}
