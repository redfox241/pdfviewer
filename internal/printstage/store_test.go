package printstage

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func stage(t *testing.T, s *Store, body string) Job {
	t.Helper()
	job, err := s.Stage(strings.NewReader(body), "/tmp/book.pdf", "book.pdf", true)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	return job
}

func TestStageWritesPrivateFile(t *testing.T) {
	s := newStore(t)
	job := stage(t, s, "%PDF-1.4 test")

	info, err := os.Stat(job.Path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	raw, _ := os.ReadFile(job.Path)
	if string(raw) != "%PDF-1.4 test" {
		t.Fatalf("content = %q", raw)
	}
	if got := filepath.Base(job.Path); got != "book (标注).pdf" {
		t.Fatalf("staged name = %q", got)
	}
	got, ok := s.Get(job.ID)
	if !ok || got.Path != job.Path || !got.IncludeAnnotations {
		t.Fatalf("Get = %+v, %v", got, ok)
	}
}

func TestSaveToCopiesAndRemovesStagedFile(t *testing.T) {
	s := newStore(t)
	job := stage(t, s, "%PDF-1.4 bytes")
	target := filepath.Join(t.TempDir(), "out.pdf")

	if err := s.SaveTo(job.ID, target); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "%PDF-1.4 bytes" {
		t.Fatalf("target = %q, %v", raw, err)
	}
	if _, err := os.Stat(job.Path); !os.IsNotExist(err) {
		t.Fatalf("staged file still exists: %v", err)
	}
	if _, ok := s.Get(job.ID); ok {
		t.Fatal("job should be gone")
	}
}

func TestSaveToAddsPDFExtensionAndRejectsSourceOverwrite(t *testing.T) {
	s := newStore(t)
	job := stage(t, s, "%PDF-1.4 bytes")
	dir := t.TempDir()

	if err := s.SaveTo(job.ID, filepath.Join(dir, "out")); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out.pdf")); err != nil {
		t.Fatalf("missing .pdf target: %v", err)
	}

	job2 := stage(t, s, "%PDF-1.7 other")
	if err := s.SaveTo(job2.ID, job2.DocPath); err == nil {
		t.Fatal("expected refusal to overwrite the source PDF")
	}
}

func TestDiscardRemovesFile(t *testing.T) {
	s := newStore(t)
	job := stage(t, s, "%PDF-1.4")
	s.Discard(job.ID)
	if _, err := os.Stat(job.Path); !os.IsNotExist(err) {
		t.Fatalf("file still exists: %v", err)
	}
}

func TestExpiredTokenIsRejected(t *testing.T) {
	s := newStore(t)
	s.ttl = time.Millisecond
	job := stage(t, s, "%PDF-1.4")
	time.Sleep(5 * time.Millisecond)
	if _, ok := s.Get(job.ID); ok {
		t.Fatal("expected expired token to be rejected")
	}
	if _, err := os.Stat(job.Path); !os.IsNotExist(err) {
		t.Fatalf("expired file still exists: %v", err)
	}
}

func TestSweepRemovesStaleFiles(t *testing.T) {
	s := newStore(t)
	job := stage(t, s, "%PDF-1.4")
	stale := filepath.Join(s.Dir(), "print-untracked.pdf")
	if err := os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	// Age the tracked job past the sweep threshold.
	s.mu.Lock()
	j := s.jobs[job.ID]
	j.Created = old
	s.jobs[job.ID] = j
	s.mu.Unlock()

	s.Sweep()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale file still exists: %v", err)
	}
	if _, err := os.Stat(job.Path); !os.IsNotExist(err) {
		t.Fatalf("stale tracked file still exists: %v", err)
	}
}

func TestStageRejectsNonPDFContent(t *testing.T) {
	s := newStore(t)
	if _, err := s.Stage(strings.NewReader("not a pdf"), "/tmp/a.pdf", "a.pdf", false); err == nil {
		t.Fatal("expected non-PDF body to be rejected")
	}
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 0 {
		t.Fatalf("cache not empty: %v", entries)
	}
}

func TestClearAllRemovesTrackedAndUntrackedFiles(t *testing.T) {
	s := newStore(t)
	stage(t, s, "%PDF-1.4 one")
	stage(t, s, "%PDF-1.4 two")
	extra := filepath.Join(s.Dir(), "print-extra.pdf")
	if err := os.WriteFile(extra, []byte("%PDF-1.4"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearAll(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 0 {
		t.Fatalf("cache not empty after ClearAll: %v", entries)
	}
}

func TestStageCopiesLargeEnoughBody(t *testing.T) {
	s := newStore(t)
	body := append([]byte("%PDF-"), bytes.Repeat([]byte("0123456789"), 100000)...)
	job, err := s.Stage(bytes.NewReader(body), "/tmp/a.pdf", "a.pdf", false)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(job.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != int64(len(body)) {
		t.Fatalf("size = %d, want %d", info.Size(), len(body))
	}
}
