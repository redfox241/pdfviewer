package notestore

import (
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
