// Package annot defines the portable .pdfviewer.json format (schema v1) and
// helpers for validating and exporting it. Reading state and annotations are
// normally stored in the SQLite library; the sidecar is used for imports and
// explicit exports.
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
)

const (
	SchemaVersion = 1
	MaxSidecar    = 20 << 20 // 20 MiB
	MaxAnnots     = 50000
	MaxPages      = 200000
	suffix        = ".pdfviewer.json"
)

var (
	known = map[string]struct{}{
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
// Fingerprint identifies a document by content, not by metadata: size plus a
// SHA-256 over the first and last MiB. mtime is deliberately excluded so that
// copying or restoring a PDF does not orphan its reading data.
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

	const chunk = 1 << 20
	h := sha256.New()
	if info.Size() <= 2*chunk {
		// Small files are cheap to hash completely and avoid ambiguity.
		if _, err := io.Copy(h, f); err != nil {
			return "", err
		}
	} else {
		if _, err := io.CopyN(h, f, chunk); err != nil {
			return "", err
		}
		if _, err := f.Seek(-chunk, io.SeekEnd); err != nil {
			return "", err
		}
		if _, err := io.CopyN(h, f, chunk); err != nil {
			return "", err
		}
	}

	return fmt.Sprintf("%d:%s", info.Size(), hex.EncodeToString(h.Sum(nil))), nil
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
	if d.Doc.Pages < 0 || d.Doc.Pages > MaxPages {
		return fmt.Errorf("页数非法")
	}
	if err := ValidateReading(d.Reading); err != nil {
		return err
	}
	if err := ValidateAnnotations(d.Annotations); err != nil {
		return err
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

// ValidateReading checks the reading-state part of a sidecar payload.
func ValidateReading(r Reading) error {
	if len(r.ReadPages) > MaxPages {
		return fmt.Errorf("已读页数非法")
	}
	if r.LastPage < 0 || r.LastPage > MaxPages {
		return fmt.Errorf("页码非法")
	}
	if r.Zoom < -100 || r.Zoom > 100 {
		return fmt.Errorf("缩放比例非法")
	}
	return nil
}

// ValidateAnnotations checks the annotation envelopes of a sidecar payload.
func ValidateAnnotations(items []json.RawMessage) error {
	if len(items) > MaxAnnots {
		return fmt.Errorf("标注数量过多")
	}
	for i, item := range items {
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
	return nil
}

// ReadAdjacent returns the portable sidecar sitting next to the PDF, if any.
func ReadAdjacent(pdfPath string) ([]byte, bool, error) {
	raw, err := os.ReadFile(AdjacentPath(pdfPath))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return raw, true, nil
}

// ReadLegacyCentral locates the pre-SQLite fallback sidecar for a document.
// It reproduces the historical path hash (size + mtime + head hash) so that
// documents stored in read-only folders keep their state after the upgrade.
func ReadLegacyCentral(pdfPath, fallbackRoot string) ([]byte, bool, error) {
	fp, err := legacyFingerprint(pdfPath)
	if err != nil {
		return nil, false, err
	}
	sum := sha256.Sum256([]byte(fp))
	path := filepath.Join(fallbackRoot, "notes", hex.EncodeToString(sum[:16])+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return raw, true, nil
}

func legacyFingerprint(pdfPath string) (string, error) {
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

// WritePortable writes an explicit export next to the PDF. Unlike Save it
// never falls back to the application support directory and keeps no .bak:
// exporting is a deliberate user action, not a high-frequency autosave.
func WritePortable(pdfPath string, raw []byte) (string, error) {
	if len(raw) > MaxSidecar {
		return "", fmt.Errorf("标注数据超过 %d MB 上限", MaxSidecar>>20)
	}
	if err := Validate(raw); err != nil {
		return "", err
	}
	target := AdjacentPath(pdfPath)
	if err := writeFileAtomic(target, raw); err != nil {
		return "", err
	}
	return target, nil
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
