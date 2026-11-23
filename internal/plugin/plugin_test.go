package plugin

import (
	"archive/zip"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	_ "modernc.org/sqlite"
)

func makeZip(t *testing.T, files map[string][]byte) string {
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

func manifestJSON(t *testing.T, m Manifest) []byte {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func translatorManifest(endpoint string) Manifest {
	return Manifest{
		ID:       "translator-test",
		Name:     "测试翻译",
		Version:  "1.0.0",
		Kind:     KindTranslator,
		Provider: ProviderOpenAI,
		Endpoint: endpoint,
		Model:    "test-model",
	}
}

func TestValidateManifest(t *testing.T) {
	good := Manifest{ID: "a.b-c_1", Name: "x", Version: "1.2.3", Kind: KindTranslator, Provider: ProviderGoogle, Endpoint: "https://translate.googleapis.com/translate_a/single"}
	if err := validateManifest(&good); err != nil {
		t.Fatalf("good manifest rejected: %v", err)
	}
	if good.TargetLang != "zh-CN" {
		t.Fatalf("target lang default = %q", good.TargetLang)
	}

	cases := []Manifest{
		{ID: "Bad ID", Name: "x", Version: "1", Kind: KindTranslator, Provider: ProviderGoogle, Endpoint: "https://x.test"},
		{ID: "ok", Name: "", Version: "1", Kind: KindTranslator, Provider: ProviderGoogle, Endpoint: "https://x.test"},
		{ID: "ok", Name: "x", Version: "1", Kind: KindTranslator, Provider: ProviderGoogle, Endpoint: "http://x.test"},
		{ID: "ok", Name: "x", Version: "1", Kind: KindTranslator, Provider: "nope", Endpoint: "https://x.test"},
		{ID: "ok", Name: "x", Version: "1", Kind: KindTranslator, Provider: ProviderOpenAI, Endpoint: "https://x.test"},
		{ID: "ok", Name: "x", Version: "1", Kind: KindDictionary, Data: "../dict.sqlite"},
		{ID: "ok", Name: "x", Version: "1", Kind: "other"},
	}
	for i, m := range cases {
		if err := validateManifest(&m); err == nil {
			t.Errorf("case %d accepted invalid manifest: %+v", i, m)
		}
	}

	local := Manifest{ID: "ok", Name: "x", Version: "1", Kind: KindTranslator, Provider: ProviderOpenAI, Endpoint: "http://127.0.0.1:11434/v1/chat/completions", Model: "qwen"}
	if err := validateManifest(&local); err != nil {
		t.Fatalf("loopback endpoint rejected: %v", err)
	}
}

func TestCompareVersion(t *testing.T) {
	cases := [][3]any{
		{"1.0.0", "1.0.1", -1},
		{"1.10", "1.9", 1},
		{"2", "2.0.0", 0},
		{"1.0.0-beta", "1.0.0", 0},
	}
	for _, c := range cases {
		got := compareVersion(c[0].(string), c[1].(string))
		if got != c[2].(int) {
			t.Errorf("compareVersion(%q,%q) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}

func TestStageRejectsTraversal(t *testing.T) {
	path := makeZip(t, map[string][]byte{
		"manifest.json": manifestJSON(t, translatorManifest("https://api.example.com/v1")),
		"../evil.txt":   []byte("no"),
	})
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stage(path); err == nil {
		t.Fatal("zip slip package was accepted")
	}
}

func TestInstallUpdateAndConfig(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	m := translatorManifest("https://api.example.com/v1/chat/completions")
	path := makeZip(t, map[string][]byte{"manifest.json": manifestJSON(t, m)})
	candidate, err := store.Stage(path)
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Existing {
		t.Fatal("fresh install reported existing")
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.SetKey(m.ID, "secret"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}

	m.Version = "1.1.0"
	path2 := makeZip(t, map[string][]byte{"manifest.json": manifestJSON(t, m)})
	candidate, err = store.Stage(path2)
	if err != nil {
		t.Fatal(err)
	}
	if !candidate.Existing || candidate.ExistingVersion != "1.0.0" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	list := store.List()
	if len(list) != 1 || list[0].Version != "1.1.0" || !list[0].HasKey || !list[0].Enabled || !list[0].Default {
		t.Fatalf("list after update = %+v", list)
	}

	// Downgrade is refused and the staged package is discarded.
	m.Version = "0.9.0"
	path3 := makeZip(t, map[string][]byte{"manifest.json": manifestJSON(t, m)})
	candidate, err = store.Stage(path3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(candidate.Token); !errors.Is(err, ErrVersionTooOld) {
		t.Fatalf("downgrade error = %v", err)
	}
}

func TestTranslateOpenAIAndCache(t *testing.T) {
	var calls int32
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(body, &req)
		if len(req.Messages) != 2 || req.Messages[1].Content != "Hello world" {
			t.Errorf("unexpected request: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"你好，世界"}}]}`))
	}))
	defer srv.Close()

	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := translatorManifest(srv.URL + "/chat/completions")
	path := makeZip(t, map[string][]byte{"manifest.json": manifestJSON(t, m)})
	candidate, err := store.Stage(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.SetKey(m.ID, "k-123"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}

	res, err := store.Translate(context.Background(), m.ID, "Hello world")
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好，世界" || res.Cached {
		t.Fatalf("result = %+v", res)
	}
	if gotAuth != "Bearer k-123" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	res, err = store.Translate(context.Background(), m.ID, "Hello world")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Cached {
		t.Fatal("second translation was not cached")
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("server called %d times, want 1", n)
	}
}

func TestLookupDictionary(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(t.TempDir(), "dict.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE entries (word TEXT NOT NULL, phonetic TEXT, pos TEXT, translation TEXT NOT NULL, lemma TEXT)`,
		`CREATE INDEX entries_word ON entries(word COLLATE NOCASE)`,
		`INSERT INTO entries VALUES ('run', '/rʌn/', 'v.', '跑；运行', '')`,
		`INSERT INTO entries VALUES ('running', '/ˈrʌnɪŋ/', 'v.', '跑步（run 的现在分词）', 'run')`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	m := Manifest{ID: "dict-test", Name: "测试词典", Version: "1.0.0", Kind: KindDictionary, Data: "dict.sqlite"}
	path := makeZip(t, map[string][]byte{
		"manifest.json": manifestJSON(t, m),
		"dict.sqlite":   mustRead(t, dbPath),
	})
	candidate, err := store.Stage(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}

	res, err := store.Lookup(m.ID, "Running")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || res.Lemma != "run" || len(res.Entries) == 0 {
		t.Fatalf("lookup = %+v", res)
	}
	if res.Word != "Running" {
		t.Fatalf("display word = %q", res.Word)
	}

	missing, err := store.Lookup(m.ID, "definitely-missing")
	if err != nil {
		t.Fatal(err)
	}
	if missing.Found {
		t.Fatalf("missing word found: %+v", missing)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestBundledPackages installs the examples produced by `make plugins`, when
// they exist. This catches packaging mistakes (manifest outside the zip root,
// missing dictionary data, schema drift) without requiring build artifacts in
// a clean checkout.
func TestBundledPackages(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "build", "plugins", "*.pdfplugin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Skip("no build/plugins/*.pdfplugin; run `make plugins` first")
	}
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		candidate, err := store.Stage(file)
		if err != nil {
			t.Fatalf("stage %s: %v", filepath.Base(file), err)
		}
		if _, err := store.Commit(candidate.Token); err != nil {
			t.Fatalf("commit %s: %v", filepath.Base(file), err)
		}
	}
	list := store.List()
	if len(list) != len(files) {
		t.Fatalf("installed %d plugins, want %d", len(list), len(files))
	}

	var dictID string
	for _, p := range list {
		if p.Kind != KindDictionary {
			continue
		}
		if dictID == "" || p.ID == "dictionary-sample" {
			dictID = p.ID
		}
	}
	if dictID == "" {
		t.Fatal("sample dictionary package missing")
	}
	if err := store.SetEnabled(dictID, true); err != nil {
		t.Fatal(err)
	}
	res, err := store.Lookup(dictID, "running")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || res.Lemma != "run" || len(res.Entries) == 0 {
		t.Fatalf("sample dictionary lookup = %+v", res)
	}

	// The FreeDict example pack is larger and only present after building it
	// with scripts/build-freedict.py. Verify it when available.
	for _, p := range list {
		if p.ID != "freedict-eng-zho" {
			continue
		}
		if err := store.SetEnabled(p.ID, true); err != nil {
			t.Fatal(err)
		}
		word, err := store.Lookup(p.ID, "computer")
		if err != nil {
			t.Fatal(err)
		}
		if !word.Found || len(word.Entries) == 0 || word.Phonetic == "" {
			t.Fatalf("FreeDict lookup = %+v", word)
		}
		many, err := store.LookupMany(p.ID, "The computer is a useful tool")
		if err != nil {
			t.Fatal(err)
		}
		if len(many) != 6 {
			t.Fatalf("FreeDict sentence lookup returned %d results", len(many))
		}
		foundComputer := false
		for _, item := range many {
			if strings.EqualFold(item.Word, "computer") && item.Found && len(item.Entries) > 0 {
				foundComputer = true
			}
		}
		if !foundComputer {
			t.Fatalf("FreeDict sentence lookup missed computer: %+v", many)
		}
	}

	for _, p := range list {
		if p.ID != "ecdict-essential" {
			continue
		}
		if err := store.SetEnabled(p.ID, true); err != nil {
			t.Fatal(err)
		}
		issue, err := store.Lookup(p.ID, "issue")
		if err != nil {
			t.Fatal(err)
		}
		if !issue.Found || len(issue.Entries) < 2 {
			t.Fatalf("ECDICT issue lookup = %+v", issue)
		}
		went, err := store.Lookup(p.ID, "went")
		if err != nil {
			t.Fatal(err)
		}
		if !went.Found || went.Lemma != "go" {
			t.Fatalf("ECDICT went lookup = %+v", went)
		}
	}
}

func installTranslator(t *testing.T, store *Store, m Manifest, appID, secret string) {
	t.Helper()
	path := makeZip(t, map[string][]byte{"manifest.json": manifestJSON(t, m)})
	candidate, err := store.Stage(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCredentials(m.ID, appID, secret); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}
}

func TestTranslateBaidu(t *testing.T) {
	const appID = "20240001"
	const secret = "baidu-secret"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		q := r.FormValue("q")
		salt := r.FormValue("salt")
		want := fmt.Sprintf("%x", md5.Sum([]byte(appID+q+salt+secret)))
		if r.FormValue("appid") != appID || r.FormValue("sign") != want {
			t.Errorf("bad baidu credentials/sign: %s", r.Form.Encode())
		}
		if r.FormValue("from") != "en" || r.FormValue("to") != "zh" {
			t.Errorf("bad languages: %s", r.Form.Encode())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"trans_result":[{"src":"hello","dst":"你好"}]}`))
	}))
	defer srv.Close()

	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{ID: "baidu-test", Name: "百度", Version: "1.0.0", Kind: KindTranslator, Provider: ProviderBaidu, Endpoint: srv.URL}
	installTranslator(t, store, m, appID, secret)
	res, err := store.Translate(context.Background(), m.ID, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好" {
		t.Fatalf("baidu result = %+v", res)
	}
}

func TestTranslateBaiduLLM(t *testing.T) {
	const appID = "20240001"
	const apiKey = "baidu-key"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+apiKey {
			t.Errorf("authorization = %q", got)
		}
		var body struct {
			AppID string `json:"appid"`
			From  string `json:"from"`
			To    string `json:"to"`
			Q     string `json:"q"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.AppID != appID || body.From != "en" || body.To != "zh" || body.Q != "hello" {
			t.Errorf("bad baidu llm request: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"from":"en","to":"zh","trans_result":[{"src":"hello","dst":"你好"}]}`))
	}))
	defer srv.Close()

	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{ID: "baidu-llm-test", Name: "百度大模型", Version: "1.0.0", Kind: KindTranslator, Provider: ProviderBaiduLLM, Endpoint: srv.URL}
	installTranslator(t, store, m, appID, apiKey)
	res, err := store.Translate(context.Background(), m.ID, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好" {
		t.Fatalf("baidu llm result = %+v", res)
	}
}

func TestTranslateYoudao(t *testing.T) {
	const appKey = "youdao-app"
	const secret = "youdao-secret"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		q := r.FormValue("q")
		salt := r.FormValue("salt")
		curtime := r.FormValue("curtime")
		sum := sha256.Sum256([]byte(appKey + q + salt + curtime + secret))
		want := hex.EncodeToString(sum[:])
		if r.FormValue("appKey") != appKey || r.FormValue("sign") != want || r.FormValue("signType") != "v3" {
			t.Errorf("bad youdao credentials/sign: %s", r.Form.Encode())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"errorCode":"0","translation":["你好"]}`))
	}))
	defer srv.Close()

	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{ID: "youdao-test", Name: "有道", Version: "1.0.0", Kind: KindTranslator, Provider: ProviderYoudao, Endpoint: srv.URL}
	installTranslator(t, store, m, appKey, secret)
	res, err := store.Translate(context.Background(), m.ID, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好" {
		t.Fatalf("youdao result = %+v", res)
	}
}

func TestLookupManyAndInflections(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(t.TempDir(), "dict.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`CREATE TABLE entries (word TEXT NOT NULL, phonetic TEXT, pos TEXT, translation TEXT NOT NULL, lemma TEXT)`,
		`CREATE INDEX entries_word ON entries(word COLLATE NOCASE)`,
		`INSERT INTO entries VALUES ('book', '/bʊk/', 'n.', '书', '')`,
		`INSERT INTO entries VALUES ('run', '/rʌn/', 'v.', '跑', '')`,
		`INSERT INTO entries VALUES ('running', '/ˈrʌnɪŋ/', 'v.', '跑步', 'run')`,
		`INSERT INTO entries VALUES ('the', '/ðə/', 'art.', '这；那', '')`,
		`INSERT INTO entries VALUES ('is', '/ɪz/', 'v.', '是', '')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	m := Manifest{ID: "dict-many", Name: "词典", Version: "1.0.0", Kind: KindDictionary, Data: "dict.sqlite"}
	path := makeZip(t, map[string][]byte{
		"manifest.json": manifestJSON(t, m),
		"dict.sqlite":   mustRead(t, dbPath),
	})
	candidate, err := store.Stage(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(candidate.Token); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEnabled(m.ID, true); err != nil {
		t.Fatal(err)
	}

	// "books" has no own row and must reduce to "book".
	res, err := store.Lookup(m.ID, "books")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Found || res.Lemma != "book" || res.Word != "books" {
		t.Fatalf("plural lookup = %+v", res)
	}

	results, err := store.LookupMany(m.ID, "The running book is running.")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 {
		t.Fatalf("LookupMany returned %d results: %+v", len(results), results)
	}
	want := []string{"The", "running", "book", "is"}
	for i, w := range want {
		if results[i].Word != w || !results[i].Found {
			t.Fatalf("result[%d] = %+v, want %s", i, results[i], w)
		}
	}
	if results[1].Lemma != "run" {
		t.Fatalf("running lemma = %q", results[1].Lemma)
	}
}

func TestCleanHeadwordNormalization(t *testing.T) {
	got := cleanHeadword("  \u200bGettys\u00a0burg\u00ad, ")
	if got != "Gettys burg" {
		t.Fatalf("cleanHeadword = %q", got)
	}
}
