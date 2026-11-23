package annot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePDF(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "book.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.7\nsample document\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func payload(pages int, rounds int) []byte {
	quads := make([]map[string]any, 0, rounds)
	for i := 0; i < rounds; i++ {
		quads = append(quads, map[string]any{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.02})
	}
	data := map[string]any{
		"schema": 1,
		"doc": map[string]any{
			"name": "book.pdf", "size": 24, "fingerprint": "fp", "pages": pages,
		},
		"reading": map[string]any{
			"lastPage": 3, "scrollRatio": 0.2, "zoom": 1.4,
			"viewMode": "continuous", "readPages": []int{1, 2, 3},
		},
		"annotations": []map[string]any{{
			"id": "a1", "type": "highlight", "page": 3, "color": "#ffd84d",
			"quads": quads, "text": "hello", "createdAt": "2026-01-01T00:00:00Z",
			"updatedAt": "2026-01-01T00:00:00Z",
		}},
	}
	raw, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	return raw
}

func TestValidate(t *testing.T) {
	if err := Validate(payload(3, 1)); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}

	cases := map[string][]byte{
		"bad json":      []byte("{oops"),
		"bad schema":    []byte(`{"schema":99,"doc":{},"reading":{},"annotations":[]}`),
		"bad type":      []byte(`{"schema":1,"doc":{},"reading":{},"annotations":[{"id":"x","type":"laser","page":1}]}`),
		"bad page":      []byte(`{"schema":1,"doc":{},"reading":{},"annotations":[{"id":"x","type":"ink","page":0}]}`),
		"trailing junk": []byte(`{"schema":1,"doc":{},"reading":{},"annotations":[]} extra`),
	}
	for name, raw := range cases {
		if err := Validate(raw); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestReadLegacyCentral(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	fp, err := legacyFingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(fp))
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	want := payload(4, 1)
	path := filepath.Join(notes, hex.EncodeToString(sum[:16])+".json")
	if err := os.WriteFile(path, want, 0o644); err != nil {
		t.Fatal(err)
	}
	raw, ok, err := ReadLegacyCentral(pdf, dir)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(raw, want) {
		t.Fatal("legacy sidecar mismatch")
	}
}

func TestFingerprintDetectsReplacement(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	fp1, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pdf, []byte("%PDF-1.7\ndifferent content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fp2, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if fp1 == fp2 {
		t.Fatal("fingerprint did not change")
	}
}

func TestFingerprintIgnoresMTime(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	fp1, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(48 * time.Hour)
	if err := os.Chtimes(pdf, later, later); err != nil {
		t.Fatal(err)
	}
	fp2, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if fp1 != fp2 {
		t.Fatalf("mtime change altered fingerprint: %q -> %q", fp1, fp2)
	}
}

func TestFingerprintStableForLargeFiles(t *testing.T) {
	dir := t.TempDir()
	pdf := filepath.Join(dir, "big.pdf")
	raw := bytes.Repeat([]byte("0123456789abcdef"), 200_000) // ~3 MiB
	if err := os.WriteFile(pdf, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	fp1, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	fp2, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if fp1 != fp2 {
		t.Fatal("fingerprint is not stable")
	}
	// Flip a byte in the middle: the sampled head/tail stays the same, which is
	// the documented trade-off for fast identification.
	raw[len(raw)/2] ^= 0xff
	if err := os.WriteFile(pdf, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	fp3, err := Fingerprint(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if fp3 != fp1 {
		t.Fatal("expected sampled fingerprint to ignore the middle byte")
	}
}
