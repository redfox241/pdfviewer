// Package library keeps the recent-documents list.
package library

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const maxEntries = 30

type Entry struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	Pages      int     `json:"pages"`
	Progress   float64 `json:"progress"`   // 0..1
	LastOpened int64   `json:"lastOpened"` // unix milliseconds
}

type Store struct {
	mu      sync.Mutex
	path    string
	entries []Entry
}

func New(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "recent.json")}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	_ = json.Unmarshal(raw, &s.entries)
	return s, nil
}

// List returns existing documents, newest first.
func (s *Store) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]Entry, 0, len(s.entries))
	for _, e := range s.entries {
		if st, err := os.Stat(e.Path); err == nil && !st.IsDir() {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].LastOpened > out[j].LastOpened
	})
	if len(out) > maxEntries {
		out = out[:maxEntries]
	}
	s.entries = out
	return append([]Entry{}, out...)
}

func (s *Store) Touch(path, name string, pages int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.entries {
		if s.entries[i].Path == path {
			s.entries[i].Name = name
			s.entries[i].Pages = pages
			s.entries[i].LastOpened = time.Now().UnixMilli()
			s.persistLocked()
			return
		}
	}

	s.entries = append([]Entry{{
		Path:       path,
		Name:       name,
		Pages:      pages,
		LastOpened: time.Now().UnixMilli(),
	}}, s.entries...)
	if len(s.entries) > maxEntries {
		s.entries = s.entries[:maxEntries]
	}
	s.persistLocked()
}

func (s *Store) SetProgress(path string, pages int, progress float64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.entries {
		if s.entries[i].Path == path {
			if pages > 0 {
				s.entries[i].Pages = pages
			}
			s.entries[i].Progress = progress
			s.persistLocked()
			return
		}
	}
}

func (s *Store) Remove(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := s.entries[:0]
	for _, e := range s.entries {
		if e.Path != path {
			out = append(out, e)
		}
	}
	s.entries = out
	s.persistLocked()
}

func (s *Store) persistLocked() {
	raw, err := json.MarshalIndent(s.entries, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) == nil {
		_ = os.Rename(tmp, s.path)
	}
}
