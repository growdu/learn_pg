package ws

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNewHub(t *testing.T) {
	hub := NewHub()
	if hub == nil {
		t.Fatal("NewHub returned nil")
	}
	if hub.clients == nil {
		t.Error("clients map is nil")
	}
	if hub.broadcast == nil {
		t.Error("broadcast channel is nil")
	}
	if hub.register == nil {
		t.Error("register channel is nil")
	}
	if hub.unregister == nil {
		t.Error("unregister channel is nil")
	}
}

func TestHubClientCount(t *testing.T) {
	hub := NewHub()
	count := hub.ClientCount()
	if count != 0 {
		t.Errorf("ClientCount() = %d, want 0", count)
	}
}

func TestHubBroadcast(t *testing.T) {
	hub := NewHub()
	testMsg := map[string]string{"type": "test", "message": "hello"}
	hub.Broadcast(testMsg)

	select {
	case msg := <-hub.broadcast:
		var got map[string]string
		if err := json.Unmarshal(msg, &got); err != nil {
			t.Errorf("Failed to unmarshal: %v", err)
		}
		if got["type"] != "test" {
			t.Errorf("msg type = %q, want test", got["type"])
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("timeout waiting for broadcast message")
	}
}

func TestHubBroadcastStruct(t *testing.T) {
	hub := NewHub()

	type Event struct {
		Type      string `json:"type"`
		Timestamp int64  `json:"timestamp"`
		Payload   string `json:"payload"`
	}

	event := Event{
		Type:      "wal_insert",
		Timestamp: time.Now().Unix(),
		Payload:   "test data",
	}
	hub.Broadcast(event)

	select {
	case msg := <-hub.broadcast:
		var got Event
		if err := json.Unmarshal(msg, &got); err != nil {
			t.Errorf("Failed to unmarshal: %v", err)
		}
		if got.Type != "wal_insert" {
			t.Errorf("Type = %q, want wal_insert", got.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("timeout waiting for broadcast message")
	}
}

func TestHubBroadcastMultipleMessages(t *testing.T) {
	hub := NewHub()

	for i := 0; i < 5; i++ {
		hub.Broadcast(map[string]int{"seq": i})
	}

	for i := 0; i < 5; i++ {
		select {
		case msg := <-hub.broadcast:
			var got map[string]int
			if err := json.Unmarshal(msg, &got); err != nil {
				t.Errorf("Failed to unmarshal: %v", err)
			}
			if got["seq"] != i {
				t.Errorf("seq = %d, want %d", got["seq"], i)
			}
		case <-time.After(100 * time.Millisecond):
			t.Errorf("timeout waiting for message %d", i)
		}
	}
}