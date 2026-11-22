package annot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
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

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	fallback := filepath.Join(dir, "support")

	raw := payload(10, 2)
	path, err := Save(pdf, fallback, raw)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if want := AdjacentPath(pdf); path != want {
		t.Fatalf("sidecar path = %q, want %q", path, want)
	}

	res, err := Load(pdf, fallback)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if res.Data == "" {
		t.Fatal("expected sidecar data")
	}
	if !res.Portable {
		t.Fatal("expected portable sidecar")
	}
	if res.Warning != "" {
		t.Fatalf("unexpected warning: %s", res.Warning)
	}
}

func TestLoadMissingReturnsTarget(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)

	res, err := Load(pdf, filepath.Join(dir, "support"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Data != "" {
		t.Fatal("expected empty data")
	}
	if res.Path == "" || !res.Portable {
		t.Fatalf("unexpected target: %+v", res)
	}
	if res.Fingerprint == "" {
		t.Fatal("expected fingerprint")
	}
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

func TestBackupKept(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	fallback := filepath.Join(dir, "support")

	first := payload(3, 1)
	if _, err := Save(pdf, fallback, first); err != nil {
		t.Fatal(err)
	}
	second := payload(3, 2)
	path, err := Save(pdf, fallback, second)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("backup missing: %v", err)
	}
	if !bytes.Equal(backup, first) {
		t.Fatal("backup does not hold previous revision")
	}
}

func TestReadOnlyDirectoryFallsBack(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not enforced the same way on Windows")
	}
	if os.Getenv("USER") == "root" {
		t.Skip("running as root, permissions are not enforced")
	}
	dir := t.TempDir()
	pdfDir := filepath.Join(dir, "readonly")
	if err := os.Mkdir(pdfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pdf := writePDF(t, pdfDir)
	fallback := filepath.Join(dir, "support")

	if err := os.Chmod(pdfDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(pdfDir, 0o755) })

	path, err := Save(pdf, fallback, payload(2, 1))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if filepath.Dir(path) != filepath.Join(fallback, "notes") {
		t.Fatalf("expected central fallback, got %q", path)
	}

	res, err := Load(pdf, fallback)
	if err != nil {
		t.Fatal(err)
	}
	if res.Portable {
		t.Fatal("central sidecar should not be portable")
	}
	if res.Data == "" {
		t.Fatal("expected fallback data")
	}
}

func TestOriginalDocumentUntouched(t *testing.T) {
	dir := t.TempDir()
	pdf := writePDF(t, dir)
	before, err := os.ReadFile(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Save(pdf, filepath.Join(dir, "support"), payload(5, 1)); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("PDF was modified")
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
