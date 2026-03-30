package wal

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// WAL page size constant
const PageSize = 8192

// XLogRecordHeaderSize is the fixed header size
const XLogRecordHeaderSize = 24

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
	LSN         string // e.g. "0/16D4F30"
	PageOffset  uint32
	RecordLen   uint32
	RmgrID      uint8
	RmgrName    string
	Info        uint8
	Xid         uint32
	PrevLSN     string
	Data        []byte
	Blocks      []BlockRef
}

// BlockRef represents a block reference in WAL record
type BlockRef struct {
	ForkNum   uint8
	BlockNum  uint32
	Shared    bool
	RNode     uint64
	RelNode   uint32
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
		if !e.IsDir() && strings.HasPrefix(e.Name(), "0000000") {
			segments = append(segments, filepath.Join(walDir, e.Name()))
		}
	}
	sort.Strings(segments)
	return segments, nil
}

// ReadRecords reads WAL records from a segment file
func (w *WALReader) ReadRecords(segmentFile string, startOffset, limit int) ([]Record, error) {
	f, err := os.Open(segmentFile)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var records []Record
	var currentLSN string

	// Read page by page
	for pageNum := 0; ; pageNum++ {
		header := make([]byte, PageSize)
		n, err := f.Read(header)
		if n == 0 || err == io.EOF {
			break
		}
		if err != nil {
			return records, err
		}

		lsnHigh := binary.BigEndian.Uint32(header[0:4])
		lsnLow := binary.BigEndian.Uint32(header[4:8])
		currentLSN = fmt.Sprintf("%X/%08X", lsnHigh, lsnLow)

		// First 32 bytes of page is special header for page 0
		if pageNum == 0 {
			continue // Skip XLogLongPageHeaderData for now
		}

		// XLog page header starts at offset 24
		_ = binary.BigEndian.Uint16(header[24:26]) // xlp_info (unused for now)
		xlogRem := binary.BigEndian.Uint16(header[26:28])

		// Read records from this page
		offset := int(24 + xlogRem)
		for offset < PageSize {
			if offset+XLogRecordHeaderSize > PageSize {
				break
			}

			recLen := binary.BigEndian.Uint32(header[offset : offset+4])
			if recLen == 0 {
				break
			}

			if recLen < XLogRecordHeaderSize || offset+int(recLen) > PageSize {
				break
			}

			rmgrid := header[offset+4]
			info := header[offset+5]
			xid := binary.BigEndian.Uint32(header[offset+8 : offset+12])
			prevLSNHigh := binary.BigEndian.Uint32(header[offset+12 : offset+16])
			prevLSNLow := binary.BigEndian.Uint32(header[offset+16 : offset+20])
			prevLSN := fmt.Sprintf("%X/%08X", prevLSNHigh, prevLSNLow)

			// Read variable-length headers
			dataStart := offset + XLogRecordHeaderSize
			dataEnd := offset + int(recLen)

			rmgrName := RmgrNames[rmgrid]
			if rmgrName == "" {
				rmgrName = fmt.Sprintf("RMgr%d", rmgrid)
			}

			record := Record{
				LSN:        currentLSN,
				PageOffset: uint32(offset),
				RecordLen:  recLen,
				RmgrID:     rmgrid,
				RmgrName:   rmgrName,
				Info:       info,
				Xid:        xid,
				PrevLSN:    prevLSN,
				Data:       header[dataStart:dataEnd],
			}

			records = append(records, record)

			if limit > 0 && len(records) >= limit {
				return records, nil
			}

			offset += int(recLen)
		}
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

// HexEncode returns hex string of data
func HexEncode(data []byte) string {
	return hex.EncodeToString(data)
}