package main

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"pdfviewer/internal/plugin"

	_ "modernc.org/sqlite"
)

func writePluginZip(t *testing.T, files map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.pdfplugin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func manifestBytes(t *testing.T, m plugin.Manifest) []byte {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestAppPluginBindings exercises the Wails-facing methods rather than the
// plugin package directly: install, list, key handling, translation caching and
// cancellation all go through App.
func TestAppPluginBindings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	var calls int32
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"你好"}}]}`))
	}))
	defer srv.Close()

	app := NewApp()
	t.Cleanup(func() {
		if app.notes != nil {
			_ = app.notes.Close()
		}
	})
	if app.plugins == nil {
		t.Fatalf("plugin store unavailable: %s", app.pluginErr)
	}

	m := plugin.Manifest{
		ID:       "translator-test",
		Name:     "测试翻译",
		Version:  "1.0.0",
		Kind:     plugin.KindTranslator,
		Provider: plugin.ProviderOpenAI,
		Endpoint: srv.URL + "/chat/completions",
		Model:    "test-model",
	}
	candidate, err := app.plugins.Stage(writePluginZip(t, map[string][]byte{
		"manifest.json": manifestBytes(t, m),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.InstallPlugin(candidate.Token); err != nil {
		t.Fatal(err)
	}

	list := app.Plugins()
	if len(list) != 1 || list[0].ID != m.ID || list[0].HasKey || list[0].Enabled {
		t.Fatalf("fresh plugin list = %+v", list)
	}

	if _, err := app.SetPluginKey(m.ID, "k-123"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetPluginEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}
	list = app.Plugins()
	if !list[0].HasKey || !list[0].Enabled || !list[0].Default {
		t.Fatalf("enabled plugin list = %+v", list)
	}

	res, err := app.Translate("req-1", m.ID, "Hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好" || res.Cached {
		t.Fatalf("translation = %+v", res)
	}
	if gotAuth != "Bearer k-123" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if _, err := app.Translate("req-2", m.ID, "Hello"); err != nil {
		t.Fatal(err)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("server calls = %d, want 1 (cache miss)", n)
	}

	// A cancelled request must abort rather than populate the cache.
	slowStarted := make(chan struct{})
	releaseSlow := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(slowStarted)
		select {
		case <-r.Context().Done():
		case <-releaseSlow:
		}
	}))
	defer slow.Close()
	defer close(releaseSlow)
	m2 := m
	m2.ID = "translator-slow"
	m2.Endpoint = slow.URL + "/chat/completions"
	candidate, err = app.plugins.Stage(writePluginZip(t, map[string][]byte{
		"manifest.json": manifestBytes(t, m2),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.InstallPlugin(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetPluginKey(m2.ID, "k"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetPluginEnabled(m2.ID, true); err != nil {
		t.Fatal(err)
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := app.Translate("req-slow", m2.ID, "Hello again")
		errCh <- err
	}()
	select {
	case <-slowStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("slow translator was not called")
	}
	app.CancelTranslate("req-slow")
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled translation did not return")
	}
}

func TestAppDictionaryBinding(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	app := NewApp()
	t.Cleanup(func() {
		if app.notes != nil {
			_ = app.notes.Close()
		}
	})
	if app.plugins == nil {
		t.Fatalf("plugin store unavailable: %s", app.pluginErr)
	}

	dbPath := filepath.Join(t.TempDir(), "dict.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`CREATE TABLE entries (word TEXT NOT NULL, phonetic TEXT, pos TEXT, translation TEXT NOT NULL, lemma TEXT)`,
		`CREATE INDEX entries_word ON entries(word COLLATE NOCASE)`,
		`INSERT INTO entries VALUES ('running', '/ˈrʌnɪŋ/', 'v.', '跑步', 'run')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	raw, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}

	m := plugin.Manifest{ID: "dict-test", Name: "测试词典", Version: "1.0.0", Kind: plugin.KindDictionary, Data: "dict.sqlite"}
	candidate, err := app.plugins.Stage(writePluginZip(t, map[string][]byte{
		"manifest.json": manifestBytes(t, m),
		"dict.sqlite":   raw,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.InstallPlugin(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetPluginEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}
	res, err := app.LookupWord(m.ID, "running")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || res.Lemma != "run" || res.Phonetic == "" {
		t.Fatalf("dictionary result = %+v", res)
	}
	many, err := app.LookupWords(m.ID, "Running is useful")
	if err != nil {
		t.Fatal(err)
	}
	if len(many) != 3 || !many[0].Found {
		t.Fatalf("sentence lookup = %+v", many)
	}
}
