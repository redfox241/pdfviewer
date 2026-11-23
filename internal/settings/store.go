// Package settings persists user preferences as JSON in the app config dir.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Settings is the on-disk preference document.
type Settings struct {
	Theme          string `json:"theme"`          // system | light | dark
	DefaultZoom    string `json:"defaultZoom"`    // fit-width | fit-page | actual
	AutoRead       bool   `json:"autoRead"`       // mark pages read after dwell
	ReadDwellSec   int    `json:"readDwellSec"`   // seconds a page must stay visible
	HighlightColor string `json:"highlightColor"` // default highlighter colour
	NightMode      bool   `json:"nightMode"`      // invert page canvas
	Language       string `json:"language"`       // zh | en

	PrintIncludeAnnotations bool   `json:"printIncludeAnnotations"`
	PrintRangeMode          string `json:"printRangeMode"` // all | current | custom
	PrintOnlyAnnotated      bool   `json:"printOnlyAnnotated"`
	PrintConfigured         bool   `json:"printConfigured"`
}

func Defaults() Settings {
	return Settings{
		Theme:          "system",
		DefaultZoom:    "fit-width",
		AutoRead:       true,
		ReadDwellSec:   3,
		HighlightColor: "#ffd84d",
		NightMode:      false,
		Language:       "zh",

		PrintIncludeAnnotations: true,
		PrintRangeMode:          "all",
		PrintOnlyAnnotated:      false,
		PrintConfigured:         true,
	}
}

type Store struct {
	mu   sync.RWMutex
	path string
	val  Settings
}

func New(dir string) (*Store, error) {
	s := &Store{
		path: filepath.Join(dir, "settings.json"),
		val:  Defaults(),
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.val); err != nil {
		// Keep defaults, but do not destroy the unreadable file.
		s.val = Defaults()
	}
	s.normalize()
	return s, nil
}

func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.val
}

func (s *Store) Set(v Settings) error {
	v = normalize(v)
	s.mu.Lock()
	s.val = v
	s.mu.Unlock()
	return s.persist(v)
}

func (s *Store) persist(v Settings) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) normalize() {
	s.mu.Lock()
	s.val = normalize(s.val)
	s.mu.Unlock()
}

func normalize(v Settings) Settings {
	d := Defaults()
	switch v.Theme {
	case "light", "dark", "system":
	default:
		v.Theme = d.Theme
	}
	switch v.DefaultZoom {
	case "fit-width", "fit-page", "actual":
	default:
		v.DefaultZoom = d.DefaultZoom
	}
	if v.ReadDwellSec < 1 || v.ReadDwellSec > 60 {
		v.ReadDwellSec = d.ReadDwellSec
	}
	if v.HighlightColor == "" {
		v.HighlightColor = d.HighlightColor
	}
	if v.Language != "en" {
		v.Language = "zh"
	}
	// Settings written before printing existed have no print fields. The
	// bool cannot distinguish "missing" from "false", so a one-time marker
	// upgrades them with the documented defaults.
	if !v.PrintConfigured {
		v.PrintIncludeAnnotations = true
		v.PrintRangeMode = "all"
		v.PrintOnlyAnnotated = false
		v.PrintConfigured = true
	}
	switch v.PrintRangeMode {
	case "all", "current", "custom":
	default:
		v.PrintRangeMode = "all"
	}
	return v
}
