package clog

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

// PageSize for CLOG is 8KB
const PageSize = 8192

// Transaction status values (2 bits per transaction)
const (
	StatusInProgress = 0x00
	StatusCommitted  = 0x01
	StatusAborted    = 0x02
	StatusSubtrans   = 0x03 // used for subtrans parent mapping
)

// Transaction status name
func StatusName(s uint8) string {
	switch s {
	case StatusInProgress:
		return "in-progress"
	case StatusCommitted:
		return "committed"
	case StatusAborted:
		return "aborted"
	case StatusSubtrans:
		return "subtrans"
	default:
		return "unknown"
	}
}

// CLOGReader reads and parses CLOG pages
type CLOGReader struct {
	dataDir string
}

// NewCLOGReader creates a new CLOG reader
func NewCLOGReader(dataDir string) *CLOGReader {
	return &CLOGReader{dataDir: dataDir}
}

// Page represents a single CLOG page
type Page struct {
	PageNum    int
	StartXid   uint32
	EndXid     uint32
	Transactions []TransactionStatus
}

// TransactionStatus represents status of a single transaction
type TransactionStatus struct {
	Xid    uint32
	Status uint8
	Name   string
}

// GetCLOGPath returns the path to the CLOG file for a given transaction ID
func GetCLOGPath(dataDir string, xid uint32) string {
	subdir := xid / 8192
	clogDir := filepath.Join(dataDir, "pg_clog")
	return filepath.Join(clogDir, fmt.Sprintf("%04X", subdir))
}

// ReadPage reads a CLOG page from the given file at given offset
func (r *CLOGReader) ReadPage(filePath string, pageNum int) (*Page, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	offset := int64(pageNum) * PageSize
	if _, err := f.Seek(offset, 0); err != nil {
		return nil, err
	}

	data := make([]byte, PageSize)
	n, err := f.Read(data)
	if err != nil {
		return nil, err
	}
	if n != PageSize {
		return nil, fmt.Errorf("incomplete read: got %d, expected %d", n, PageSize)
	}

	return r.parsePage(pageNum, data)
}

func (r *CLOGReader) parsePage(pageNum int, data []byte) (*Page, error) {
	startXid := uint32(pageNum) * 8192
	endXid := startXid + 8192

	page := &Page{
		PageNum:      pageNum,
		StartXid:     startXid,
		EndXid:       endXid,
		Transactions: make([]TransactionStatus, 0, 8192),
	}

	// Each byte contains 4 transactions (2 bits each)
	for byteIdx := 0; byteIdx < PageSize; byteIdx++ {
		b := data[byteIdx]
		// Extract 4 transactions from this byte
		for bitPos := 0; bitPos < 4; bitPos++ {
			status := (b >> (bitPos * 2)) & 0x03
			xid := startXid + uint32(byteIdx*4+bitPos)
			page.Transactions = append(page.Transactions, TransactionStatus{
				Xid:    xid,
				Status: status,
				Name:   StatusName(status),
			})
		}
	}

	return page, nil
}

// ReadRange reads transaction status for a range of XIDs
func (r *CLOGReader) ReadRange(startXid, endXid uint32) ([]TransactionStatus, error) {
	var results []TransactionStatus

	// Calculate which pages we need
	startPage := startXid / 8192
	endPage := endXid / 8192

	for pageNum := startPage; pageNum <= endPage; pageNum++ {
		filePath := filepath.Join(r.dataDir, "pg_clog", fmt.Sprintf("%04X", pageNum))
		page, err := r.ReadPage(filePath, 0)
		if err != nil {
			// File may not exist or be readable
			continue
		}

		for _, tx := range page.Transactions {
			if tx.Xid >= startXid && tx.Xid <= endXid {
				results = append(results, tx)
			}
		}
	}

	return results, nil
}

// DumpPage returns a visual representation of a CLOG page
func DumpPage(page *Page) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("CLOG Page %d (XID %d - %d)", page.PageNum, page.StartXid, page.EndXid))
	lines = append(lines, "Status: 0=in-progress, 1=committed, 2=aborted, 3=subtrans")
	lines = append(lines, "")

	// Show first 64 transactions as a grid
	lines = append(lines, "First 64 transactions:")
	for i := 0; i < 8 && i*8 < len(page.Transactions); i++ {
		line := fmt.Sprintf("%6d: ", page.StartXid+uint32(i*8))
		for j := 0; j < 8 && i*8+j < len(page.Transactions); j++ {
			tx := page.Transactions[i*8+j]
			switch tx.Status {
			case StatusInProgress:
				line += " . "
			case StatusCommitted:
				line += " C "
			case StatusAborted:
				line += " A "
			case StatusSubtrans:
				line += " S "
			default:
				line += " ? "
			}
		}
		lines = append(lines, line)
	}

	return fmt.Sprintf("%s\n... (%d total transactions)", lines[0], len(page.Transactions))
}

// GetStatistics returns summary statistics for a page
func GetStatistics(page *Page) map[string]int {
	stats := map[string]int{
		"in_progress": 0,
		"committed":   0,
		"aborted":     0,
		"subtrans":    0,
		"total":       len(page.Transactions),
	}

	for _, tx := range page.Transactions {
		switch tx.Status {
		case StatusInProgress:
			stats["in_progress"]++
		case StatusCommitted:
			stats["committed"]++
		case StatusAborted:
			stats["aborted"]++
		case StatusSubtrans:
			stats["subtrans"]++
		}
	}

	return stats
}

// SubtransReader reads and parses subtrans information
// Subtrans maps subtransaction XID -> parent XID
type SubtransReader struct {
	dataDir string
}

// NewSubtransReader creates a new Subtrans reader
func NewSubtransReader(dataDir string) *SubtransReader {
	return &SubtransReader{dataDir: dataDir}
}

// GetParent returns the parent XID for a given subtransaction
func (r *SubtransReader) GetParent(subxid uint32) (uint32, error) {
	// Subtrans uses similar structure to CLOG
	subtransDir := filepath.Join(r.dataDir, "pg_subtrans")

	// Calculate which page and offset
	pageNum := subxid / 8192
	offset := subxid % 8192

	pagePath := filepath.Join(subtransDir, fmt.Sprintf("%04X", pageNum))

	f, err := os.Open(pagePath)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// Read 4 bytes at the offset (uint32 parent XID)
	if _, err := f.Seek(int64(offset)*4, 0); err != nil {
		return 0, err
	}

	var parent uint32
	if err := binary.Read(f, binary.LittleEndian, &parent); err != nil {
		return 0, err
	}

	return parent, nil
}