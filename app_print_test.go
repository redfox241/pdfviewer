package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pdfviewer/internal/pdfstream"
	"pdfviewer/internal/printstage"
)

func newPrintTestApp(t *testing.T, limit int64) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	docPath := filepath.Join(dir, "book.pdf")
	if err := os.WriteFile(docPath, []byte("%PDF-1.4"), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := printstage.New(filepath.Join(dir, "cache", "print"))
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		cfgDir:     dir,
		stream:     pdfstream.New(),
		prints:     store,
		printLimit: limit,
		docs: map[string]docEntry{
			"tok": {Path: docPath, Name: "book.pdf"},
		},
	}
	return app, docPath
}

func postStage(app *App, token string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/print/stage", bytes.NewReader(body))
	req.Header.Set("X-Doc-Token", token)
	req.Header.Set("X-Print-Annotations", "1")
	rec := httptest.NewRecorder()
	app.serveHTTP(rec, req)
	return rec
}

func TestPrintStageStoresBodyFromOpenDocument(t *testing.T) {
	app, _ := newPrintTestApp(t, 0)
	rec := postStage(app, "tok", []byte("%PDF-1.7 annotated"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.ID == "" {
		t.Fatalf("payload = %q, err = %v", rec.Body.String(), err)
	}
	job, ok := app.prints.Get(payload.ID)
	if !ok {
		t.Fatal("staged job missing")
	}
	raw, err := os.ReadFile(job.Path)
	if err != nil || string(raw) != "%PDF-1.7 annotated" {
		t.Fatalf("staged content = %q, err = %v", raw, err)
	}
	if !job.IncludeAnnotations {
		t.Fatal("annotation header was not recorded")
	}
}

func TestPrintStageRejectsMissingDocumentAndMethods(t *testing.T) {
	app, _ := newPrintTestApp(t, 0)

	rec := postStage(app, "nope", []byte("x"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad token status = %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/print/stage", nil)
	rec = httptest.NewRecorder()
	app.serveHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/print/other", nil)
	rec = httptest.NewRecorder()
	app.serveHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d", rec.Code)
	}
}

func TestPrintStageRejectsOversizedBody(t *testing.T) {
	app, _ := newPrintTestApp(t, 32)
	rec := postStage(app, "tok", bytes.Repeat([]byte("a"), 64))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestPrintDefaultName(t *testing.T) {
	if got := printDefaultName("book.pdf", true); got != "book (标注).pdf" {
		t.Fatalf("got %q", got)
	}
	if got := printDefaultName("report.PDF", false); got != "report (副本).pdf" {
		t.Fatalf("got %q", got)
	}
	if got := printDefaultName("", true); !strings.HasSuffix(got, "(标注).pdf") {
		t.Fatalf("got %q", got)
	}
}
