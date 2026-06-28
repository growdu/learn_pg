package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

const (
	// encPrefix marks a stored password as encrypted on disk.
	// The "v1" suffix lets us rotate the format later without breaking
	// existing files — a v2 implementation would just look for "enc:v2:".
	encPrefix = "enc:v1:"
	// keyLen is the required key size in bytes (AES-256).
	keyLen = 32
	// nonceLen is the AES-GCM standard nonce size in bytes.
	nonceLen = 12
)

// ErrEncryptionKeyInvalid is returned when the key is missing or the wrong size.
var ErrEncryptionKeyInvalid = errors.New("encryption key must be 32 bytes (hex-encoded)")

// parseEncryptionKey decodes a 32-byte key from base64 or hex. If raw is
// empty, returns (nil, nil) to signal "no encryption configured" — callers
// should treat this as "use plain text mode" and log a warning.
func parseEncryptionKey(raw string) ([]byte, error) {
	if raw == "" {
		return nil, nil
	}
	// Try base64 first; on any decode failure or wrong size, try hex.
	// Operators usually paste from `openssl rand -base64 32` or
	// `openssl rand -hex 32`, so we accept both.
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == keyLen {
		return b, nil
	}
	if hb, err := hexDecode(raw); err == nil && len(hb) == keyLen {
		return hb, nil
	}
	return nil, ErrEncryptionKeyInvalid
}
// hexDecode is a tiny helper that avoids importing encoding/hex for one call.
// We only need it for 32-byte keys; anything else is an error.
func hexDecode(s string) ([]byte, error) {
	if len(s) != keyLen*2 {
		return nil, errors.New("hex length must be 64")
	}
	out := make([]byte, keyLen)
	for i := 0; i < keyLen; i++ {
		hi, err := hexNibble(s[2*i])
		if err != nil {
			return nil, err
		}
		lo, err := hexNibble(s[2*i+1])
		if err != nil {
			return nil, err
		}
		out[i] = (hi << 4) | lo
	}
	return out, nil
}

func hexNibble(c byte) (byte, error) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', nil
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, nil
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, nil
	}
	return 0, errors.New("not hex")
}

// ResolveEncryptionKey decodes a configured key, returning a usable byte
// slice on success or nil on empty input. On parse error it returns the
// error so the caller can fail startup with a clear message — we'd rather
// refuse to boot with a malformed key than silently fall back to plain text.
func ResolveEncryptionKey(raw string) ([]byte, error) {
	return parseEncryptionKey(raw)
}

// encryptPassword returns an "enc:v1:<base64>" string or, if key is nil,
// the plain value unchanged. This lets the rest of the code be oblivious to
// whether encryption is enabled.
func encryptPassword(plain string, key []byte) (string, error) {
	if key == nil {
		return plain, nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, nonceLen)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, nonce, []byte(plain), nil)
	buf := make([]byte, 0, len(nonce)+len(ct))
	buf = append(buf, nonce...)
	buf = append(buf, ct...)
	return encPrefix + base64.StdEncoding.EncodeToString(buf), nil
}

// decryptPassword returns the plain value. If the stored value is not
// encrypted (legacy or key disabled) and the key is set, the plain value is
// returned unchanged so the caller can decide whether to re-encrypt on write.
// If the value is encrypted but the key is nil, returns an error.
func decryptPassword(stored string, key []byte) (string, error) {
	if !strings.HasPrefix(stored, encPrefix) {
		if key == nil {
			return stored, nil
		}
		// Plain text under a configured key: caller will re-encrypt on next write.
		return stored, nil
	}
	if key == nil {
		return "", errors.New("stored password is encrypted but WORKSPACE_ENCRYPTION_KEY is not set")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, encPrefix))
	if err != nil {
		return "", err
	}
	if len(raw) < nonceLen {
		return "", errors.New("ciphertext too short")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, raw[:nonceLen], raw[nonceLen:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// isEncrypted reports whether a stored password is in encrypted form.
func isEncrypted(stored string) bool {
	return strings.HasPrefix(stored, encPrefix)
}
