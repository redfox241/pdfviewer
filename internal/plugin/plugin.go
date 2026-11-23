// Package plugin implements user-installable translator and dictionary
// plugins. A plugin is an inert .pdfplugin zip: it contains a manifest and,
// for dictionaries, a SQLite data file. Nothing inside a plugin is executed;
// the host only performs HTTP requests or reads dictionary data described by
// the manifest.
package plugin

import (
	"archive/zip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	KindTranslator = "translator"
	KindDictionary = "dictionary"

	ProviderOpenAI   = "openai"
	ProviderDeepL    = "deepl"
	ProviderGoogle   = "google"
	ProviderBaidu    = "baidu"
	ProviderBaiduLLM = "baidu-llm"
	ProviderYoudao   = "youdao"

	manifestName = "manifest.json"
	configName   = ".config.json"

	maxManifestBytes   = 64 << 10
	maxTranslatorBytes = 2 << 20
	maxDictionaryBytes = 300 << 20
	maxZipEntries      = 4096
)

var (
	ErrNotFound       = errors.New("插件未安装")
	ErrDisabled       = errors.New("插件未启用")
	ErrNeedsKey       = errors.New("插件尚未配置 API Key")
	ErrPluginExists   = errors.New("同名插件已安装")
	ErrVersionTooOld  = errors.New("插件版本不能低于已安装版本")
	ErrInvalidPackage = errors.New("插件包无效")
)

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	versionPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]+)?$`)
)

// Manifest describes a plugin. It is read from manifest.json inside the
// .pdfplugin package.
type Manifest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Kind        string `json:"kind"`
	Description string `json:"description,omitempty"`
	Author      string `json:"author,omitempty"`
	Homepage    string `json:"homepage,omitempty"`
	Source      string `json:"source,omitempty"`
	License     string `json:"license,omitempty"`

	// Translator fields.
	Provider   string `json:"provider,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Model      string `json:"model,omitempty"`
	TargetLang string `json:"targetLang,omitempty"`

	// Dictionary fields.
	Data string `json:"data,omitempty"`
}

type config struct {
	Enabled bool   `json:"enabled"`
	Default bool   `json:"default"`
	AppID   string `json:"appId,omitempty"`
	APIKey  string `json:"apiKey,omitempty"`
}

// Info is the frontend-facing plugin description. Secrets are never included.
type Info struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Version       string `json:"version"`
	Kind          string `json:"kind"`
	Description   string `json:"description"`
	Author        string `json:"author"`
	Homepage      string `json:"homepage"`
	Source        string `json:"source"`
	License       string `json:"license"`
	Provider      string `json:"provider"`
	Endpoint      string `json:"endpoint"`
	Model         string `json:"model"`
	TargetLang    string `json:"targetLang"`
	Host          string `json:"host"`
	Enabled       bool   `json:"enabled"`
	Default       bool   `json:"default"`
	HasKey        bool   `json:"hasKey"`
	RequiresKey   bool   `json:"requiresKey"`
	HasAppID      bool   `json:"hasAppId"`
	RequiresAppID bool   `json:"requiresAppId"`
	Size          int64  `json:"size"`
}

// Candidate is a validated package waiting for the user to confirm install.
type Candidate struct {
	Token           string `json:"token"`
	ID              string `json:"id"`
	Name            string `json:"name"`
	Version         string `json:"version"`
	Kind            string `json:"kind"`
	Existing        bool   `json:"existing"`
	ExistingVersion string `json:"existingVersion"`
}

type installed struct {
	manifest Manifest
	config   config
	size     int64
	dir      string
}

type staged struct {
	candidate Candidate
	dir       string
}

// Store owns the on-disk plugin directory and the in-memory install cache.
type Store struct {
	root string

	mu      sync.Mutex
	plugins map[string]*installed
	staged  map[string]*staged

	cache *translationCache
}

// New loads installed plugins from root, creating it if needed.
func New(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		root:    root,
		plugins: make(map[string]*installed),
		staged:  make(map[string]*staged),
		cache:   newTranslationCache(200),
	}
	s.cleanupTemp()
	if err := s.scan(); err != nil {
		return s, err
	}
	return s, nil
}

// Dir returns the directory that contains installed plugins.
func (s *Store) Dir() string { return s.root }

func (s *Store) scan() error {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dir := filepath.Join(s.root, entry.Name())
		m, err := readManifestFile(filepath.Join(dir, manifestName))
		if err != nil || m.ID != entry.Name() {
			continue
		}
		if err := validateManifest(&m); err != nil {
			continue
		}
		cfg := readConfig(filepath.Join(dir, configName))
		s.plugins[m.ID] = &installed{
			manifest: m,
			config:   cfg,
			size:     dirSize(dir),
			dir:      dir,
		}
	}
	return nil
}

func (s *Store) cleanupTemp() {
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "pdfviewer-plugin-*"))
	for _, m := range matches {
		info, err := os.Stat(m)
		// Only sweep abandoned staging dirs; a second running instance may
		// still be preparing an install.
		if err == nil && info.IsDir() && time.Since(info.ModTime()) > time.Hour {
			_ = os.RemoveAll(m)
		}
	}
}

// List returns all installed plugins. At most one plugin per kind is marked
// as the default; when no explicit default is stored, the first enabled
// plugin of that kind is used.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}

func (s *Store) listLocked() []Info {
	defaults := map[string]string{}
	for _, kind := range []string{KindTranslator, KindDictionary} {
		ids := make([]string, 0, len(s.plugins))
		for id, p := range s.plugins {
			if p.manifest.Kind == kind {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			if p := s.plugins[id]; p.config.Default && p.config.Enabled {
				defaults[kind] = id
				break
			}
		}
		if defaults[kind] == "" {
			for _, id := range ids {
				if s.plugins[id].config.Enabled {
					defaults[kind] = id
					break
				}
			}
		}
	}

	out := make([]Info, 0, len(s.plugins))
	for _, p := range s.plugins {
		info := infoOf(p)
		info.Default = defaults[p.manifest.Kind] == p.manifest.ID
		out = append(out, info)
	}
	rank := func(kind string) int {
		if kind == KindTranslator {
			return 0
		}
		return 1
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return rank(out[i].Kind) < rank(out[j].Kind)
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func infoOf(p *installed) Info {
	m := p.manifest
	host := endpointHost(m.Endpoint)
	return Info{
		ID:            m.ID,
		Name:          m.Name,
		Version:       m.Version,
		Kind:          m.Kind,
		Description:   m.Description,
		Author:        m.Author,
		Homepage:      m.Homepage,
		Source:        m.Source,
		License:       m.License,
		Provider:      m.Provider,
		Endpoint:      m.Endpoint,
		Model:         m.Model,
		TargetLang:    m.TargetLang,
		Host:          host,
		Enabled:       p.config.Enabled,
		HasKey:        p.config.APIKey != "",
		RequiresKey:   requiresKey(m),
		HasAppID:      p.config.AppID != "",
		RequiresAppID: requiresAppID(m),
		Size:          p.size,
	}
}

func (s *Store) getLocked(id string) (*installed, error) {
	p, ok := s.plugins[id]
	if !ok {
		return nil, ErrNotFound
	}
	return p, nil
}

// active is a snapshot taken under the store lock, so request goroutines do
// not read config fields while the UI changes them.
type active struct {
	manifest Manifest
	appID    string
	apiKey   string
	dir      string
}

func (s *Store) enabled(id, kind string) (*active, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return nil, err
	}
	if p.manifest.Kind != kind {
		return nil, fmt.Errorf("插件类型不是 %s", kind)
	}
	if !p.config.Enabled {
		return nil, ErrDisabled
	}
	return &active{
		manifest: p.manifest,
		appID:    p.config.AppID,
		apiKey:   p.config.APIKey,
		dir:      p.dir,
	}, nil
}

// SetEnabled toggles a plugin and normalises the default of its kind.
func (s *Store) SetEnabled(id string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return err
	}
	p.config.Enabled = enabled
	if enabled {
		if !s.hasDefaultLocked(p.manifest.Kind) {
			p.config.Default = true
		}
	} else if p.config.Default {
		p.config.Default = false
	}
	return s.writeConfigLocked(p)
}

// SetDefault makes a plugin the default for its kind and enables it.
func (s *Store) SetDefault(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return err
	}
	for _, other := range s.plugins {
		if other.manifest.Kind == p.manifest.Kind && other.manifest.ID != id {
			other.config.Default = false
		}
	}
	p.config.Default = true
	p.config.Enabled = true
	for _, other := range s.plugins {
		if other.manifest.Kind == p.manifest.Kind {
			if err := s.writeConfigLocked(other); err != nil {
				return err
			}
		}
	}
	return nil
}

// SetKey stores or clears the API key of a plugin.
func (s *Store) SetKey(id, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return err
	}
	p.config.APIKey = strings.TrimSpace(key)
	return s.writeConfigLocked(p)
}

// SetCredentials stores the two-part credentials used by Baidu and Youdao.
// Going through one method keeps the config file write atomic.
func (s *Store) SetCredentials(id, appID, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return err
	}
	p.config.AppID = strings.TrimSpace(appID)
	p.config.APIKey = strings.TrimSpace(key)
	return s.writeConfigLocked(p)
}

func (s *Store) hasDefaultLocked(kind string) bool {
	for _, p := range s.plugins {
		if p.manifest.Kind == kind && p.config.Default && p.config.Enabled {
			return true
		}
	}
	return false
}

func (s *Store) writeConfigLocked(p *installed) error {
	raw, err := json.MarshalIndent(p.config, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(p.dir, configName+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(p.dir, configName))
}

// Remove uninstalls a plugin and its configuration, including any API key.
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.getLocked(id)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(p.dir); err != nil {
		return err
	}
	delete(s.plugins, id)
	return nil
}

// Stage unpacks and validates a .pdfplugin without installing it.
func (s *Store) Stage(zipPath string) (*Candidate, error) {
	file, err := os.Open(zipPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > maxDictionaryBytes+maxTranslatorBytes {
		return nil, fmt.Errorf("%w: 插件包过大", ErrInvalidPackage)
	}
	zr, err := zip.NewReader(file, info.Size())
	if err != nil {
		return nil, fmt.Errorf("%w: 不是合法的 zip 文件", ErrInvalidPackage)
	}
	if len(zr.File) > maxZipEntries {
		return nil, fmt.Errorf("%w: 文件数量过多", ErrInvalidPackage)
	}
	rawManifest, err := readZipManifest(zr)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(rawManifest, &m); err != nil {
		return nil, fmt.Errorf("%w: manifest.json 无法解析", ErrInvalidPackage)
	}
	if err := validateManifest(&m); err != nil {
		return nil, err
	}

	limit := int64(maxTranslatorBytes)
	if m.Kind == KindDictionary {
		limit = maxDictionaryBytes
	}
	dir, err := os.MkdirTemp("", "pdfviewer-plugin-")
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(dir)
		}
	}()
	if err := extractZip(zr, dir, limit); err != nil {
		return nil, err
	}
	if err := validateData(&m, dir); err != nil {
		return nil, err
	}

	token, err := newToken()
	if err != nil {
		return nil, err
	}
	candidate := Candidate{
		Token:   token,
		ID:      m.ID,
		Name:    m.Name,
		Version: m.Version,
		Kind:    m.Kind,
	}
	s.mu.Lock()
	if existing, ok := s.plugins[m.ID]; ok {
		candidate.Existing = true
		candidate.ExistingVersion = existing.manifest.Version
	}
	s.staged[token] = &staged{candidate: candidate, dir: dir}
	s.mu.Unlock()
	cleanup = false
	return &candidate, nil
}

// Commit installs a previously staged package. The caller must have
// confirmed replacement when the candidate has Existing set.
func (s *Store) Commit(token string) (Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.staged[token]
	if !ok {
		return Info{}, fmt.Errorf("%w: 安装已过期，请重新选择文件", ErrInvalidPackage)
	}
	cleanupStaged := func() {
		_ = os.RemoveAll(st.dir)
		delete(s.staged, token)
	}
	if existing, ok := s.plugins[st.candidate.ID]; ok {
		if compareVersion(st.candidate.Version, existing.manifest.Version) < 0 {
			cleanupStaged()
			return Info{}, fmt.Errorf("%w: 已安装 %s，新包为 %s", ErrVersionTooOld, existing.manifest.Version, st.candidate.Version)
		}
	}

	target := filepath.Join(s.root, st.candidate.ID)
	tmpNew := filepath.Join(s.root, ".new-"+st.candidate.ID+"-"+token)
	backup := filepath.Join(s.root, ".old-"+st.candidate.ID+"-"+token)
	_ = os.RemoveAll(tmpNew)
	if err := os.Rename(st.dir, tmpNew); err != nil {
		if err := copyTree(st.dir, tmpNew); err != nil {
			return Info{}, err
		}
	}
	var oldConfig config
	if existing, ok := s.plugins[st.candidate.ID]; ok {
		oldConfig = existing.config
		if err := os.Rename(target, backup); err != nil {
			_ = os.RemoveAll(tmpNew)
			cleanupStaged()
			return Info{}, err
		}
	}
	if err := os.Rename(tmpNew, target); err != nil {
		if _, ok := s.plugins[st.candidate.ID]; ok {
			_ = os.Rename(backup, target)
		}
		_ = os.RemoveAll(tmpNew)
		cleanupStaged()
		return Info{}, err
	}
	_ = os.RemoveAll(backup)

	m, err := readManifestFile(filepath.Join(target, manifestName))
	if err != nil {
		return Info{}, err
	}
	p := &installed{manifest: m, config: oldConfig, size: dirSize(target), dir: target}
	if err := s.writeConfigLocked(p); err != nil {
		return Info{}, err
	}
	s.plugins[m.ID] = p
	cleanupStaged()
	return infoOf(p), nil
}

// Cancel removes a staged package.
func (s *Store) Cancel(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, ok := s.staged[token]; ok {
		_ = os.RemoveAll(st.dir)
		delete(s.staged, token)
	}
}

func newToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func readZipManifest(zr *zip.Reader) ([]byte, error) {
	for _, f := range zr.File {
		name := strings.TrimPrefix(strings.ReplaceAll(f.Name, "\\", "/"), "./")
		if name != manifestName {
			continue
		}
		if f.FileInfo().IsDir() || f.UncompressedSize64 > maxManifestBytes {
			return nil, fmt.Errorf("%w: manifest.json 过大", ErrInvalidPackage)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		raw, err := io.ReadAll(io.LimitReader(rc, maxManifestBytes+1))
		if err != nil {
			return nil, err
		}
		if len(raw) > maxManifestBytes {
			return nil, fmt.Errorf("%w: manifest.json 过大", ErrInvalidPackage)
		}
		return raw, nil
	}
	return nil, fmt.Errorf("%w: 缺少 manifest.json", ErrInvalidPackage)
}

func extractZip(zr *zip.Reader, dir string, limit int64) error {
	var total int64
	files := 0
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		name = strings.TrimPrefix(name, "./")
		clean := path.Clean(name)
		if clean == "." {
			continue
		}
		if strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") ||
			(len(clean) >= 2 && clean[1] == ':') {
			return fmt.Errorf("%w: 非法文件路径", ErrInvalidPackage)
		}
		rel := filepath.FromSlash(clean)
		if rel == configName {
			return fmt.Errorf("%w: 保留了内部文件名 %s", ErrInvalidPackage, configName)
		}
		dst := filepath.Join(dir, rel)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: 不允许符号链接", ErrInvalidPackage)
		}
		files++
		if files > maxZipEntries {
			return fmt.Errorf("%w: 文件数量过多", ErrInvalidPackage)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			rc.Close()
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(rc, limit-total+1))
		closeErr := out.Close()
		rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		total += n
		if total > limit {
			return fmt.Errorf("%w: 解压后超过 %d MB 上限", ErrInvalidPackage, limit>>20)
		}
	}
	return nil
}

func readManifestFile(name string) (Manifest, error) {
	raw, err := os.ReadFile(name)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

func readConfig(name string) config {
	var cfg config
	raw, err := os.ReadFile(name)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(raw, &cfg)
	return cfg
}

func validateManifest(m *Manifest) error {
	m.ID = strings.TrimSpace(m.ID)
	m.Name = strings.TrimSpace(m.Name)
	m.Version = strings.TrimSpace(m.Version)
	m.Kind = strings.TrimSpace(m.Kind)
	if !idPattern.MatchString(m.ID) {
		return fmt.Errorf("%w: id 只能包含小写字母、数字、点、下划线和短横线（≤64 字符）", ErrInvalidPackage)
	}
	if m.Name == "" || len([]rune(m.Name)) > 80 {
		return fmt.Errorf("%w: name 缺失或过长", ErrInvalidPackage)
	}
	if !versionPattern.MatchString(m.Version) {
		return fmt.Errorf("%w: version 需为 1.2.3 形式", ErrInvalidPackage)
	}
	switch m.Kind {
	case KindTranslator:
		m.Provider = strings.TrimSpace(strings.ToLower(m.Provider))
		switch m.Provider {
		case ProviderOpenAI, ProviderDeepL, ProviderGoogle, ProviderBaidu, ProviderBaiduLLM, ProviderYoudao:
		default:
			return fmt.Errorf("%w: 不支持的 provider %q", ErrInvalidPackage, m.Provider)
		}
		m.Endpoint = strings.TrimSpace(m.Endpoint)
		if err := validateEndpoint(m.Endpoint); err != nil {
			return err
		}
		if m.Provider == ProviderOpenAI && strings.TrimSpace(m.Model) == "" {
			return fmt.Errorf("%w: openai 插件需要 model", ErrInvalidPackage)
		}
		if m.TargetLang == "" {
			switch m.Provider {
			case ProviderDeepL:
				m.TargetLang = "ZH-HANS"
			case ProviderBaidu, ProviderBaiduLLM:
				m.TargetLang = "zh"
			case ProviderYoudao:
				m.TargetLang = "zh-CHS"
			default:
				m.TargetLang = "zh-CN"
			}
		}
	case KindDictionary:
		m.Data = strings.TrimSpace(m.Data)
		if m.Data == "" {
			return fmt.Errorf("%w: 词典插件需要 data 字段", ErrInvalidPackage)
		}
		clean := path.Clean(strings.ReplaceAll(m.Data, "\\", "/"))
		if strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") ||
			(len(clean) >= 2 && clean[1] == ':') || clean == configName {
			return fmt.Errorf("%w: 非法的 data 路径", ErrInvalidPackage)
		}
		m.Data = clean
		m.Endpoint = ""
		m.Provider = ""
	default:
		return fmt.Errorf("%w: kind 必须是 translator 或 dictionary", ErrInvalidPackage)
	}
	return nil
}

func validateEndpoint(raw string) error {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%w: endpoint 不是合法 URL", ErrInvalidPackage)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname())) {
		return fmt.Errorf("%w: endpoint 必须使用 https（本机地址可用 http）", ErrInvalidPackage)
	}
	if u.User != nil {
		return fmt.Errorf("%w: endpoint 不能包含账号信息", ErrInvalidPackage)
	}
	if u.Fragment != "" {
		return fmt.Errorf("%w: endpoint 不能包含 #fragment", ErrInvalidPackage)
	}
	return nil
}

func validateData(m *Manifest, dir string) error {
	if m.Kind != KindDictionary {
		return nil
	}
	full := filepath.Join(dir, filepath.FromSlash(m.Data))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		return fmt.Errorf("%w: 缺少词典数据 %s", ErrInvalidPackage, m.Data)
	}
	if info.Size() > maxDictionaryBytes {
		return fmt.Errorf("%w: 词典数据超过 300 MB", ErrInvalidPackage)
	}
	return validateDictionaryDB(full)
}

func endpointHost(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func requiresKey(m Manifest) bool {
	switch m.Provider {
	case ProviderGoogle:
		return false
	case ProviderBaidu, ProviderBaiduLLM, ProviderYoudao:
		return true
	case ProviderOpenAI, ProviderDeepL:
		host := endpointHost(m.Endpoint)
		return !isLoopback(host)
	default:
		return false
	}
}

func requiresAppID(m Manifest) bool {
	return m.Provider == ProviderBaidu || m.Provider == ProviderBaiduLLM || m.Provider == ProviderYoudao
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func compareVersion(a, b string) int {
	strip := func(v string) string {
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			return v[:i]
		}
		return v
	}
	as := strings.Split(strip(a), ".")
	bs := strings.Split(strip(b), ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		av, bv := 0, 0
		if i < len(as) {
			av, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			bv, _ = strconv.Atoi(bs[i])
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
	}
	return 0
}

func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func copyTree(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil || rel == "." {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		inErr := in.Close()
		outErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if inErr != nil {
			return inErr
		}
		return outErr
	})
}
