package wal

import (
	"testing"
)

func TestParseRecordInfo(t *testing.T) {
	tests := []struct {
		rmgrid uint8
		info   uint8
		want   string
	}{
		{0, 0x00, "XLOG_NOOP"},
		{0, 0x01, "XLOG/NEXTOID"},
		{2, 0x00, "HEAP/INSERT"},
		{2, 0x10, "HEAP/DELETE"},
		{2, 0x20, "HEAP/UPDATE"},
		{2, 0x30, "HEAP/HOT_UPDATE"},
		{3, 0x01, "BTREE/OP_1"},
		{1, 0x20, "HEAP2/VISIBLE"},
		{10, 0x10, "HEAP3/OP_16"},
	}

	for _, tt := range tests {
		got := ParseRecordInfo(tt.rmgrid, tt.info)
		if got.OpName != tt.want {
			t.Errorf("ParseRecordInfo(%d, 0x%02X) = %q, want %q", tt.rmgrid, tt.info, got.OpName, tt.want)
		}
	}
}

func TestDumpHex(t *testing.T) {
	data := []byte{0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64}
	got := DumpHex(data, 8)

	// Check it contains expected elements
	if len(got) == 0 {
		t.Error("DumpHex returned empty string")
	}

	// Check hex output format
	if got[:4] != "0000" {
		t.Errorf("DumpHex offset format wrong: %s", got[:4])
	}
}

func TestDumpHexEmpty(t *testing.T) {
	got := DumpHex([]byte{}, 16)
	if got != "" {
		t.Errorf("DumpHex empty = %q, want empty", got)
	}
}

func TestDumpHexCustomBytesPerLine(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5}
	got := DumpHex(data, 2)
	// Should have 3 lines for 5 bytes
	if got == "" {
		t.Error("DumpHex returned empty")
	}
}

func TestParseRMgrData(t *testing.T) {
	// Test XLOG rmgrid
	data := []byte{0, 0, 0, 10, 1, 2, 3, 4, 5, 6, 7, 8}
	result := ParseRMgrData(0, 0, data)

	if result["rmgrid"].(uint8) != 0 {
		t.Errorf("rmgrid = %v, want 0", result["rmgrid"])
	}
	if result["rmgr"] != "XLOG" {
		t.Errorf("rmgr = %v, want XLOG", result["rmgr"])
	}
	if result["next_len"].(uint32) != 10 {
		t.Errorf("next_len = %v, want 10", result["next_len"])
	}
}

func TestParseRMgrDataHeap(t *testing.T) {
	// Test Heap rmgrid
	data := make([]byte, 24)
	data[0] = 0x00
	data[1] = 0x00
	data[2] = 0x00
	data[3] = 0x01 // block_rnode = 1
	data[4] = 0x00
	data[5] = 0x00
	data[6] = 0x00
	data[7] = 0x01 // block_forknum = 1
	data[8] = 0x00
	data[9] = 0x00
	data[10] = 0x00
	data[11] = 0x05 // block_num = 5

	result := ParseRMgrData(2, 0, data)

	if result["block_rnode"].(uint32) != 1 {
		t.Errorf("block_rnode = %v, want 1", result["block_rnode"])
	}
	if result["block_num"].(uint32) != 5 {
		t.Errorf("block_num = %v, want 5", result["block_num"])
	}
}

func TestParseRMgrDataTruncated(t *testing.T) {
	// Test truncated data
	data := make([]byte, 100)
	result := ParseRMgrData(0, 0, data)

	if result["truncated"] != true {
		t.Error("expected truncated=true")
	}
	if result["total_len"].(int) != 100 {
		t.Errorf("total_len = %v, want 100", result["total_len"])
	}
}

func TestRMgrInfo(t *testing.T) {
	// Test RMgrInfo map
	info, ok := RMgrInfo[0]
	if !ok {
		t.Error("RMgrInfo[0] not found")
	}
	if info.Name != "XLOG" {
		t.Errorf("RMgrInfo[0].Name = %q, want XLOG", info.Name)
	}

	info2, ok := RMgrInfo[3]
	if !ok {
		t.Error("RMgrInfo[3] not found")
	}
	if info2.Name != "Btree" {
		t.Errorf("RMgrInfo[3].Name = %q, want Btree", info2.Name)
	}
}