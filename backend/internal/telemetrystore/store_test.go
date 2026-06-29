package telemetrystore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// withClock sets nowFn to return t for the duration of the test.
func withClock(t *testing.T, ts time.Time) {
	t.Helper()
	orig := nowFn
	nowFn = func() time.Time { return ts }
	t.Cleanup(func() { nowFn = orig })
}

func TestRecord_NewAndDedup(t *testing.T) {
	withClock(t, time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	s := New("")

	in := RecordInput{
		EventID:   "e1",
		Timestamp: time.Date(2026, 1, 1, 12, 0, 1, 0, time.UTC),
		Level:     "error",
		Message:   "boom",
		URL:       "http://x/",
		UserAgent: "ua/1",
		Stack:     "Error: boom\n  at foo",
	}
	h1 := s.Record(in)
	if h1 == "" {
		t.Fatal("expected non-empty hash")
	}
	if s.Len() != 1 {
		t.Fatalf("Len after first record: want 1, got %d", s.Len())
	}

	// Same payload → same hash, deduped
	h2 := s.Record(in)
	if h2 != h1 {
		t.Fatalf("dedup hash mismatch: %s vs %s", h1, h2)
	}
	if s.Len() != 1 {
		t.Fatalf("Len after dedup: want 1, got %d", s.Len())
	}
	top := s.Top(0)
	if len(top) != 1 {
		t.Fatalf("Top: want 1 entry, got %d", len(top))
	}
	if top[0].Count != 2 {
		t.Fatalf("Count: want 2, got %d", top[0].Count)
	}
}

func TestRecord_DifferentMessageDifferentHash(t *testing.T) {
	withClock(t, time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	s := New("")
	a := s.Record(RecordInput{Message: "boom", Stack: "x", URL: "u"})
	b := s.Record(RecordInput{Message: "different", Stack: "x", URL: "u"})
	if a == b {
		t.Fatalf("expected distinct hashes for distinct messages")
	}
	if s.Len() != 2 {
		t.Fatalf("Len: want 2, got %d", s.Len())
	}
}

func TestRecord_DedupUpdatesLastSeen(t *testing.T) {
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	withClock(t, base)
	s := New("")
	in := RecordInput{Message: "boom", Stack: "s", URL: "u", EventID: "e1"}
	s.Record(in)
	nowFn = func() time.Time { return base.Add(time.Hour) }
	s.Record(in)
	top := s.Top(0)
	if got := top[0].LastSeen; !got.Equal(base.Add(time.Hour)) {
		t.Fatalf("LastSeen: want %v, got %v", base.Add(time.Hour), got)
	}
	if top[0].FirstSeen != base {
		t.Fatalf("FirstSeen should be the original time, got %v", top[0].FirstSeen)
	}
}

func TestTop_OrderingByLastSeen(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	withClock(t, t0)
	s := New("")
	s.Record(RecordInput{Message: "old", Stack: "s", URL: "u1"})

	nowFn = func() time.Time { return t0.Add(time.Minute) }
	s.Record(RecordInput{Message: "newer", Stack: "s", URL: "u2"})

	nowFn = func() time.Time { return t0.Add(time.Hour) }
	s.Record(RecordInput{Message: "newest", Stack: "s", URL: "u3"})

	top := s.Top(0)
	if len(top) != 3 {
		t.Fatalf("Top: want 3, got %d", len(top))
	}
	if top[0].Message != "newest" || top[2].Message != "old" {
		t.Fatalf("ordering wrong: %s, %s, %s", top[0].Message, top[1].Message, top[2].Message)
	}
}

func TestTop_Limit(t *testing.T) {
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := New("")
	// 5 *distinct* events so dedup doesn't collapse them
	for i := 0; i < 5; i++ {
		nowFn = func() time.Time { return time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC) }
		s.Record(RecordInput{Message: "m", Stack: "s", URL: string(rune('a' + i))})
	}
	if got := s.Top(3); len(got) != 3 {
		t.Fatalf("Top(3): want 3, got %d", len(got))
	}
	if got := s.Top(0); len(got) != 5 {
		t.Fatalf("Top(0): want 5 (all), got %d", len(got))
	}
}

func TestClose_NoPath(t *testing.T) {
	s := New("")
	if err := s.Close(); err != nil {
		t.Fatalf("Close on memory-only store: %v", err)
	}
}

func TestPersistence_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")

	// First instance writes
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s1 := New(path)
	s1.Record(RecordInput{
		EventID: "e1", Message: "boom", Stack: "s", URL: "u",
		UserAgent: "ua/1", Level: "error",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC),
	})
	s1.Record(RecordInput{
		EventID: "e1", Message: "boom", Stack: "s", URL: "u",
		UserAgent: "ua/1", Level: "error",
		Timestamp: time.Date(2026, 1, 1, 0, 0, 2, 0, time.UTC),
	})
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// File must exist
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected store file after Close: %v", err)
	}

	// Second instance loads and sees the merged event
	nowFn = func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) }
	s2 := New(path)
	defer s2.Close()
	if s2.Len() != 1 {
		t.Fatalf("after reload: want 1 distinct event, got %d", s2.Len())
	}
	top := s2.Top(0)
	if top[0].Count != 2 {
		t.Fatalf("after reload: want count=2, got %d", top[0].Count)
	}
	if top[0].Message != "boom" || top[0].URL != "u" {
		t.Fatalf("after reload: payload corrupted: %+v", top[0])
	}
}

func TestPersistence_CorruptFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := New(path)
	defer s.Close()
	if s.Len() != 0 {
		t.Fatalf("corrupt file should yield empty store, got %d", s.Len())
	}
	// And we should still be able to record and write
	s.Record(RecordInput{Message: "after-corrupt", Stack: "s", URL: "u"})
	if err := s.Close(); err != nil {
		t.Fatalf("Close after corrupt-load: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var pf persistedFile
	if err := json.Unmarshal(b, &pf); err != nil {
		t.Fatalf("store should now contain valid JSON, got: %v\n%s", err, b)
	}
	if len(pf.Events) != 1 {
		t.Fatalf("want 1 event after re-record, got %d", len(pf.Events))
	}
}

func TestPersistence_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := New(path)
	s.Record(RecordInput{Message: "x", Stack: "s", URL: "u"})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	// No leftover .tmp
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("expected no leftover .tmp file, got err=%v", err)
	}
}

func TestRecord_ConcurrentSafe(t *testing.T) {
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := New("")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				s.Record(RecordInput{Message: "m", Stack: "s", URL: "u"})
			}
		}()
	}
	wg.Wait()
	top := s.Top(0)
	if len(top) != 1 {
		t.Fatalf("want 1 distinct event, got %d", len(top))
	}
	if top[0].Count != 50*20 {
		t.Fatalf("want count=%d, got %d", 50*20, top[0].Count)
	}
}

func TestHashEvent_StableIgnoresLevelAndUA(t *testing.T) {
	a := hashEvent("boom", "stack", "url")
	b := hashEvent("boom", "stack", "url")
	if a != b {
		t.Fatalf("hash should be stable: %s vs %s", a, b)
	}
	if len(a) != 16 {
		t.Fatalf("hash should be 16 chars (truncated sha256), got %d", len(a))
	}
}

// ─────────────────────────────────────────────
// TopSince, PurgeBefore, MaxEvents cap, retention on startup
// ─────────────────────────────────────────────

func TestTopSince_FiltersByLastSeen(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	withClock(t, t0)
	s := New("")
	s.Record(RecordInput{Message: "old", Stack: "s", URL: "u1"})

	nowFn = func() time.Time { return t0.Add(time.Hour) }
	s.Record(RecordInput{Message: "new", Stack: "s", URL: "u2"})

	top := s.TopSince(0, t0.Add(30*time.Minute))
	if len(top) != 1 {
		t.Fatalf("TopSince since=+30m: want 1, got %d", len(top))
	}
	if top[0].Message != "new" {
		t.Errorf("expected 'new', got %q", top[0].Message)
	}

	// Zero since → no filter → both
	all := s.TopSince(0, time.Time{})
	if len(all) != 2 {
		t.Errorf("TopSince zero since: want 2, got %d", len(all))
	}
}

func TestTopSince_LimitAppliedAfterFilter(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	withClock(t, t0)
	s := New("")
	// 3 in window, 2 before
	for _, off := range []time.Duration{-2 * time.Hour, -time.Hour, 0, time.Minute, 2 * time.Minute} {
		nowFn = func() time.Time { return t0.Add(off) }
		s.Record(RecordInput{Message: "m-" + off.String(), Stack: "s", URL: "u"})
	}
	out := s.TopSince(2, t0)
	if len(out) != 2 {
		t.Fatalf("TopSince(2, since=t0): want 2, got %d", len(out))
	}
	// Most-recent first
	if out[0].Message != "m-2m0s" {
		t.Errorf("first should be most recent, got %q", out[0].Message)
	}
}

func TestPurgeBefore_RemovesOld(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	withClock(t, t0)
	s := New("")
	s.Record(RecordInput{Message: "old", Stack: "s", URL: "u"})
	nowFn = func() time.Time { return t0.Add(time.Hour) }
	s.Record(RecordInput{Message: "new", Stack: "s", URL: "u"})

	removed := s.PurgeBefore(t0.Add(30 * time.Minute))
	if removed != 1 {
		t.Fatalf("PurgeBefore: want 1 removed, got %d", removed)
	}
	if s.Len() != 1 {
		t.Fatalf("after purge: want 1 event, got %d", s.Len())
	}
	top := s.Top(0)
	if top[0].Message != "new" {
		t.Errorf("expected 'new' to survive, got %q", top[0].Message)
	}
}

func TestMaxEvents_EvictsOldest(t *testing.T) {
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	withClock(t, t0)
	s := NewWithOptions(Options{MaxEvents: 3})

	// 5 distinct events over time
	for i := 0; i < 5; i++ {
		nowFn = func() time.Time { return t0.Add(time.Duration(i) * time.Minute) }
		s.Record(RecordInput{
			Message: string(rune('a' + i)),
			Stack:   "s",
			URL:     string(rune('A' + i)), // distinct URL → distinct hash
		})
	}
	if s.Len() != 3 {
		t.Fatalf("after cap: want 3 events, got %d", s.Len())
	}
	top := s.Top(0)
	// Two oldest (a, b) should be evicted; c, d, e survive.
	messages := []string{top[0].Message, top[1].Message, top[2].Message}
	want := []string{"e", "d", "c"}
	for i := range want {
		if messages[i] != want[i] {
			t.Errorf("order[%d]: want %q, got %q", i, want[i], messages[i])
		}
	}
}

func TestMaxEvents_NewEventSurvivesEvenAtCapOne(t *testing.T) {
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := NewWithOptions(Options{MaxEvents: 1})
	s.Record(RecordInput{Message: "first", Stack: "s", URL: "u"})
	nowFn = func() time.Time { return time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC) }
	s.Record(RecordInput{Message: "second", Stack: "s", URL: "u2"}) // distinct
	if s.Len() != 1 {
		t.Fatalf("cap=1: want 1 event, got %d", s.Len())
	}
	top := s.Top(0)
	if top[0].Message != "second" {
		t.Errorf("newest should survive, got %q", top[0].Message)
	}
}

func TestRetention_AppliesOnStartup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	// Pre-seed with one old + one recent event
	nowFn = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	s1 := NewWithOptions(Options{Path: path, Retention: 24 * time.Hour})
	s1.Record(RecordInput{Message: "old", Stack: "s", URL: "u1"})
	// Move clock forward 48h and record another
	nowFn = func() time.Time { return time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC) }
	s1.Record(RecordInput{Message: "recent", Stack: "s", URL: "u2"})
	s1.Close()

	// Reopen with the same retention — "old" should be purged at load
	nowFn = func() time.Time { return time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC) }
	s2 := NewWithOptions(Options{Path: path, Retention: 24 * time.Hour})
	defer s2.Close()
	if s2.Len() != 1 {
		t.Fatalf("after startup purge: want 1 event, got %d", s2.Len())
	}
	top := s2.Top(0)
	if top[0].Message != "recent" {
		t.Errorf("expected 'recent' to survive startup purge, got %q", top[0].Message)
	}
}

func TestNew_NoPathStillRespectsOptions(t *testing.T) {
	// Memory-only store can also have a cap
	withClock(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	s := NewWithOptions(Options{MaxEvents: 2})
	for i := 0; i < 5; i++ {
		nowFn = func() time.Time { return time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC) }
		s.Record(RecordInput{Message: string(rune('a' + i)), Stack: "s", URL: string(rune('u' + i))})
	}
	if s.Len() != 2 {
		t.Fatalf("memory cap=2: want 2, got %d", s.Len())
	}
}

func TestNew_PathDefaultRetentionIsSevenDays(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	nowFn = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	s := New(path) // no explicit retention → default 7d
	s.Record(RecordInput{Message: "x", Stack: "s", URL: "u"})
	// 8 days later, still inside retention because LastSeen is just set
	nowFn = func() time.Time { return time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC) }
	s2 := New(path)
	defer s2.Close()
	// startup purge should drop the 8-day-old event
	if s2.Len() != 0 {
		t.Errorf("default 7d retention should have purged the 8-day-old event, got len=%d", s2.Len())
	}
}
