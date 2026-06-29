// Package telemetrystore is a small file-backed store for client-side
// error reports. It deduplicates by a content hash so a single bug
// firing thousands of times counts as one entry with count=N.
//
// The on-disk format is a single JSON document holding a map keyed by
// hash. On startup the store loads from disk (best-effort — a corrupt
// or missing file just means an empty store). Writes are buffered in
// memory and flushed atomically every FlushInterval or on Close.
//
// This is intentionally simple: a busy production system would route
// telemetry into a real observability backend. learn_pg is a single-
// binary Web MVP and a JSON-on-disk store keeps zero new dependencies
// while surviving restarts.
package telemetrystore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Event is the persisted view of a single client-side error.
type Event struct {
	Hash          string    `json:"hash"`
	Message       string    `json:"message"`
	Level         string    `json:"level"`
	URL           string    `json:"url"`
	UserAgent     string    `json:"userAgent"`
	Stack         string    `json:"stack"`
	Count         int64     `json:"count"`
	FirstSeen     time.Time `json:"firstSeen"`
	LastSeen      time.Time `json:"lastSeen"`
	LastEventID   string    `json:"lastEventId"`
	LastTimestamp time.Time `json:"lastTimestamp"`
}

// Options configures a Store. Zero values mean "use defaults".
type Options struct {
	// Path is the on-disk JSON file. Empty disables persistence
	// (in-memory only, no flush goroutine).
	Path string

	// Retention is the maximum age of an event by LastSeen. Events
	// older than this are purged during periodic flushes. Zero
	// disables purging. Default when persistence is enabled: 7 days.
	Retention time.Duration

	// MaxEvents caps the number of distinct events. When exceeded,
	// the oldest (by LastSeen) event is evicted on each new Record.
	// Zero disables the cap. Default when persistence is enabled:
	// 10000.
	MaxEvents int

	// FlushInterval controls how often the store is written to disk.
	// Zero means 30 seconds.
	FlushInterval time.Duration
}

// Store is safe for concurrent use.
type Store struct {
	mu     sync.RWMutex
	path   string
	events map[string]*Event // keyed by Hash

	retention      time.Duration
	maxEvents      int
	flushInterval  time.Duration
	stopCh         chan struct{}
	wg             sync.WaitGroup
}

// New is shorthand for NewWithOptions(Options{Path: path}).
func New(path string) *Store {
	return NewWithOptions(Options{Path: path})
}

// NewWithOptions creates a store with full configuration. When Path
// is empty the store runs in memory only and the flush goroutine is
// not started.
func NewWithOptions(opts Options) *Store {
	s := &Store{
		path:   opts.Path,
		events: make(map[string]*Event),
	}
	if opts.FlushInterval > 0 {
		s.flushInterval = opts.FlushInterval
	} else {
		s.flushInterval = 30 * time.Second
	}
	// Defaults apply to *every* store, not just persisted ones, so
	// memory-only callers can still bound their footprint.
	s.retention = opts.Retention
	s.maxEvents = opts.MaxEvents
	if opts.Path != "" {
		if s.retention == 0 {
			s.retention = 7 * 24 * time.Hour
		}
		if s.maxEvents == 0 {
			s.maxEvents = 10000
		}
		_ = s.load()
		// Drop anything already past retention at startup.
		s.purgeBeforeLocked(nowFn().Add(-s.retention))
		s.enforceCapLocked()

		s.stopCh = make(chan struct{})
		s.wg.Add(1)
		go s.flusher(s.stopCh)
	}
	return s
}

// Close stops the flush goroutine and writes the current state to
// disk. Safe to call multiple times and on a nil-store / no-path
// store.
func (s *Store) Close() error {
	if s == nil || s.path == "" {
		return nil
	}
	s.mu.Lock()
	if s.stopCh == nil {
		s.mu.Unlock()
		return nil
	}
	close(s.stopCh)
	s.stopCh = nil
	s.mu.Unlock()
	s.wg.Wait()
	return s.flush()
}

// RecordInput is the minimal payload needed to deduplicate an event.
type RecordInput struct {
	EventID   string
	Timestamp time.Time
	Level     string
	Message   string
	URL       string
	UserAgent string
	Stack     string
}

// Record stores or merges an event. Returns the hash so callers can
// log it alongside the input.
func (s *Store) Record(in RecordInput) string {
	h := hashEvent(in.Message, in.Stack, in.URL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.events[h]; ok {
		e.Count++
		e.LastSeen = nowFn()
		e.LastEventID = in.EventID
		e.LastTimestamp = in.Timestamp
		// Refresh mutable context — last user agent / level might
		// change if the client upgraded.
		e.Level = orDefault(in.Level, e.Level)
		e.UserAgent = orDefault(in.UserAgent, e.UserAgent)
		return h
	}
	s.events[h] = &Event{
		Hash:          h,
		Message:       in.Message,
		Level:         in.Level,
		URL:           in.URL,
		UserAgent:     in.UserAgent,
		Stack:         in.Stack,
		Count:         1,
		FirstSeen:     nowFn(),
		LastSeen:      nowFn(),
		LastEventID:   in.EventID,
		LastTimestamp: in.Timestamp,
	}
	// Enforce the cap *after* insertion so the new event survives
	// even when MaxEvents == 1.
	s.enforceCapLocked()
	return h
}

// Top returns up to limit events ordered by LastSeen descending. If
// limit <= 0 all events are returned.
func (s *Store) Top(limit int) []*Event {
	return s.TopSince(limit, time.Time{})
}

// TopSince returns up to limit events with LastSeen >= since,
// ordered by LastSeen descending. A zero since means no filter.
// If limit <= 0 all matching events are returned.
func (s *Store) TopSince(limit int, since time.Time) []*Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Event, 0, len(s.events))
	for _, e := range s.events {
		if !since.IsZero() && e.LastSeen.Before(since) {
			continue
		}
		c := *e
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].LastSeen.After(out[j].LastSeen)
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// PurgeBefore removes every event whose LastSeen is strictly before
// cutoff. Returns the number of events removed. Intended to be
// called periodically from the flush goroutine.
func (s *Store) PurgeBefore(cutoff time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.purgeBeforeLocked(cutoff)
}

// purgeBeforeLocked is the lock-free caller version of PurgeBefore.
// It expects the caller to hold s.mu (write lock).
func (s *Store) purgeBeforeLocked(cutoff time.Time) int {
	removed := 0
	for h, e := range s.events {
		if e.LastSeen.Before(cutoff) {
			delete(s.events, h)
			removed++
		}
	}
	return removed
}

// enforceCapLocked evicts oldest-by-LastSeen events until the map
// size is at or below s.maxEvents. No-op when maxEvents <= 0.
func (s *Store) enforceCapLocked() {
	if s.maxEvents <= 0 || len(s.events) <= s.maxEvents {
		return
	}
	// Sort all events by LastSeen ascending and drop the head.
	all := make([]*Event, 0, len(s.events))
	for _, e := range s.events {
		all = append(all, e)
	}
	sort.Slice(all, func(i, j int) bool {
		return all[i].LastSeen.Before(all[j].LastSeen)
	})
	excess := len(all) - s.maxEvents
	for i := 0; i < excess; i++ {
		delete(s.events, all[i].Hash)
	}
}

// Len returns the number of distinct events currently stored.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.events)
}

// ────────────────────────── persistence ──────────────────────────

type persistedFile struct {
	Version int              `json:"version"`
	Events  map[string]*Event `json:"events"`
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("telemetrystore: read %s: %w", s.path, err)
	}
	var pf persistedFile
	if err := json.Unmarshal(b, &pf); err != nil {
		// Corrupt file: log via stderr, start empty. Don't fail
		// startup because telemetry persistence is non-critical.
		fmt.Fprintf(os.Stderr, "telemetrystore: ignoring corrupt store file %s: %v\n", s.path, err)
		return nil
	}
	if pf.Events != nil {
		s.events = pf.Events
	}
	return nil
}

func (s *Store) flush() error {
	if s.path == "" {
		return nil
	}
	s.mu.RLock()
	pf := persistedFile{Version: 1, Events: s.events}
	s.mu.RUnlock()
	b, err := json.MarshalIndent(pf, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) flusher(stop <-chan struct{}) {
	defer s.wg.Done()
	t := time.NewTicker(s.flushInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.maintain()
			if err := s.flush(); err != nil {
				fmt.Fprintf(os.Stderr, "telemetrystore: flush error: %v\n", err)
			}
		}
	}
}

// maintain applies purge + cap, no-op if neither is configured.
func (s *Store) maintain() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.retention > 0 {
		s.purgeBeforeLocked(nowFn().Add(-s.retention))
	}
	s.enforceCapLocked()
}

// ────────────────────────── helpers ──────────────────────────

// hashEvent produces a stable fingerprint of the (message, stack, url)
// tuple. Two reports with the same triple are considered the same bug.
// We deliberately exclude level / userAgent / eventId / timestamp so
// that minor client variation does not fragment counts.
func hashEvent(message, stack, url string) string {
	h := sha256.New()
	h.Write([]byte(url))
	h.Write([]byte{0})
	h.Write([]byte(message))
	h.Write([]byte{0})
	// stack can be very long; SHA's collision resistance makes
	// truncation safe but we keep full input — it costs ~µs.
	h.Write([]byte(stack))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func orDefault(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

// nowFn is overridable in tests.
var nowFn = func() time.Time { return time.Now().UTC() }