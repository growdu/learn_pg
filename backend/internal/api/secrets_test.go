package api

import (
	"strings"
	"testing"
)

func TestParseEncryptionKey(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
		wantNil bool
	}{
		{"empty", "", false, true},
		{"valid base64 32 bytes", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", false, false},
		{"valid hex 32 bytes", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", false, false},
		{"invalid base64 chars", "@@@not-base64@@@", true, false},
		{"odd hex length", "abc", true, false},
		{"valid base64 wrong size", "AA==", true, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseEncryptionKey(tc.input)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tc.wantErr)
			}
			if tc.wantNil && got != nil {
				t.Fatalf("expected nil key, got %d bytes", len(got))
			}
			if !tc.wantNil && !tc.wantErr && len(got) != keyLen {
				t.Fatalf("expected %d bytes, got %d", keyLen, len(got))
			}
		})
	}
}

func TestEncryptDecryptRoundtrip(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef") // 32 bytes
	plain := "super-secret-pa$$w0rd!"

	ct, err := encryptPassword(plain, key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !isEncrypted(ct) {
		t.Fatalf("expected encrypted marker, got %q", ct)
	}
	if strings.Contains(ct, plain) {
		t.Fatal("plaintext leaked into ciphertext")
	}

	got, err := decryptPassword(ct, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != plain {
		t.Fatalf("roundtrip mismatch: got %q, want %q", got, plain)
	}
}

func TestDecryptPlainWithKey(t *testing.T) {
	// Legacy plain value should pass through unchanged so the caller can
	// re-encrypt on next write.
	key := []byte("0123456789abcdef0123456789abcdef")
	plain := "legacy-plain"
	got, err := decryptPassword(plain, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != plain {
		t.Fatalf("expected passthrough, got %q", got)
	}
}

func TestDecryptEncryptedWithoutKey(t *testing.T) {
	// Encrypted value with no key configured should fail loudly.
	ct, _ := encryptPassword("x", []byte("0123456789abcdef0123456789abcdef"))
	if _, err := decryptPassword(ct, nil); err == nil {
		t.Fatal("expected error when decrypting without key")
	}
}

func TestEncryptWithoutKeyIsPassthrough(t *testing.T) {
	// When no key is configured, encrypt is a no-op (returns plain).
	got, err := encryptPassword("hello", nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if got != "hello" {
		t.Fatalf("expected passthrough, got %q", got)
	}
}

func TestDecryptWrongKeyFails(t *testing.T) {
	key1 := []byte("0123456789abcdef0123456789abcdef")
	key2 := []byte("fedcba9876543210fedcba9876543210")

	ct, _ := encryptPassword("secret", key1)
	if _, err := decryptPassword(ct, key2); err == nil {
		t.Fatal("expected error decrypting with wrong key")
	}
}
