// Package notestore persists reading state and annotations in a central
// SQLite database (WAL). The portable .pdfviewer.json format is only used for
// explicit export/import, so normal reading never creates sidecar files.
package notestore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"pdfviewer/internal/annot"
)

// Store is a small SQLite-backed library of per-document reading state.
type Store struct {
	db   *sql.DB
	path string
	mu   sync.Mutex // serialize writers; sql.DB has a single connection anyway
}

// State is everything needed to restore a document.
type State struct {
	Reading     annot.Reading
	Annotations []json.RawMessage
	Pages       int
	HasData     bool
}

var schema = []string{
	`CREATE TABLE IF NOT EXISTS documents (
		doc_id      INTEGER PRIMARY KEY,
		content_id  TEXT NOT NULL UNIQUE,
		path        TEXT NOT NULL,
		name        TEXT NOT NULL,
		size        INTEGER NOT NULL,
		pages       INTEGER NOT NULL DEFAULT 0,
		last_opened INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS reading (
		doc_id       INTEGER PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
		last_page    INTEGER NOT NULL DEFAULT 1,
		scroll_ratio REAL NOT NULL DEFAULT 0,
		zoom         REAL NOT NULL DEFAULT 0,
		view_mode    TEXT NOT NULL DEFAULT 'continuous',
		updated_at   TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS read_pages (
		doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
		page   INTEGER NOT NULL,
		PRIMARY KEY (doc_id, page)
	)`,
	`CREATE TABLE IF NOT EXISTS annotations (
		id         TEXT NOT NULL,
		doc_id     INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
		page       INTEGER NOT NULL,
		type       TEXT NOT NULL,
		payload    TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (doc_id, id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_annotations_doc_page ON annotations(doc_id, page)`,
}

const schemaVersion = 2

// New opens (or creates) library.db inside dir.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)
	return open(filepath.Join(dir, "library.db"))
}

// NewMemory returns a throwaway store, used as a last-resort fallback.
func NewMemory() (*Store, error) {
	return open(":memory:")
}

func open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}

	s := &Store{db: db, path: path}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if path != ":memory:" {
		for _, p := range []string{path, path + "-wal", path + "-shm"} {
			_ = os.Chmod(p, 0o600)
		}
	}
	return s, nil
}

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return fmt.Errorf("不支持的数据库版本 %d", version)
	}
	switch version {
	case 0:
		for _, stmt := range schema {
			if _, err := s.db.Exec(stmt); err != nil {
				return err
			}
		}
		if _, err := s.db.Exec(fmt.Sprintf("PRAGMA user_version=%d", schemaVersion)); err != nil {
			return err
		}
	case 1:
		return s.migrateAnnotationsV2()
	}
	return nil
}

// migrateAnnotationsV2 scopes annotation ids to their document. Version 1 used
// a globally unique id, so a sidecar for one document could overwrite or move
// another document's annotation.
func (s *Store) migrateAnnotationsV2() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, stmt := range []string{
		`DROP TABLE IF EXISTS annotations_v2`,
		`CREATE TABLE annotations_v2 (
			id         TEXT NOT NULL,
			doc_id     INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
			page       INTEGER NOT NULL,
			type       TEXT NOT NULL,
			payload    TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (doc_id, id)
		)`,
		`INSERT INTO annotations_v2(id, doc_id, page, type, payload, created_at, updated_at)
		 SELECT id, doc_id, page, type, payload, created_at, updated_at FROM annotations`,
		`DROP TABLE annotations`,
		`ALTER TABLE annotations_v2 RENAME TO annotations`,
		`CREATE INDEX IF NOT EXISTS idx_annotations_doc_page ON annotations(doc_id, page)`,
		fmt.Sprintf("PRAGMA user_version=%d", schemaVersion),
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("迁移标注表失败: %w", err)
		}
	}
	return tx.Commit()
}

// Path is the database file location.
func (s *Store) Path() string { return s.path }

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// UpsertDocument maps a content fingerprint to a stable doc_id and refreshes
// its path/name (so moving or renaming the PDF does not lose its notes).
func (s *Store) UpsertDocument(path, name string, size int64, contentID string, pages int) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	var id int64
	err := s.db.QueryRow(`SELECT doc_id FROM documents WHERE content_id = ?`, contentID).Scan(&id)
	if err == sql.ErrNoRows {
		res, err := s.db.Exec(
			`INSERT INTO documents(content_id, path, name, size, pages, last_opened) VALUES(?,?,?,?,?,?)`,
			contentID, path, name, size, pages, now,
		)
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	}
	if err != nil {
		return 0, err
	}
	_, err = s.db.Exec(
		`UPDATE documents SET path = ?, name = ?, size = ?, last_opened = ? WHERE doc_id = ?`,
		path, name, size, now, id,
	)
	return id, err
}

// IsEmpty reports whether the document has no reading state or annotations.
func (s *Store) IsEmpty(docID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT (SELECT COUNT(*) FROM reading WHERE doc_id = ?)
		      + (SELECT COUNT(*) FROM annotations WHERE doc_id = ?)
		      + (SELECT COUNT(*) FROM read_pages WHERE doc_id = ?)`,
		docID, docID, docID,
	).Scan(&n)
	return n == 0, err
}

// Load returns the stored state, or an initial reading state when empty.
func (s *Store) Load(docID int64) (State, error) {
	st := State{Reading: annot.Reading{LastPage: 1, ViewMode: "continuous"}}

	var pages int
	if err := s.db.QueryRow(`SELECT pages FROM documents WHERE doc_id = ?`, docID).Scan(&pages); err != nil {
		return st, err
	}
	st.Pages = pages

	var lastPage int
	var ratio, zoom float64
	var mode, updated string
	err := s.db.QueryRow(
		`SELECT last_page, scroll_ratio, zoom, view_mode, updated_at FROM reading WHERE doc_id = ?`,
		docID,
	).Scan(&lastPage, &ratio, &zoom, &mode, &updated)
	switch {
	case err == nil:
		st.HasData = true
		if lastPage > 0 {
			st.Reading.LastPage = lastPage
		}
		st.Reading.ScrollRatio = ratio
		st.Reading.Zoom = zoom
		if mode != "" {
			st.Reading.ViewMode = mode
		}
		st.Reading.UpdatedAt = updated
	case err != sql.ErrNoRows:
		return st, err
	}

	rows, err := s.db.Query(`SELECT page FROM read_pages WHERE doc_id = ? ORDER BY page`, docID)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var p int
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return st, err
		}
		st.Reading.ReadPages = append(st.Reading.ReadPages, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return st, err
	}
	rows.Close()
	if len(st.Reading.ReadPages) > 0 {
		st.HasData = true
	}

	annRows, err := s.db.Query(
		`SELECT payload FROM annotations WHERE doc_id = ? ORDER BY created_at, id`, docID,
	)
	if err != nil {
		return st, err
	}
	for annRows.Next() {
		var payload string
		if err := annRows.Scan(&payload); err != nil {
			annRows.Close()
			return st, err
		}
		st.Annotations = append(st.Annotations, json.RawMessage(payload))
	}
	if err := annRows.Err(); err != nil {
		annRows.Close()
		return st, err
	}
	annRows.Close()
	if len(st.Annotations) > 0 {
		st.HasData = true
	}
	return st, nil
}

// SaveReading updates only the small reading-state rows. This is the hot path
// (page turns / scroll idle) and never rewrites annotations.
func (s *Store) SaveReading(docID int64, r annot.Reading, pages int) error {
	if err := annot.ValidateReading(r); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := saveReadingTx(tx, docID, r, pages); err != nil {
		return err
	}
	return tx.Commit()
}

// SaveAnnotations reconciles the full annotation set in one transaction:
// existing rows are upserted, missing ids are deleted. The frontend only calls
// this when annotations actually change, not while scrolling.
func (s *Store) SaveAnnotations(docID int64, items []json.RawMessage) error {
	if err := annot.ValidateAnnotations(items); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := saveAnnotationsTx(tx, docID, items); err != nil {
		return err
	}
	return tx.Commit()
}

// Import writes a decoded sidecar snapshot in a single transaction.
func (s *Store) Import(docID int64, data annot.Data) error {
	if err := annot.ValidateReading(data.Reading); err != nil {
		return err
	}
	if err := annot.ValidateAnnotations(data.Annotations); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := saveReadingTx(tx, docID, data.Reading, data.Doc.Pages); err != nil {
		return err
	}
	if err := saveAnnotationsTx(tx, docID, data.Annotations); err != nil {
		return err
	}
	return tx.Commit()
}

func saveReadingTx(tx *sql.Tx, docID int64, r annot.Reading, pages int) error {
	updated := r.UpdatedAt
	if updated == "" {
		updated = time.Now().Format(time.RFC3339)
	}
	if _, err := tx.Exec(
		`INSERT INTO reading(doc_id, last_page, scroll_ratio, zoom, view_mode, updated_at)
		 VALUES(?,?,?,?,?,?)
		 ON CONFLICT(doc_id) DO UPDATE SET
		   last_page = excluded.last_page,
		   scroll_ratio = excluded.scroll_ratio,
		   zoom = excluded.zoom,
		   view_mode = excluded.view_mode,
		   updated_at = excluded.updated_at`,
		docID, r.LastPage, r.ScrollRatio, r.Zoom, r.ViewMode, updated,
	); err != nil {
		return err
	}

	// Diff read_pages instead of delete+insert to keep the write set small.
	current := make(map[int]struct{}, len(r.ReadPages))
	rows, err := tx.Query(`SELECT page FROM read_pages WHERE doc_id = ?`, docID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p int
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return err
		}
		current[p] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	seen := make(map[int]struct{}, len(r.ReadPages))
	for _, p := range r.ReadPages {
		if p < 1 {
			continue
		}
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		if _, exists := current[p]; exists {
			delete(current, p)
			continue
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO read_pages(doc_id, page) VALUES(?,?)`, docID, p); err != nil {
			return err
		}
	}
	for p := range current {
		if _, err := tx.Exec(`DELETE FROM read_pages WHERE doc_id = ? AND page = ?`, docID, p); err != nil {
			return err
		}
	}

	if pages > 0 {
		_, err = tx.Exec(`UPDATE documents SET pages = ?, last_opened = ? WHERE doc_id = ?`,
			pages, time.Now().UnixMilli(), docID)
	} else {
		_, err = tx.Exec(`UPDATE documents SET last_opened = ? WHERE doc_id = ?`,
			time.Now().UnixMilli(), docID)
	}
	return err
}

type annotationHead struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Page      int    `json:"page"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func saveAnnotationsTx(tx *sql.Tx, docID int64, items []json.RawMessage) error {
	if len(items) > annot.MaxAnnots {
		return fmt.Errorf("标注数量过多")
	}

	existing := make(map[string]struct{})
	rows, err := tx.Query(`SELECT id FROM annotations WHERE doc_id = ?`, docID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		existing[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	keep := make(map[string]struct{}, len(items))
	for i, item := range items {
		var head annotationHead
		if err := json.Unmarshal(item, &head); err != nil {
			return fmt.Errorf("第 %d 条标注无效: %w", i+1, err)
		}
		if _, dup := keep[head.ID]; dup {
			return fmt.Errorf("第 %d 条标注 id 重复: %s", i+1, head.ID)
		}
		keep[head.ID] = struct{}{}
		payload := strings.TrimSpace(string(item))
		if _, err := tx.Exec(
			`INSERT INTO annotations(id, doc_id, page, type, payload, created_at, updated_at)
			 VALUES(?,?,?,?,?,?,?)
			 ON CONFLICT(doc_id, id) DO UPDATE SET
			   page = excluded.page,
			   type = excluded.type,
			   payload = excluded.payload,
			   updated_at = excluded.updated_at`,
			head.ID, docID, head.Page, head.Type, payload, head.CreatedAt, head.UpdatedAt,
		); err != nil {
			return err
		}
	}

	for id := range existing {
		if _, ok := keep[id]; ok {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM annotations WHERE doc_id = ? AND id = ?`, docID, id); err != nil {
			return err
		}
	}
	return nil
}
