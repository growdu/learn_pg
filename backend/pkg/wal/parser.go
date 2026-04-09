package wal

import (
	"bytes"
	"fmt"
)

// RMgrInfo maps RmgrID to its operation types
var RMgrInfo = map[uint8]struct {
	Name     string
	MaxLen   uint8
	DescFunc string
}{
	0:  {"XLOG", 0xFF, "Transaction/bulk operations"},
	1:  {"Heap2", 0x20, "Heap2 operations"},
	2:  {"Heap", 0x20, "Heap operations"},
	3:  {"Btree", 0x2F, "Btree operations"},
	4:  {"Hash", 0x20, "Hash operations"},
	5:  {"Gist", 0x20, "GiST operations"},
	6:  {"SpGist", 0x20, "Sp-GiST operations"},
	7:  {"Gin", 0x20, "GIN operations"},
	8:  {"BRIN", 0x20, "BRIN operations"},
	10: {"Heap3", 0x20, "Heap3 operations"},
}

// Info flag masks
const (
	XLOG_INFO_MASK_COMPRESS  = 0x01
	XLOG_INFO_MASK_BKP_RMGR  = 0x40
	XLOG_INFO_MASK_XID_SPEC  = 0x08
	XLOG_INFO_MASK_HEAP_CONC = 0x20
)

// RecordInfo describes the operation type
type RecordInfo struct {
	OpName string
	Desc   string
}

// ParseRecordInfo returns operation name and description
func ParseRecordInfo(rmgrid, info uint8) RecordInfo {
	desc := "unknown"
	baseInfo := info

	// Determine operation from RMGR-specific info bits
	switch rmgrid {
	case 0: // XLOG
		switch baseInfo & 0x0F {
		case 0x00:
			desc = "XLOG_NOOP"
		case 0x01:
			desc = "XLOG/NEXTOID"
		case 0x02:
			desc = "XLOG/SLRU"
		default:
			desc = fmt.Sprintf("XLOG/OP_%d", baseInfo&0x0F)
		}
	case 1: // Heap2
		switch baseInfo {
		case 0x00:
			desc = "HEAP2/CLEAN"
		case 0x10:
			desc = "HEAP2/NEW_CID"
		case 0x20:
			desc = "HEAP2/VISIBLE"
		case 0x30:
			desc = "HEAP2/FREEZE"
		default:
			desc = fmt.Sprintf("HEAP2/OP_%d", baseInfo)
		}
	case 2: // Heap
		switch baseInfo {
		case 0x00:
			desc = "HEAP/INSERT"
		case 0x10:
			desc = "HEAP/DELETE"
		case 0x20:
			desc = "HEAP/UPDATE"
		case 0x30:
			desc = "HEAP/HOT_UPDATE"
		case 0x40:
			desc = "HEAP/TRUNCATE"
		case 0x50:
			desc = "HEAP/TBLSPC_CREATE"
		default:
			desc = fmt.Sprintf("HEAP/OP_%d", baseInfo)
		}
	case 3: // Btree
		desc = fmt.Sprintf("BTREE/OP_%d", baseInfo&0x0F)
	case 10: // Heap3
		desc = fmt.Sprintf("HEAP3/OP_%d", baseInfo)
	default:
		desc = fmt.Sprintf("RMGR_%d/OP_%d", rmgrid, baseInfo)
	}

	return RecordInfo{OpName: desc, Desc: desc}
}

// DumpHex returns formatted hex dump of WAL record data
func DumpHex(data []byte, bytesPerLine int) string {
	if bytesPerLine == 0 {
		bytesPerLine = 16
	}

	var buf bytes.Buffer
	for i := 0; i < len(data); i += bytesPerLine {
		// Offset
		buf.WriteString(fmt.Sprintf("%04X  ", i))

		// Hex
		end := i + bytesPerLine
		if end > len(data) {
			end = len(data)
		}
		for j := i; j < end; j++ {
			buf.WriteString(fmt.Sprintf("%02X ", data[j]))
			if (j-i)%8 == 7 {
				buf.WriteString(" ")
			}
		}

		// Padding
		if end-i < bytesPerLine {
			for j := 0; j < bytesPerLine-(end-i); j++ {
				buf.WriteString("   ")
				if (end-i+j)%8 == 7 {
					buf.WriteString(" ")
				}
			}
		}

		// ASCII
		buf.WriteString(" |")
		for j := i; j < end; j++ {
			if data[j] >= 32 && data[j] < 127 {
				buf.WriteByte(data[j])
			} else {
				buf.WriteByte('.')
			}
		}
		buf.WriteString("|\n")
	}
	return buf.String()
}

// ParseRMgrData parses RMgr-specific data payload
// This is a simplified parser for demonstration
func ParseRMgrData(rmgrid uint8, info uint8, data []byte) map[string]interface{} {
	result := map[string]interface{}{
		"rmgrid": rmgrid,
		"rmgr":   RmgrNames[rmgrid],
		"info":   info,
		"len":    len(data),
		"hex":    HexEncode(data[:min(64, len(data))]),
	}

	if len(data) > 64 {
		result["truncated"] = true
		result["total_len"] = len(data)
	}

	// Parse first few bytes based on RMGR type
	switch rmgrid {
	case 0: // XLOG - typically contains XLogRecData structures
		if len(data) >= 8 {
			result["next_len"] = readLE32(data[0:4])
			result["block_id"] = data[4]
		}
	case 2: // Heap
		if len(data) >= 24 {
			result["block_rnode"] = readLE32(data[0:4])
			result["block_forknum"] = readLE32(data[4:8])
			result["block_num"] = readLE32(data[8:12])
			result["page_offset"] = uint16(data[12]) | uint16(data[13])<<8
		}
	}

	return result
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
