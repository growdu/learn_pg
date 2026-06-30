package clog

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- resolveStatusDir ----------

// pg_xact wins when both exist — it is the post-PG-10 canonical name
// and should be preferred so callers see up-to-date status.
func TestResolveStatusDir_PrefersPgXactOverPgClog(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "pg_xact"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(tmp, "pg_clog"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := resolveStatusDir(tmp)
	if got != filepath.Join(tmp, "pg_xact") {
		t.Errorf("got %q, want pg_xact preferred", got)
	}
}

func TestResolveStatusDir_FallsBackToPgClog(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "pg_clog"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := resolveStatusDir(tmp)
	if got != filepath.Join(tmp, "pg_clog") {
		t.Errorf("got %q, want pg_clog fallback", got)
	}
}

// When neither exists, callers still need a deterministic default so
// downstream os.Open errors are traceable to a real path.
func TestResolveStatusDir_NeitherExistsDefaultsToPgXact(t *testing.T) {
	got := resolveStatusDir("/no/such/dir")
	if !strings.HasSuffix(got, "pg_xact") {
		t.Errorf("got %q, want default pg_xact suffix", got)
	}
}

// ---------- ReadPage / readPage ----------

// Real PG segment naming is `<seg>` (4-digit hex segment index), with
// each segment being 32 pages × 8KB = 256KB on disk. Verify we read the
// right page at the right offset within that segment.
func TestReadPageFromSegment(t *testing.T) {
	tmp := t.TempDir()
	xactDir := filepath.Join(tmp, "pg_xact")
	if err := os.MkdirAll(xactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// One segment file with 32 pages. Mark each page with its index
	// as a repeated byte so we can verify offset decoding.
	segData := make([]byte, PagesPerSegment*PageSize)
	for p := 0; p < PagesPerSegment; p++ {
		off := p * PageSize
		// 0xAA = 10 10 10 10 — all 4 two-bit slots = aborted (0b10).
		// Pages are otherwise distinguishable only by index, but we
		// don't care about cross-page decoding here — only that the
		// page we asked for decodes to the status we expect.
		for j := 0; j < PageSize; j++ {
			segData[off+j] = 0xAA
		}
	}
	if err := os.WriteFile(filepath.Join(xactDir, "0000"), segData, 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewCLOGReader(tmp)
	page, err := r.ReadPage(filepath.Join(xactDir, "0000"), 2)
	if err != nil {
		t.Fatalf("ReadPage error: %v", err)
	}
	if page.PageNum != 2 {
		t.Errorf("PageNum=%d, want 2", page.PageNum)
	}
	if page.StartXid != uint32(2)*TransactionsPerPage {
		t.Errorf("StartXid=%d, want %d", page.StartXid, uint32(2)*TransactionsPerPage)
	}
	// Page 2 was filled with 0xAA = 10101010 = all 4 slots aborted.
	for _, tx := range page.Transactions {
		if tx.Status != StatusAborted {
			t.Errorf("tx %d status=%d, want aborted(%d)", tx.Xid, tx.Status, StatusAborted)
			break
		}
	}
}

// TestReadPageIncompletePageIsError checks that a segment file whose
// trailing page is shorter than PageSize (truncated mid-write or
// partially corrupted) is rejected instead of silently returning
// zero-filled data.
func TestReadPageIncompletePageIsError(t *testing.T) {
	tmp := t.TempDir()
	xactDir := filepath.Join(tmp, "pg_xact")
	if err := os.MkdirAll(xactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 1.5 pages: page 0 is complete, page 1 is missing its last 4KB.
	data := make([]byte, PageSize+PageSize/2)
	if err := os.WriteFile(filepath.Join(xactDir, "0000"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewCLOGReader(tmp)
	if _, err := r.ReadPage(filepath.Join(xactDir, "0000"), 1); err == nil {
		t.Fatal("ReadPage of truncated page should return error")
	}
}

func TestReadPageMissingFileIsError(t *testing.T) {
	r := NewCLOGReader(t.TempDir())
	if _, err := r.ReadPage("/definitely/not/a/real/path", 0); err == nil {
		t.Fatal("ReadPage on missing file should return error")
	}
}

// ---------- ReadRange ----------

// ReadRange must gracefully skip segments that don't exist (fresh DBs
// won't have every segment on disk yet) rather than returning partial
// results or errors.
func TestReadRangeSkipsMissingSegments(t *testing.T) {
	tmp := t.TempDir()
	xactDir := filepath.Join(tmp, "pg_xact")
	if err := os.MkdirAll(xactDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Only write segment 0 page 0 (all zeros = in-progress).
	data := make([]byte, PageSize)
	if err := os.WriteFile(filepath.Join(xactDir, "0000"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewCLOGReader(tmp)
	// Ask for an XID range entirely outside the on-disk segment.
	res, err := r.ReadRange(TransactionsPerSegment, TransactionsPerSegment+10)
	if err != nil {
		t.Fatalf("ReadRange error: %v", err)
	}
	if len(res) != 0 {
		t.Errorf("ReadRange returned %d results for non-existent segment, want 0", len(res))
	}
}

// ---------- SubtransReader.GetParent ----------

func TestSubtransGetParentReadsCorrectOffset(t *testing.T) {
	tmp := t.TempDir()
	subDir := filepath.Join(tmp, "pg_subtrans")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Page size matches CLOG layout: 8192 entries × 4 bytes = 32KB.
	const pageSize = 8192
	data := make([]byte, pageSize*4)
	// Place parent XIDs at well-known offsets: 0xDEADBEEF at slot 0,
	// 0xCAFEBABE at slot 5.
	binary.LittleEndian.PutUint32(data[0:], 0xDEADBEEF)
	binary.LittleEndian.PutUint32(data[5*4:], 0xCAFEBABE)
	if err := os.WriteFile(filepath.Join(subDir, "0000"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewSubtransReader(tmp)
	if got, err := r.GetParent(0); err != nil || got != 0xDEADBEEF {
		t.Errorf("GetParent(0)=0x%x err=%v, want 0xDEADBEEF", got, err)
	}
	if got, err := r.GetParent(5); err != nil || got != 0xCAFEBABE {
		t.Errorf("GetParent(5)=0x%x err=%v, want 0xCAFEBABE", got, err)
	}
}

func TestSubtransGetParentMissingFile(t *testing.T) {
	r := NewSubtransReader(t.TempDir())
	if _, err := r.GetParent(1); err == nil {
		t.Fatal("GetParent with missing file should return error")
	}
}