package main

import (
	"context"
	"encoding/base64"
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
	"pdfviewer/internal/pdfstream"
	"pdfviewer/internal/settings"
)

const appVersion = "0.1.0"

type App struct {
	ctx      context.Context
	cfgDir   string
	stream   *pdfstream.Server
	settings *settings.Store
	recent   *library.Store

	mu          sync.Mutex
	docs        map[string]docEntry
	startupFile string
	settingsErr string
	libraryErr  string
}

type docEntry struct {
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
		cfgDir: cfgDir,
		stream: pdfstream.New(),
		docs:   make(map[string]docEntry),
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
	a.logf("open document %q size=%d", abs, info.Size())

	token, err := a.stream.Add(abs)
	if err != nil {
		return DocInfo{}, fmt.Errorf("无法打开文件：%w", err)
	}

	name := filepath.Base(abs)
	a.mu.Lock()
	a.docs[token] = docEntry{Path: abs, Name: name, Size: info.Size(), Fingerprint: fp}
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
func (a *App) LoadSidecar(token string) (annot.LoadResult, error) {
	d, err := a.doc(token)
	if err != nil {
		return annot.LoadResult{}, err
	}
	res, err := annot.Load(d.Path, a.cfgDir)
	a.logf("load sidecar %q path=%q bytes=%d warn=%q err=%v", d.Path, res.Path, len(res.Data), res.Warning, err)
	return res, err
}

// SaveSidecar atomically writes the sidecar and returns its location.
func (a *App) SaveSidecar(token, data string) (string, error) {
	d, err := a.doc(token)
	if err != nil {
		return "", err
	}
	path, err := annot.Save(d.Path, a.cfgDir, []byte(data))
	if err != nil {
		a.logf("save sidecar failed %q: %v", d.Path, err)
	}
	return path, err
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
