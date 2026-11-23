package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"pdfviewer/internal/annot"
)

func TestSQLiteStorageAndSidecarMigration(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	pdfPath := filepath.Join(dir, "book.pdf")
	pdfBytes := []byte("%PDF-1.7\n" + "sample page content\n")
	if err := os.WriteFile(pdfPath, pdfBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	// A legacy sidecar next to the PDF, with an mtime-based fingerprint.
	legacy := annot.Data{
		Schema: 1,
		Doc: annot.Doc{
			Name: "book.pdf", Size: int64(len(pdfBytes)),
			Fingerprint: "legacy-fingerprint", Pages: 3,
		},
		Reading: annot.Reading{
			LastPage: 2, ScrollRatio: 0.5, Zoom: 1.25,
			ViewMode: "continuous", ReadPages: []int{1, 2},
		},
		Annotations: []json.RawMessage{
			json.RawMessage(`{"id":"a1","type":"highlight","page":2,"color":"#ffd84d","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}`),
		},
	}
	sidecarPath := pdfPath + ".pdfviewer.json"
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sidecarPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	t.Cleanup(func() {
		if app.notes != nil {
			_ = app.notes.Close()
		}
	})
	if app.notes == nil {
		t.Fatal("notes store unavailable")
	}
	if _, err := os.Stat(filepath.Join(app.cfgDir, "library.db")); err != nil {
		t.Fatalf("library.db missing: %v", err)
	}

	info, err := app.OpenDocument(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Fingerprint == "" || info.Fingerprint == "legacy-fingerprint" {
		t.Fatalf("unexpected fingerprint %q", info.Fingerprint)
	}

	// Migration: opening must import the adjacent sidecar exactly once.
	res, err := app.LoadSidecar(info.Token)
	if err != nil {
		t.Fatal(err)
	}
	if res.Data == "" {
		t.Fatal("legacy sidecar was not imported")
	}
	var loaded annot.Data
	if err := json.Unmarshal([]byte(res.Data), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Reading.LastPage != 2 || len(loaded.Annotations) != 1 {
		t.Fatalf("import mismatch: %+v", loaded)
	}
	if loaded.Doc.Fingerprint != info.Fingerprint {
		t.Fatalf("state fingerprint = %q, want %q", loaded.Doc.Fingerprint, info.Fingerprint)
	}

	// Incremental reading save: only the row changes, no new sidecar/.bak.
	reading := `{"lastPage":3,"scrollRatio":0.1,"zoom":2,"viewMode":"continuous","readPages":[1,2,3]}`
	if err := app.SaveReading(info.Token, reading, 3); err != nil {
		t.Fatal(err)
	}
	res, err = app.LoadSidecar(info.Token)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(res.Data), &loaded)
	if loaded.Reading.LastPage != 3 || len(loaded.Reading.ReadPages) != 3 {
		t.Fatalf("reading not updated: %+v", loaded.Reading)
	}
	if _, err := os.Stat(sidecarPath + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("unexpected .bak created: %v", err)
	}

	// Annotation reconciliation deletes ids omitted from the payload.
	anns := `[{"id":"a2","type":"note","page":3,"color":"#fff","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}]`
	if err := app.SaveAnnotations(info.Token, anns); err != nil {
		t.Fatal(err)
	}
	res, _ = app.LoadSidecar(info.Token)
	_ = json.Unmarshal([]byte(res.Data), &loaded)
	if len(loaded.Annotations) != 1 {
		t.Fatalf("annotations not reconciled: %d", len(loaded.Annotations))
	}
	var head struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(loaded.Annotations[0], &head)
	if head.ID != "a2" {
		t.Fatalf("unexpected annotation id %q", head.ID)
	}

	// Explicit export writes a portable sidecar with the content fingerprint.
	exported, err := app.ExportSidecar(info.Token)
	if err != nil {
		t.Fatal(err)
	}
	if exported != sidecarPath {
		t.Fatalf("export path = %q, want %q", exported, sidecarPath)
	}
	exportedRaw, err := os.ReadFile(exported)
	if err != nil {
		t.Fatal(err)
	}
	if err := annot.Validate(exportedRaw); err != nil {
		t.Fatalf("exported sidecar invalid: %v", err)
	}
	var exportedData annot.Data
	_ = json.Unmarshal(exportedRaw, &exportedData)
	if exportedData.Doc.Fingerprint != info.Fingerprint {
		t.Fatalf("exported fingerprint = %q", exportedData.Doc.Fingerprint)
	}

	// Import reads that portable file back into the database.
	if _, err := app.ImportSidecar(info.Token); err != nil {
		t.Fatal(err)
	}
}
