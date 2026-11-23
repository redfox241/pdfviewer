package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"pdfviewer/internal/annot"
	"pdfviewer/internal/library"
	"pdfviewer/internal/notestore"
	"pdfviewer/internal/pdfstream"
	"pdfviewer/internal/plugin"
	"pdfviewer/internal/settings"
)

const appVersion = "0.1.0"

type App struct {
	ctx      context.Context
	cfgDir   string
	stream   *pdfstream.Server
	settings *settings.Store
	recent   *library.Store
	notes    *notestore.Store
	plugins  *plugin.Store

	mu          sync.Mutex
	docs        map[string]docEntry
	startupFile string
	settingsErr string
	libraryErr  string
	notesErr    string
	pluginErr   string

	trMu      sync.Mutex
	trCancels map[string]context.CancelFunc
}

type docEntry struct {
	DocID       int64
	Path        string
	Name        string
	Size        int64
	Fingerprint string
}

// DocInfo is returned to the frontend when a document is opened.
type DocInfo struct {
	Token       string `json:"token"`
	Path        string `json:"path"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Fingerprint string `json:"fingerprint"`
	URL         string `json:"url"`
}

func NewApp() *App {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		cfgDir = os.TempDir()
	}
	cfgDir = filepath.Join(cfgDir, "PDFViewer")

	a := &App{
		cfgDir:    cfgDir,
		stream:    pdfstream.New(),
		docs:      make(map[string]docEntry),
		trCancels: make(map[string]context.CancelFunc),
	}

	st, err := settings.New(cfgDir)
	if err != nil {
		a.settingsErr = err.Error()
		st, _ = settings.New(filepath.Join(os.TempDir(), "PDFViewer"))
	}
	a.settings = st

	lib, err := library.New(cfgDir)
	if err != nil {
		a.libraryErr = err.Error()
		lib, _ = library.New(filepath.Join(os.TempDir(), "PDFViewer"))
	}
	a.recent = lib

	notes, err := notestore.New(cfgDir)
	if err != nil {
		a.notesErr = err.Error()
		notes, err = notestore.NewMemory()
		if err != nil {
			a.notesErr = a.notesErr + "; 内存库不可用: " + err.Error()
		}
	}
	a.notes = notes

	plugins, err := plugin.New(filepath.Join(cfgDir, "plugins"))
	if err != nil {
		a.pluginErr = err.Error()
	}
	a.plugins = plugins

	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if strings.EqualFold(filepath.Ext(arg), ".pdf") {
			if info, err := os.Stat(arg); err == nil && !info.IsDir() {
				a.startupFile = arg
				break
			}
		}
	}
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.logf("wails startup, args=%q startupFile=%q", os.Args, a.startupFile)
}

// Ping is called by the frontend once it has booted. It doubles as a
// diagnostic breadcrumb when the UI fails to initialise on a new platform.
func (a *App) Ping() string {
	a.logf("frontend booted, platform=%s", goruntime.GOOS)
	return appVersion
}

func (a *App) logf(format string, args ...any) {
	if err := os.MkdirAll(a.cfgDir, 0o755); err != nil {
		return
	}
	logPath := filepath.Join(a.cfgDir, "app.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 1<<20 {
		_ = os.Truncate(logPath, 0)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// Platform reports the runtime OS so the UI can adapt its chrome.
func (a *App) Platform() string {
	return goruntime.GOOS
}

func (a *App) Version() string {
	return appVersion
}

// ToggleMaximise switches the main window between zoomed and normal size.
// The frontend calls this when the window chrome is double-clicked, since
// Wails' CSS drag regions do not inherit the native title bar behaviour.
func (a *App) ToggleMaximise() {
	if a.ctx == nil {
		return
	}
	wruntime.WindowToggleMaximise(a.ctx)
}

// StartupDocument is the PDF passed on the command line, if any.
func (a *App) StartupDocument() string {
	a.logf("startup document requested: %q", a.startupFile)
	return a.startupFile
}

func (a *App) StartupWarnings() []string {
	out := []string{}
	if a.settingsErr != "" {
		out = append(out, "设置读取失败："+a.settingsErr)
	}
	if a.libraryErr != "" {
		out = append(out, "最近文件读取失败："+a.libraryErr)
	}
	if a.notesErr != "" {
		out = append(out, "阅读数据库初始化失败："+a.notesErr)
	}
	if a.pluginErr != "" {
		out = append(out, "插件目录初始化失败："+a.pluginErr)
	}
	return out
}

// OpenDialog lets the user pick a PDF and opens it.
func (a *App) OpenDialog() (DocInfo, error) {
	if a.ctx == nil {
		return DocInfo{}, fmt.Errorf("应用尚未就绪")
	}
	path, err := wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "打开 PDF",
		Filters: []wruntime.FileFilter{
			{DisplayName: "PDF 文档 (*.pdf)", Pattern: "*.pdf;*.PDF"},
		},
	})
	if err != nil {
		return DocInfo{}, err
	}
	if path == "" {
		return DocInfo{}, nil
	}
	return a.OpenDocument(path)
}

// OpenDocument validates a path, registers it for streaming and returns info.
func (a *App) OpenDocument(path string) (DocInfo, error) {
	if !strings.EqualFold(filepath.Ext(path), ".pdf") {
		return DocInfo{}, fmt.Errorf("仅支持 PDF 文件")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return DocInfo{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return DocInfo{}, fmt.Errorf("无法读取文件：%w", err)
	}
	if info.IsDir() {
		return DocInfo{}, fmt.Errorf("这是一个文件夹")
	}

	fp, err := annot.Fingerprint(abs)
	if err != nil {
		return DocInfo{}, fmt.Errorf("无法分析文件：%w", err)
	}
	if a.notes == nil {
		return DocInfo{}, fmt.Errorf("阅读数据库不可用")
	}
	name := filepath.Base(abs)
	docID, err := a.notes.UpsertDocument(abs, name, info.Size(), fp, 0)
	if err != nil {
		return DocInfo{}, fmt.Errorf("无法初始化阅读数据：%w", err)
	}
	a.logf("open document %q size=%d doc_id=%d", abs, info.Size(), docID)

	// One-time migration: if this content has no state yet, pull in a
	// portable sidecar left next to the PDF by an older version.
	a.importAdjacentIfEmpty(docID, abs, info.Size())

	token, err := a.stream.Add(abs)
	if err != nil {
		return DocInfo{}, fmt.Errorf("无法打开文件：%w", err)
	}

	a.mu.Lock()
	a.docs[token] = docEntry{DocID: docID, Path: abs, Name: name, Size: info.Size(), Fingerprint: fp}
	a.mu.Unlock()

	a.recent.Touch(abs, name, 0)

	return DocInfo{
		Token:       token,
		Path:        abs,
		Name:        name,
		Size:        info.Size(),
		Fingerprint: fp,
		URL:         "/pdf/" + token,
	}, nil
}

func (a *App) doc(token string) (docEntry, error) {
	a.mu.Lock()
	d, ok := a.docs[token]
	a.mu.Unlock()
	if !ok {
		return docEntry{}, fmt.Errorf("文档未打开或会话已失效")
	}
	return d, nil
}

// LoadSidecar returns the stored reading state and annotations for a document.
// Despite the historical name, the data now comes from the central SQLite
// library; the payload keeps the portable sidecar schema for the frontend.
func (a *App) LoadSidecar(token string) (annot.LoadResult, error) {
	d, err := a.doc(token)
	if err != nil {
		return annot.LoadResult{}, err
	}
	if a.notes == nil {
		return annot.LoadResult{}, fmt.Errorf("阅读数据库不可用")
	}
	st, err := a.notes.Load(d.DocID)
	if err != nil {
		return annot.LoadResult{}, err
	}

	res := annot.LoadResult{Fingerprint: d.Fingerprint, Path: a.notes.Path()}
	if st.HasData {
		payload := annot.Data{
			Schema: annot.SchemaVersion,
			Doc: annot.Doc{
				Name: d.Name, Size: d.Size, Fingerprint: d.Fingerprint, Pages: st.Pages,
			},
			Reading:     st.Reading,
			Annotations: st.Annotations,
		}
		if payload.Annotations == nil {
			payload.Annotations = []json.RawMessage{}
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return annot.LoadResult{}, err
		}
		res.Data = string(raw)
	}
	a.logf("load state %q db=%q bytes=%d has_data=%v", d.Path, a.notes.Path(), len(res.Data), st.HasData)
	return res, nil
}

// SaveReading persists only the reading position/zoom/read pages. It is called
// on page turns and after scroll idle, not on every animation frame.
func (a *App) SaveReading(token, readingJSON string, pages int) error {
	d, err := a.doc(token)
	if err != nil {
		return err
	}
	if a.notes == nil {
		return fmt.Errorf("阅读数据库不可用")
	}
	var reading annot.Reading
	if err := json.Unmarshal([]byte(readingJSON), &reading); err != nil {
		return fmt.Errorf("阅读状态格式无效：%w", err)
	}
	return a.notes.SaveReading(d.DocID, reading, pages)
}

// SaveAnnotations reconciles the complete annotation list for a document.
// Only annotation edits call this; ordinary reading no longer rewrites JSON.
func (a *App) SaveAnnotations(token, annotationsJSON string) error {
	d, err := a.doc(token)
	if err != nil {
		return err
	}
	if a.notes == nil {
		return fmt.Errorf("阅读数据库不可用")
	}
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(annotationsJSON), &items); err != nil {
		return fmt.Errorf("标注数据格式无效：%w", err)
	}
	return a.notes.SaveAnnotations(d.DocID, items)
}

// SaveSidecar is kept for compatibility: it stores a full portable payload in
// the database. New clients should use SaveReading/SaveAnnotations.
func (a *App) SaveSidecar(token, data string) (string, error) {
	d, err := a.doc(token)
	if err != nil {
		return "", err
	}
	if a.notes == nil {
		return "", fmt.Errorf("阅读数据库不可用")
	}
	if err := annot.Validate([]byte(data)); err != nil {
		return "", err
	}
	var payload annot.Data
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return "", err
	}
	if err := a.notes.Import(d.DocID, payload); err != nil {
		return "", err
	}
	return a.notes.Path(), nil
}

// ExportSidecar writes an explicit portable .pdfviewer.json next to the PDF.
func (a *App) ExportSidecar(token string) (string, error) {
	d, err := a.doc(token)
	if err != nil {
		return "", err
	}
	if a.notes == nil {
		return "", fmt.Errorf("阅读数据库不可用")
	}
	st, err := a.notes.Load(d.DocID)
	if err != nil {
		return "", err
	}
	payload := annot.Data{
		Schema: annot.SchemaVersion,
		Doc: annot.Doc{
			Name: d.Name, Size: d.Size, Fingerprint: d.Fingerprint, Pages: st.Pages,
		},
		Reading:     st.Reading,
		Annotations: st.Annotations,
	}
	if payload.Annotations == nil {
		payload.Annotations = []json.RawMessage{}
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	path, err := annot.WritePortable(d.Path, raw)
	if err != nil {
		return "", fmt.Errorf("导出失败（目录可能不可写）：%w", err)
	}
	a.logf("export sidecar %q -> %q", d.Path, path)
	return path, nil
}

// ImportSidecar merges an adjacent .pdfviewer.json back into the database.
func (a *App) ImportSidecar(token string) (string, error) {
	d, err := a.doc(token)
	if err != nil {
		return "", err
	}
	if a.notes == nil {
		return "", fmt.Errorf("阅读数据库不可用")
	}
	raw, ok, err := annot.ReadAdjacent(d.Path)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("未找到同名 .pdfviewer.json")
	}
	if err := annot.Validate(raw); err != nil {
		return "", fmt.Errorf("文件格式无效：%w", err)
	}
	var payload annot.Data
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	if payload.Doc.Size != 0 && payload.Doc.Size != d.Size {
		return "", fmt.Errorf("该 sidecar 属于其他文档（大小不一致）")
	}
	if err := a.notes.Import(d.DocID, payload); err != nil {
		return "", err
	}
	a.logf("import sidecar %q from %q", d.Path, annot.AdjacentPath(d.Path))
	return annot.AdjacentPath(d.Path), nil
}

func (a *App) importAdjacentIfEmpty(docID int64, path string, size int64) {
	source := annot.AdjacentPath(path)
	raw, ok, err := annot.ReadAdjacent(path)
	if err != nil {
		a.logf("read adjacent sidecar failed %q: %v", path, err)
		return
	}
	if !ok {
		// Pre-SQLite fallback for read-only locations.
		raw, ok, err = annot.ReadLegacyCentral(path, a.cfgDir)
		source = filepath.Join(a.cfgDir, "notes")
		if err != nil || !ok {
			return
		}
	}
	empty, err := a.notes.IsEmpty(docID)
	if err != nil || !empty {
		return
	}
	if err := annot.Validate(raw); err != nil {
		a.logf("skip invalid sidecar %q: %v", source, err)
		return
	}
	var payload annot.Data
	if err := json.Unmarshal(raw, &payload); err != nil {
		a.logf("skip unreadable sidecar %q: %v", source, err)
		return
	}
	// Old sidecars carry an mtime-based fingerprint; accept them when the file
	// size matches. New sidecars match exactly.
	if payload.Doc.Size != 0 && payload.Doc.Size != size {
		a.logf("skip sidecar %q: size mismatch", source)
		return
	}
	if err := a.notes.Import(docID, payload); err != nil {
		a.logf("import sidecar failed %q: %v", source, err)
		return
	}
	a.logf("imported sidecar %q", source)
}

// ReadDocumentBase64 is a fallback used if streaming is unavailable.
func (a *App) ReadDocumentBase64(token string) (string, error) {
	d, err := a.doc(token)
	if err != nil {
		return "", err
	}
	a.logf("base64 fallback used for %q", d.Path)
	raw, err := os.ReadFile(d.Path)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func (a *App) CloseDocument(token string) {
	a.stream.Remove(token)
	a.mu.Lock()
	delete(a.docs, token)
	a.mu.Unlock()
}

// UpdateProgress refreshes the recent-documents entry.
func (a *App) UpdateProgress(token string, pages int, progress float64) {
	d, err := a.doc(token)
	if err != nil {
		return
	}
	if progress < 0 {
		progress = 0
	}
	if progress > 1 {
		progress = 1
	}
	a.recent.SetProgress(d.Path, pages, progress)
}

// RecentList returns documents that still exist, newest first.
func (a *App) RecentList() []library.Entry {
	return a.recent.List()
}

func (a *App) RemoveRecent(path string) {
	a.recent.Remove(path)
}

func (a *App) GetSettings() settings.Settings {
	return a.settings.Get()
}

func (a *App) SaveSettings(v settings.Settings) error {
	return a.settings.Set(v)
}

// ---------------------------------------------------------------- plugins

// Plugins lists installed translator and dictionary plugins.
func (a *App) Plugins() []plugin.Info {
	if a.plugins == nil {
		return []plugin.Info{}
	}
	return a.plugins.List()
}

// PickPlugin asks for a .pdfplugin file and validates it. Nothing is installed
// until InstallPlugin is called.
func (a *App) PickPlugin() (*plugin.Candidate, error) {
	if a.ctx == nil {
		return nil, fmt.Errorf("应用尚未就绪")
	}
	if a.plugins == nil {
		return nil, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	path, err := wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "安装插件",
		Filters: []wruntime.FileFilter{
			{DisplayName: "PDF Viewer 插件 (*.pdfplugin)", Pattern: "*.pdfplugin"},
		},
	})
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	return a.plugins.Stage(path)
}

// StagePlugin validates a dropped or pasted plugin path.
func (a *App) StagePlugin(path string) (*plugin.Candidate, error) {
	if a.plugins == nil {
		return nil, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if !strings.EqualFold(filepath.Ext(path), ".pdfplugin") {
		return nil, fmt.Errorf("只能安装 .pdfplugin 文件")
	}
	return a.plugins.Stage(path)
}

// InstallPlugin commits a previously staged package.
func (a *App) InstallPlugin(token string) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if _, err := a.plugins.Commit(token); err != nil {
		return []plugin.Info{}, err
	}
	return a.plugins.List(), nil
}

// CancelPluginInstall discards a staged package.
func (a *App) CancelPluginInstall(token string) {
	if a.plugins != nil {
		a.plugins.Cancel(token)
	}
}

// UninstallPlugin removes a plugin, its configuration and its API key.
func (a *App) UninstallPlugin(id string) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if err := a.plugins.Remove(id); err != nil {
		return a.plugins.List(), err
	}
	return a.plugins.List(), nil
}

func (a *App) SetPluginEnabled(id string, enabled bool) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if err := a.plugins.SetEnabled(id, enabled); err != nil {
		return a.plugins.List(), err
	}
	return a.plugins.List(), nil
}

func (a *App) SetPluginDefault(id string) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if err := a.plugins.SetDefault(id); err != nil {
		return a.plugins.List(), err
	}
	return a.plugins.List(), nil
}

func (a *App) SetPluginKey(id, key string) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if err := a.plugins.SetKey(id, key); err != nil {
		return a.plugins.List(), err
	}
	return a.plugins.List(), nil
}

// SetPluginCredentials stores AppID/AppKey plus secret for Baidu and Youdao.
func (a *App) SetPluginCredentials(id, appID, key string) ([]plugin.Info, error) {
	if a.plugins == nil {
		return []plugin.Info{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if err := a.plugins.SetCredentials(id, appID, key); err != nil {
		return a.plugins.List(), err
	}
	return a.plugins.List(), nil
}

// Translate runs one translation request. reqID lets the frontend cancel a
// request that is no longer displayed.
func (a *App) Translate(reqID, id, text string) (plugin.TranslationResult, error) {
	if a.plugins == nil {
		return plugin.TranslationResult{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	if strings.TrimSpace(reqID) == "" {
		return plugin.TranslationResult{}, fmt.Errorf("缺少请求 ID")
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.trMu.Lock()
	if old, ok := a.trCancels[reqID]; ok {
		old()
	}
	a.trCancels[reqID] = cancel
	a.trMu.Unlock()
	defer func() {
		cancel()
		a.trMu.Lock()
		delete(a.trCancels, reqID)
		a.trMu.Unlock()
	}()
	return a.plugins.Translate(ctx, id, text)
}

func (a *App) CancelTranslate(reqID string) {
	a.trMu.Lock()
	cancel, ok := a.trCancels[reqID]
	delete(a.trCancels, reqID)
	a.trMu.Unlock()
	if ok {
		cancel()
	}
}

func (a *App) LookupWord(id, word string) (plugin.DictResult, error) {
	if a.plugins == nil {
		return plugin.DictResult{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	return a.plugins.Lookup(id, word)
}

// LookupWords returns dictionary entries for the unique words in a sentence.
func (a *App) LookupWords(id, text string) ([]plugin.DictResult, error) {
	if a.plugins == nil {
		return []plugin.DictResult{}, fmt.Errorf("插件目录不可用：%s", a.pluginErr)
	}
	return a.plugins.LookupMany(id, text)
}

func (a *App) OpenPluginsDir() {
	if a.plugins == nil {
		return
	}
	_ = os.MkdirAll(a.plugins.Dir(), 0o755)
	a.RevealFile(a.plugins.Dir())
}

func (a *App) ConfigDir() string {
	return a.cfgDir
}

// LogError lets the frontend surface boot/runtime errors in app.log.
func (a *App) LogError(message string) {
	a.logf("frontend error: %s", message)
}

// RevealFile shows a file in Finder / Explorer.
func (a *App) RevealFile(path string) {
	switch goruntime.GOOS {
	case "darwin":
		_ = exec.Command("open", "-R", path).Start()
	case "windows":
		_ = exec.Command("explorer", "/select,"+path).Start()
	default:
		_ = exec.Command("xdg-open", filepath.Dir(path)).Start()
	}
}
