package plugin

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"
)

// DictEntry is one sense of a headword.
type DictEntry struct {
	Pos         string `json:"pos"`
	Translation string `json:"translation"`
}

// DictResult is the frontend-facing dictionary lookup result.
type DictResult struct {
	Word       string      `json:"word"`
	Phonetic   string      `json:"phonetic"`
	Lemma      string      `json:"lemma"`
	Entries    []DictEntry `json:"entries"`
	Found      bool        `json:"found"`
	PluginID   string      `json:"pluginId"`
	PluginName string      `json:"pluginName"`
}

// Dictionary plugins use a SQLite file with at least this schema:
//
//	CREATE TABLE entries (
//	  word TEXT NOT NULL,
//	  phonetic TEXT,
//	  pos TEXT,
//	  translation TEXT NOT NULL,
//	  lemma TEXT
//	);
//	CREATE INDEX entries_word ON entries(word COLLATE NOCASE);
//
// phonetic, pos and lemma are optional columns. Inflected forms can either be
// stored as their own rows or point at a base form through lemma.
func validateDictionaryDB(path string) error {
	db, err := openDictionary(path)
	if err != nil {
		return fmt.Errorf("%w: 词典数据无法打开", ErrInvalidPackage)
	}
	defer db.Close()
	cols, err := dictionaryColumns(db)
	if err != nil {
		return fmt.Errorf("%w: 词典数据缺少 entries 表", ErrInvalidPackage)
	}
	if !cols["word"] || !cols["translation"] {
		return fmt.Errorf("%w: entries 表需要 word 与 translation 列", ErrInvalidPackage)
	}
	return nil
}

// Lookup finds a word or phrase in an enabled dictionary plugin.
func (s *Store) Lookup(id, raw string) (DictResult, error) {
	p, err := s.enabled(id, KindDictionary)
	if err != nil {
		return DictResult{}, err
	}
	cleaned := cleanHeadword(raw)
	if cleaned == "" {
		return DictResult{}, errors.New("没有可查询的单词")
	}
	if len([]rune(cleaned)) > 120 {
		return DictResult{}, errors.New("查询内容过长")
	}
	r, err := openDictReader(p)
	if err != nil {
		return DictResult{}, err
	}
	defer r.db.Close()
	return r.lookup(cleaned)
}

// LookupMany extracts unique English words from text and returns one entry per
// word. It opens the dictionary once, which keeps sentence breakdowns cheap.
func (s *Store) LookupMany(id, text string) ([]DictResult, error) {
	p, err := s.enabled(id, KindDictionary)
	if err != nil {
		return nil, err
	}
	words := sentenceWords(text)
	if len(words) == 0 {
		return []DictResult{}, nil
	}
	r, err := openDictReader(p)
	if err != nil {
		return nil, err
	}
	defer r.db.Close()
	out := make([]DictResult, 0, len(words))
	for _, word := range words {
		res, err := r.lookup(word)
		if err != nil {
			return nil, err
		}
		out = append(out, res)
	}
	return out, nil
}

type dictReader struct {
	db         *sql.DB
	selectCols []string
	query      string
	plugin     *active
}

func openDictReader(p *active) (*dictReader, error) {
	full := filepath.Join(p.dir, filepath.FromSlash(p.manifest.Data))
	db, err := openDictionary(full)
	if err != nil {
		return nil, fmt.Errorf("词典数据无法打开：%w", err)
	}
	cols, err := dictionaryColumns(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	if !cols["word"] || !cols["translation"] {
		db.Close()
		return nil, errors.New("词典结构不受支持：缺少 word 或 translation 列")
	}
	selectCols := []string{"word", "translation"}
	for _, optional := range []string{"phonetic", "pos", "lemma"} {
		if cols[optional] {
			selectCols = append(selectCols, optional)
		}
	}
	return &dictReader{
		db:         db,
		selectCols: selectCols,
		query:      "SELECT " + strings.Join(selectCols, ", ") + " FROM entries WHERE word = ? COLLATE NOCASE LIMIT 8",
		plugin:     p,
	}, nil
}

func (r *dictReader) lookup(cleaned string) (DictResult, error) {
	result := DictResult{
		Word:       cleaned,
		PluginID:   r.plugin.manifest.ID,
		PluginName: r.plugin.manifest.Name,
	}
	seen := map[string]bool{}
	for _, candidate := range headwordCandidates(cleaned) {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		matched, phonetic, lemma, entries, err := r.queryWord(candidate)
		if err != nil {
			return DictResult{}, err
		}
		if len(entries) == 0 {
			continue
		}
		result.Phonetic = phonetic
		result.Lemma = lemma
		result.Entries = entries
		if result.Lemma == "" && matched != "" && !strings.EqualFold(matched, cleaned) {
			result.Lemma = matched
		}
		break
	}
	result.Found = len(result.Entries) > 0
	return result, nil
}

func (r *dictReader) queryWord(candidate string) (matched, phonetic, lemma string, entries []DictEntry, err error) {
	rows, err := r.db.Query(r.query, candidate)
	if err != nil {
		return "", "", "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var word, translation string
		var phoneticVal, pos, lemmaVal sql.NullString
		dest := []any{&word, &translation}
		for _, col := range r.selectCols[2:] {
			switch col {
			case "phonetic":
				dest = append(dest, &phoneticVal)
			case "pos":
				dest = append(dest, &pos)
			case "lemma":
				dest = append(dest, &lemmaVal)
			}
		}
		if err := rows.Scan(dest...); err != nil {
			return "", "", "", nil, err
		}
		if strings.TrimSpace(translation) == "" {
			continue
		}
		if matched == "" {
			matched = word
		}
		if phonetic == "" && phoneticVal.String != "" {
			phonetic = phoneticVal.String
		}
		if lemma == "" && lemmaVal.String != "" && !strings.EqualFold(lemmaVal.String, word) {
			lemma = lemmaVal.String
		}
		entry := DictEntry{
			Pos:         strings.TrimSpace(pos.String),
			Translation: strings.TrimSpace(translation),
		}
		if !hasEntry(entries, entry) {
			entries = append(entries, entry)
		}
	}
	if err := rows.Err(); err != nil {
		return "", "", "", nil, err
	}
	return matched, phonetic, lemma, entries, nil
}

func hasEntry(entries []DictEntry, want DictEntry) bool {
	for _, e := range entries {
		if e == want {
			return true
		}
	}
	return false
}

func openDictionary(path string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func dictionaryColumns(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(entries)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[strings.ToLower(name)] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(cols) == 0 {
		return nil, errors.New("entries 表不存在")
	}
	return cols, nil
}

func cleanHeadword(raw string) string {
	s := strings.Map(func(r rune) rune {
		switch r {
		case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad':
			return -1
		case '\u00a0':
			return ' '
		}
		return r
	}, raw)
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, " \t\r\n.,;:!?\"'“”‘’()[]{}<>…—–")
	return s
}

var sentenceWordRE = regexp.MustCompile(`[A-Za-z]+(?:['’\-][A-Za-z]+)*`)

// sentenceWords returns unique English words in first-seen order. The limit
// keeps a very long selection from producing a thousand SQLite queries.
func sentenceWords(text string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 16)
	for _, word := range sentenceWordRE.FindAllString(text, -1) {
		key := strings.ToLower(word)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, word)
		if len(out) >= 40 {
			break
		}
	}
	return out
}

// headwordCandidates returns the exact spelling first, then a small set of
// inflection reductions. Only a real dictionary hit is used, so a wrong guess
// cannot produce a fake result.
func headwordCandidates(word string) []string {
	lower := strings.ToLower(word)
	out := make([]string, 0, 10)
	seen := map[string]bool{}
	add := func(s string) {
		if len([]rune(s)) < 2 || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	add(word)
	add(lower)
	if strings.ContainsAny(lower, " \t\n") {
		return out
	}
	for _, suffix := range []string{"'s", "’s"} {
		if strings.HasSuffix(lower, suffix) {
			add(strings.TrimSuffix(lower, suffix))
		}
	}
	if strings.HasSuffix(lower, "ies") && len(lower) > 3 {
		add(lower[:len(lower)-3] + "y")
	}
	if strings.HasSuffix(lower, "ied") && len(lower) > 3 {
		add(lower[:len(lower)-3] + "y")
	}
	if strings.HasSuffix(lower, "es") && len(lower) > 2 {
		add(lower[:len(lower)-2])
	}
	if strings.HasSuffix(lower, "s") && !strings.HasSuffix(lower, "ss") && len(lower) > 2 {
		add(lower[:len(lower)-1])
	}
	if strings.HasSuffix(lower, "ed") && len(lower) > 2 {
		add(lower[:len(lower)-2])
		add(lower[:len(lower)-1])
	}
	if strings.HasSuffix(lower, "ing") && len(lower) > 3 {
		base := lower[:len(lower)-3]
		add(base)
		add(base + "e")
		if len(base) > 1 && base[len(base)-1] == base[len(base)-2] {
			add(base[:len(base)-1])
		}
	}
	return out
}
