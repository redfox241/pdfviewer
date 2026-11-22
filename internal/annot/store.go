// Package annot stores reading state and annotations in a sidecar JSON file
// next to the document, falling back to the application support directory for
// read-only locations. The original PDF is never modified.
package annot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	SchemaVersion = 1
	MaxSidecar    = 20 << 20 // 20 MiB
	MaxAnnots     = 50000
	MaxPages      = 200000
	suffix        = ".pdfviewer.json"
)

var (
	writeMu sync.Mutex
	known   = map[string]struct{}{
		"highlight": {},
		"underline": {},
		"strikeout": {},
		"ink":       {},
		"redact":    {},
		"note":      {},
		"box":       {},
	}
)

// Data mirrors schema v1 of the sidecar file.
type Data struct {
	Schema      int               `json:"schema"`
	Doc         Doc               `json:"doc"`
	Reading     Reading           `json:"reading"`
	Annotations []json.RawMessage `json:"annotations"`
}

type Doc struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Fingerprint string `json:"fingerprint"`
	Pages       int    `json:"pages"`
}

type Reading struct {
	LastPage    int     `json:"lastPage"`
	ScrollRatio float64 `json:"scrollRatio"`
	Zoom        float64 `json:"zoom"`
	ViewMode    string  `json:"viewMode"`
	ReadPages   []int   `json:"readPages"`
	UpdatedAt   string  `json:"updatedAt"`
}

// LoadResult is returned to the frontend on open.
type LoadResult struct {
	Data        string `json:"data"`
	Path        string `json:"path"`
	Portable    bool   `json:"portable"`
	Fingerprint string `json:"fingerprint"`
	Warning     string `json:"warning"`
}

// AdjacentPath returns the default sidecar path for a document.
func AdjacentPath(pdfPath string) string {
	return pdfPath + suffix
}

// Fingerprint identifies a document cheaply but robustly enough to detect a
// replaced file: size + mtime + hash of the first MiB.
func Fingerprint(pdfPath string) (string, error) {
	f, err := os.Open(pdfPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return "", err
	}

	h := sha256.New()
	if _, err := io.CopyN(h, f, 1<<20); err != nil && err != io.EOF {
		return "", err
	}

	return fmt.Sprintf("%d:%d:%s", info.Size(), info.ModTime().Unix(), hex.EncodeToString(h.Sum(nil))), nil
}

// Load reads an existing sidecar, if any. A corrupt sidecar is reported in
// Warning and treated as absent so reading can continue.
func Load(pdfPath, fallbackRoot string) (LoadResult, error) {
	fp, err := Fingerprint(pdfPath)
	if err != nil {
		return LoadResult{}, err
	}

	res := LoadResult{Fingerprint: fp}
	adj := AdjacentPath(pdfPath)

	candidates := []struct {
		path     string
		portable bool
	}{
		{adj, true},
		{centralPath(pdfPath, fallbackRoot), false},
	}

	for _, c := range candidates {
		raw, err := os.ReadFile(c.path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			res.Warning = "无法读取标注文件：" + err.Error()
			return res, nil
		}
		if err := Validate(raw); err != nil {
			res.Warning = "标注文件格式无效，已忽略：" + err.Error()
			return res, nil
		}
		res.Data = string(raw)
		res.Path = c.path
		res.Portable = c.portable
		return res, nil
	}

	// Nothing exists yet: decide where the first save will go.
	target, portable := targetPath(pdfPath, fallbackRoot)
	res.Path = target
	res.Portable = portable
	return res, nil
}

// Save validates and atomically writes the sidecar, keeping one backup.
func Save(pdfPath, fallbackRoot string, raw []byte) (string, error) {
	if len(raw) > MaxSidecar {
		return "", fmt.Errorf("标注数据超过 %d MB 上限", MaxSidecar>>20)
	}
	if err := Validate(raw); err != nil {
		return "", err
	}

	target, _ := targetPath(pdfPath, fallbackRoot)

	writeMu.Lock()
	defer writeMu.Unlock()

	if err := writeAtomic(target, raw); err != nil {
		return "", err
	}
	return target, nil
}

func targetPath(pdfPath, fallbackRoot string) (string, bool) {
	adj := AdjacentPath(pdfPath)
	if _, err := os.Stat(adj); err == nil {
		return adj, true
	}
	if dirWritable(filepath.Dir(pdfPath)) {
		return adj, true
	}
	return centralPath(pdfPath, fallbackRoot), false
}

func centralPath(pdfPath, fallbackRoot string) string {
	fp, err := Fingerprint(pdfPath)
	if err != nil {
		fp = pdfPath
	}
	sum := sha256.Sum256([]byte(fp))
	return filepath.Join(fallbackRoot, "notes", hex.EncodeToString(sum[:16])+".json")
}

func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".pvwrite-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// Validate checks the schema envelope and annotation headers.
func Validate(raw []byte) error {
	if len(raw) > MaxSidecar {
		return fmt.Errorf("文件过大")
	}

	var d Data
	if err := json.Unmarshal(raw, &d); err != nil {
		return fmt.Errorf("JSON 解析失败: %w", err)
	}
	if d.Schema < 1 || d.Schema > SchemaVersion {
		return fmt.Errorf("不支持的版本 %d", d.Schema)
	}
	if len(d.Annotations) > MaxAnnots {
		return fmt.Errorf("标注数量过多")
	}
	if d.Doc.Pages < 0 || d.Doc.Pages > MaxPages {
		return fmt.Errorf("页数非法")
	}
	if len(d.Reading.ReadPages) > MaxPages {
		return fmt.Errorf("已读页数非法")
	}

	for i, item := range d.Annotations {
		var head struct {
			ID   string `json:"id"`
			Type string `json:"type"`
			Page int    `json:"page"`
		}
		if err := json.Unmarshal(item, &head); err != nil {
			return fmt.Errorf("第 %d 条标注无效: %w", i+1, err)
		}
		if head.ID == "" {
			return fmt.Errorf("第 %d 条标注缺少 id", i+1)
		}
		if _, ok := known[head.Type]; !ok {
			return fmt.Errorf("第 %d 条标注类型未知: %s", i+1, head.Type)
		}
		if head.Page < 1 {
			return fmt.Errorf("第 %d 条标注页码无效", i+1)
		}
	}

	// Reject trailing garbage to keep files strict.
	dec := json.NewDecoder(bytes.NewReader(raw))
	var probe any
	if err := dec.Decode(&probe); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("JSON 尾部存在多余内容")
	}
	return nil
}

func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	if old, err := os.ReadFile(path); err == nil {
		if err := writeFileAtomic(path+".bak", old); err != nil {
			return fmt.Errorf("写入备份失败: %w", err)
		}
	}

	if err := writeFileAtomic(path, data); err != nil {
		return err
	}
	return nil
}

func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".pvnote-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)

	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil && !strings.Contains(err.Error(), "not supported") {
		return err
	}
	return os.Rename(tmp, path)
}
