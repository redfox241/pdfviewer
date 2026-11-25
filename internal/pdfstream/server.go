// Package pdfstream serves locally opened PDF files to the WebView over HTTP
// with range-request support, so that pdf.js can stream large documents
// instead of copying the whole file into JavaScript memory.
package pdfstream

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Server maps opaque tokens to absolute paths and serves them under /pdf/.
type Server struct {
	mu    sync.RWMutex
	docs  map[string]string
	paths map[string]string
}

func New() *Server {
	return &Server{
		docs:  make(map[string]string),
		paths: make(map[string]string),
	}
}

// Add registers a PDF path and returns a fresh access token.
// Registering the same path twice invalidates the previous token.
func (s *Server) Add(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory", abs)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", abs)
	}

	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)

	s.mu.Lock()
	if old, ok := s.paths[abs]; ok {
		delete(s.docs, old)
	}
	s.docs[token] = abs
	s.paths[abs] = token
	s.mu.Unlock()

	return token, nil
}

// Remove invalidates a token.
func (s *Server) Remove(token string) {
	s.mu.Lock()
	if path, ok := s.docs[token]; ok {
		delete(s.docs, token)
		delete(s.paths, path)
	}
	s.mu.Unlock()
}

// Path resolves a token to its file path.
func (s *Server) Path(token string) (string, bool) {
	s.mu.RLock()
	path, ok := s.docs[token]
	s.mu.RUnlock()
	return path, ok
}

// ServeHTTP implements the asset-server fallback handler for /pdf/<token>.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const prefix = "/pdf/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}

	token := strings.TrimPrefix(r.URL.Path, prefix)
	path, ok := s.Path(token)
	if !ok {
		http.Error(w, "document not opened", http.StatusForbidden)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "cannot open document", http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "cannot stat document", http.StatusInternalServerError)
		return
	}
	if !info.Mode().IsRegular() {
		http.Error(w, "not a regular file", http.StatusForbidden)
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/pdf")
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")

	// ServeContent handles Range, If-Modified-Since and Content-Disposition.
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}
