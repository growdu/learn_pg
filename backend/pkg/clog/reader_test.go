package clog

import (
	"testing"
)

func TestStatusName(t *testing.T) {
	tests := []struct {
		input uint8
		want  string
	}{
		{StatusInProgress, "in-progress"},
		{StatusCommitted, "committed"},
		{StatusAborted, "aborted"},
		{StatusSubtrans, "subtrans"},
		{0xFF, "unknown"},
		{4, "unknown"},
	}

	for _, tt := range tests {
		got := StatusName(tt.input)
		if got != tt.want {
			t.Errorf("StatusName(%d) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestGetCLOGPath(t *testing.T) {
	tests := []struct {
		xid     uint32
		dataDir string
		want    string
	}{
		{0, "/data", "/data/pg_xact/0000"},
		{100, "/data", "/data/pg_xact/0000"},
		{TransactionsPerPage, "/data", "/data/pg_xact/0000"},
		{uint32(transactionsPerSegment), "/data", "/data/pg_xact/0001"},
		{uint32(transactionsPerSegment) + 1, "/data", "/data/pg_xact/0001"},
	}

	for _, tt := range tests {
		got := GetCLOGPath(tt.dataDir, tt.xid)
		if got != tt.want {
			t.Errorf("GetCLOGPath(%d, %q) = %q, want %q", tt.xid, tt.dataDir, got, tt.want)
		}
	}
}

func TestCLOGReaderNew(t *testing.T) {
	reader := NewCLOGReader("/test/data")
	if reader == nil {
		t.Error("NewCLOGReader returned nil")
	}
	if reader.dataDir != "/test/data" {
		t.Errorf("dataDir = %q, want /test/data", reader.dataDir)
	}
}

func TestParsePage(t *testing.T) {
	reader := NewCLOGReader("/test")
	// Create a mock page: all committed
	data := make([]byte, PageSize)
	for i := range data {
		data[i] = 0x55 // 01 01 01 01 pattern = all committed
	}

	page, err := reader.parsePage(0, data)
	if err != nil {
		t.Fatalf("parsePage error: %v", err)
	}

	if page.PageNum != 0 {
		t.Errorf("PageNum = %d, want 0", page.PageNum)
	}
	if page.StartXid != 0 {
		t.Errorf("StartXid = %d, want 0", page.StartXid)
	}
	if page.EndXid != TransactionsPerPage-1 {
		t.Errorf("EndXid = %d, want %d", page.EndXid, TransactionsPerPage-1)
	}
	// Each byte has 4 transactions (2 bits each), so 8192 bytes = 32768 transactions
	if len(page.Transactions) != TransactionsPerPage {
		t.Errorf("len(Transactions) = %d, want %d", len(page.Transactions), TransactionsPerPage)
	}
}

func TestParsePageMixed(t *testing.T) {
	reader := NewCLOGReader("/test")
	// Create a page with mixed statuses
	// 0xE5 = 11100101 binary
	// bit 0-1: 01 = committed, bit 2-3: 01 = committed, bit 4-5: 10 = aborted, bit 6-7: 11 = subtrans
	data := make([]byte, PageSize)
	data[0] = 0xE5

	page, err := reader.parsePage(0, data)
	if err != nil {
		t.Fatalf("parsePage error: %v", err)
	}

	// First 4 transactions: committed, committed, aborted, subtrans
	tx0 := page.Transactions[0]
	if tx0.Status != StatusCommitted {
		t.Errorf("tx0: status=%d, want committed", tx0.Status)
	}

	tx1 := page.Transactions[1]
	if tx1.Status != StatusCommitted {
		t.Errorf("tx1: status=%d, want committed", tx1.Status)
	}

	tx2 := page.Transactions[2]
	if tx2.Status != StatusAborted {
		t.Errorf("tx2: status=%d, want aborted", tx2.Status)
	}

	tx3 := page.Transactions[3]
	if tx3.Status != StatusSubtrans {
		t.Errorf("tx3: status=%d, want subtrans", tx3.Status)
	}
}

func TestGetStatistics(t *testing.T) {
	reader := NewCLOGReader("/test")
	data := make([]byte, PageSize)
	data[0] = 0x55 // All committed (0x55 = 01 01 01 01)

	page, _ := reader.parsePage(0, data)
	stats := GetStatistics(page)

	if stats["total"] != TransactionsPerPage {
		t.Errorf("total = %d, want %d", stats["total"], TransactionsPerPage)
	}
	if stats["committed"] != 4 {
		t.Errorf("committed = %d, want 4", stats["committed"])
	}
	if stats["aborted"] != 0 {
		t.Errorf("aborted = %d, want 0", stats["aborted"])
	}
	if stats["in_progress"] != TransactionsPerPage-4 {
		t.Errorf("in_progress = %d, want %d", stats["in_progress"], TransactionsPerPage-4)
	}
}

func TestGetStatisticsMixed(t *testing.T) {
	reader := NewCLOGReader("/test")
	data := make([]byte, PageSize)
	data[0] = 0xE5 // 11 10 01 01

	page, _ := reader.parsePage(0, data)
	stats := GetStatistics(page)

	// Check counts
	if stats["subtrans"] == 0 {
		t.Errorf("expected subtrans > 0")
	}
	if stats["aborted"] == 0 {
		t.Errorf("expected aborted > 0")
	}
}

func TestDumpPage(t *testing.T) {
	reader := NewCLOGReader("/test")
	data := make([]byte, PageSize)
	page, _ := reader.parsePage(0, data)

	dump := DumpPage(page)
	if len(dump) == 0 {
		t.Error("DumpPage returned empty")
	}
}

func TestSubtransReaderNew(t *testing.T) {
	reader := NewSubtransReader("/test/data")
	if reader == nil {
		t.Error("NewSubtransReader returned nil")
	}
	if reader.dataDir != "/test/data" {
		t.Errorf("dataDir = %q, want /test/data", reader.dataDir)
	}
}
