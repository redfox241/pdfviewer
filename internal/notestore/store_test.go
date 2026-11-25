package notestore

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"pdfviewer/internal/annot"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func ann(id string, page int) json.RawMessage {
	return json.RawMessage(`{"id":"` + id + `","type":"highlight","page":` + itoa(page) + `,"color":"#ffd84d","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}`)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func TestDocumentAndReadingRoundTrip(t *testing.T) {
	s := newTestStore(t)
	id, err := s.UpsertDocument("/tmp/a.pdf", "a.pdf", 1234, "1234:abc", 0)
	if err != nil {
		t.Fatal(err)
	}
	empty, err := s.IsEmpty(id)
	if err != nil || !empty {
		t.Fatalf("expected empty, got %v %v", empty, err)
	}

	st, err := s.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if st.HasData || st.Reading.LastPage != 1 || st.Reading.ViewMode != "continuous" {
		t.Fatalf("unexpected default state: %+v", st)
	}

	want := annot.Reading{
		LastPage: 12, ScrollRatio: 0.25, Zoom: 1.5,
		ViewMode: "continuous", ReadPages: []int{1, 2, 3},
	}
	if err := s.SaveReading(id, want, 315); err != nil {
		t.Fatal(err)
	}
	st, err = s.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if !st.HasData || st.Pages != 315 {
		t.Fatalf("state not persisted: %+v", st)
	}
	if st.Reading.LastPage != 12 || st.Reading.Zoom != 1.5 {
		t.Fatalf("reading mismatch: %+v", st.Reading)
	}
	if len(st.Reading.ReadPages) != 3 {
		t.Fatalf("readPages mismatch: %v", st.Reading.ReadPages)
	}

	// Moving the file must keep the same doc_id (content identity).
	id2, err := s.UpsertDocument("/tmp/moved.pdf", "moved.pdf", 1234, "1234:abc", 0)
	if err != nil {
		t.Fatal(err)
	}
	if id2 != id {
		t.Fatalf("doc_id changed on move: %d -> %d", id, id2)
	}
}

func TestAnnotationsReconcile(t *testing.T) {
	s := newTestStore(t)
	id, _ := s.UpsertDocument("/tmp/b.pdf", "b.pdf", 10, "10:x", 20)

	if err := s.SaveAnnotations(id, []json.RawMessage{ann("a", 1), ann("b", 2)}); err != nil {
		t.Fatal(err)
	}
	st, _ := s.Load(id)
	if len(st.Annotations) != 2 {
		t.Fatalf("want 2 annotations, got %d", len(st.Annotations))
	}

	// Update b, drop a, add c.
	updated := json.RawMessage(`{"id":"b","type":"note","page":2,"color":"#fff","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}`)
	if err := s.SaveAnnotations(id, []json.RawMessage{updated, ann("c", 3)}); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Load(id)
	if len(st.Annotations) != 2 {
		t.Fatalf("want 2 annotations after reconcile, got %d", len(st.Annotations))
	}
	var foundB, foundA bool
	for _, raw := range st.Annotations {
		var head struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &head)
		if head.ID == "b" {
			foundB = true
			if head.Type != "note" {
				t.Fatalf("b was not updated: %s", head.Type)
			}
		}
		if head.ID == "a" {
			foundA = true
		}
	}
	if !foundB || foundA {
		t.Fatalf("reconcile wrong: b=%v a=%v", foundB, foundA)
	}

	// Empty list deletes everything for this document.
	if err := s.SaveAnnotations(id, nil); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Load(id)
	if len(st.Annotations) != 0 {
		t.Fatalf("expected no annotations, got %d", len(st.Annotations))
	}
}

func TestImportSnapshot(t *testing.T) {
	s := newTestStore(t)
	id, _ := s.UpsertDocument("/tmp/c.pdf", "c.pdf", 30, "30:z", 0)
	data := annot.Data{
		Schema: 1,
		Doc:    annot.Doc{Name: "c.pdf", Size: 30, Fingerprint: "30:z", Pages: 9},
		Reading: annot.Reading{
			LastPage: 4, ScrollRatio: 0.1, Zoom: 1, ViewMode: "continuous",
			ReadPages: []int{1, 4},
		},
		Annotations: []json.RawMessage{ann("x", 4)},
	}
	if err := s.Import(id, data); err != nil {
		t.Fatal(err)
	}
	st, _ := s.Load(id)
	if st.Pages != 9 || st.Reading.LastPage != 4 || len(st.Annotations) != 1 {
		t.Fatalf("import mismatch: %+v", st)
	}
}

func TestPath(t *testing.T) {
	s := newTestStore(t)
	if filepath.Base(s.Path()) != "library.db" {
		t.Fatalf("unexpected path: %s", s.Path())
	}
}

func TestAnnotationsAreScopedToDocument(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.UpsertDocument("/tmp/a.pdf", "a.pdf", 10, "10:a", 1)
	b, _ := s.UpsertDocument("/tmp/b.pdf", "b.pdf", 20, "20:b", 1)

	if err := s.SaveAnnotations(a, []json.RawMessage{ann("same", 1)}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveAnnotations(b, []json.RawMessage{ann("same", 1)}); err != nil {
		t.Fatal(err)
	}

	sa, err := s.Load(a)
	if err != nil {
		t.Fatal(err)
	}
	sb, err := s.Load(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(sa.Annotations) != 1 || len(sb.Annotations) != 1 {
		t.Fatalf("annotations moved across documents: a=%d b=%d", len(sa.Annotations), len(sb.Annotations))
	}
}

func TestMigrateV1Annotations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`CREATE TABLE documents (
			doc_id INTEGER PRIMARY KEY, content_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
			name TEXT NOT NULL, size INTEGER NOT NULL, pages INTEGER NOT NULL DEFAULT 0,
			last_opened INTEGER NOT NULL)`,
		`CREATE TABLE reading (
			doc_id INTEGER PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
			last_page INTEGER NOT NULL DEFAULT 1, scroll_ratio REAL NOT NULL DEFAULT 0,
			zoom REAL NOT NULL DEFAULT 0, view_mode TEXT NOT NULL DEFAULT 'continuous',
			updated_at TEXT NOT NULL DEFAULT '')`,
		`CREATE TABLE read_pages (
			doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
			page INTEGER NOT NULL, PRIMARY KEY(doc_id, page))`,
		`CREATE TABLE annotations (
			id TEXT PRIMARY KEY,
			doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
			page INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`,
		`CREATE INDEX idx_annotations_doc_page ON annotations(doc_id, page)`,
		`CREATE INDEX idx_annotations_doc_id ON annotations(doc_id, id)`,
		`INSERT INTO documents(doc_id, content_id, path, name, size, pages, last_opened)
		 VALUES(1, '10:a', '/tmp/a.pdf', 'a.pdf', 10, 1, 0),
		       (2, '20:b', '/tmp/b.pdf', 'b.pdf', 20, 1, 0)`,
		`INSERT INTO annotations(id, doc_id, page, type, payload)
		 VALUES('same', 1, 1, 'highlight', '{"id":"same","type":"highlight","page":1}')`,
		`PRAGMA user_version=1`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			t.Fatalf("setup: %v", err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("user_version = %d, want %d", version, schemaVersion)
	}

	if err := s.SaveAnnotations(2, []json.RawMessage{ann("same", 1)}); err != nil {
		t.Fatal(err)
	}
	sa, _ := s.Load(1)
	sb, _ := s.Load(2)
	if len(sa.Annotations) != 1 || len(sb.Annotations) != 1 {
		t.Fatalf("annotations not scoped after migration: a=%d b=%d", len(sa.Annotations), len(sb.Annotations))
	}
}
