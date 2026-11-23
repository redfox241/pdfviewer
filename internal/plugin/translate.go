package plugin

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	translationTimeout = 15 * time.Second
	maxTranslatedText  = 20000
	maxResponseBytes   = 4 << 20
)

var errEmptyTranslation = errors.New("翻译服务返回了空结果")

// TranslationResult is returned to the frontend.
type TranslationResult struct {
	Text       string `json:"text"`
	PluginID   string `json:"pluginId"`
	PluginName string `json:"pluginName"`
	Model      string `json:"model"`
	TargetLang string `json:"targetLang"`
	Cached     bool   `json:"cached"`
}

type cacheEntry struct {
	key  string
	text string
}

type translationCache struct {
	mu    sync.Mutex
	limit int
	items map[string]*cacheEntry
	order []*cacheEntry
}

func newTranslationCache(limit int) *translationCache {
	return &translationCache{limit: limit, items: make(map[string]*cacheEntry)}
}

func (c *translationCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.items[key]
	if !ok {
		return "", false
	}
	c.touchLocked(entry)
	return entry.text, true
}

func (c *translationCache) set(key, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.items[key]; ok {
		existing.text = text
		c.touchLocked(existing)
		return
	}
	entry := &cacheEntry{key: key, text: text}
	c.items[key] = entry
	c.order = append(c.order, entry)
	for len(c.order) > c.limit {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.items, oldest.key)
	}
}

func (c *translationCache) touchLocked(entry *cacheEntry) {
	for i, e := range c.order {
		if e == entry {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	c.order = append(c.order, entry)
}

func cacheKey(pluginID, model, target, text string) string {
	sum := sha256.Sum256([]byte(pluginID + "\x00" + model + "\x00" + target + "\x00" + text))
	return hex.EncodeToString(sum[:])
}

// Translate sends text to an enabled translator plugin and returns Simplified
// Chinese. Results are cached in memory; failures are not cached.
func (s *Store) Translate(ctx context.Context, id, text string) (TranslationResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return TranslationResult{}, errors.New("没有可翻译的内容")
	}
	if len([]rune(text)) > maxTranslatedText {
		return TranslationResult{}, fmt.Errorf("选中内容过长（最多 %d 字符）", maxTranslatedText)
	}
	p, err := s.enabled(id, KindTranslator)
	if err != nil {
		return TranslationResult{}, err
	}
	if requiresKey(p.manifest) && p.apiKey == "" {
		return TranslationResult{}, ErrNeedsKey
	}
	if requiresAppID(p.manifest) && p.appID == "" {
		return TranslationResult{}, errors.New("插件尚未配置 AppID / AppKey")
	}

	key := cacheKey(p.manifest.ID, p.manifest.Model, p.manifest.TargetLang, text)
	if cached, ok := s.cache.get(key); ok {
		return TranslationResult{
			Text:       cached,
			PluginID:   p.manifest.ID,
			PluginName: p.manifest.Name,
			Model:      p.manifest.Model,
			TargetLang: p.manifest.TargetLang,
			Cached:     true,
		}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, translationTimeout)
	defer cancel()

	var out string
	switch p.manifest.Provider {
	case ProviderOpenAI:
		out, err = translateOpenAI(ctx, p, text)
	case ProviderDeepL:
		out, err = translateDeepL(ctx, p, text)
	case ProviderGoogle:
		out, err = translateGoogle(ctx, p, text)
	case ProviderBaidu:
		out, err = translateBaidu(ctx, p, text)
	case ProviderBaiduLLM:
		out, err = translateBaiduLLM(ctx, p, text)
	case ProviderYoudao:
		out, err = translateYoudao(ctx, p, text)
	default:
		err = fmt.Errorf("不支持的翻译服务 %q", p.manifest.Provider)
	}
	if err != nil {
		return TranslationResult{}, err
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return TranslationResult{}, errEmptyTranslation
	}
	s.cache.set(key, out)
	return TranslationResult{
		Text:       out,
		PluginID:   p.manifest.ID,
		PluginName: p.manifest.Name,
		Model:      p.manifest.Model,
		TargetLang: p.manifest.TargetLang,
	}, nil
}

func translateOpenAI(ctx context.Context, p *active, text string) (string, error) {
	payload := map[string]any{
		"model":       p.manifest.Model,
		"temperature": 0.2,
		"stream":      false,
		"messages": []map[string]string{
			{
				"role": "system",
				"content": "You are a professional translator. Translate the user's English text into Simplified Chinese (zh-CN). " +
					"Preserve paragraph breaks and inline formatting. Output only the translation, with no explanations, notes, or surrounding quotation marks.",
			},
			{"role": "user", "content": text},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.manifest.Endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析翻译服务的响应：%w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", errEmptyTranslation
	}
	return parsed.Choices[0].Message.Content, nil
}

func translateDeepL(ctx context.Context, p *active, text string) (string, error) {
	target := p.manifest.TargetLang
	if target == "" {
		target = "ZH-HANS"
	}
	form := url.Values{}
	form.Set("text", text)
	form.Set("target_lang", target)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.manifest.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "DeepL-Auth-Key "+p.apiKey)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析 DeepL 的响应：%w", err)
	}
	if len(parsed.Translations) == 0 {
		return "", errEmptyTranslation
	}
	return parsed.Translations[0].Text, nil
}

func translateBaidu(ctx context.Context, p *active, text string) (string, error) {
	target := p.manifest.TargetLang
	if target == "" {
		target = "zh"
	}
	salt := strconv.FormatInt(time.Now().UnixNano(), 10)
	sign := fmt.Sprintf("%x", md5.Sum([]byte(p.appID+text+salt+p.apiKey)))
	form := url.Values{}
	form.Set("q", text)
	form.Set("from", "en")
	form.Set("to", target)
	form.Set("appid", p.appID)
	form.Set("salt", salt)
	form.Set("sign", sign)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.manifest.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed struct {
		ErrorCode string `json:"error_code"`
		ErrorMsg  string `json:"error_msg"`
		Results   []struct {
			Dst string `json:"dst"`
		} `json:"trans_result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析百度翻译的响应：%w", err)
	}
	if parsed.ErrorCode != "" && parsed.ErrorCode != "0" && parsed.ErrorCode != "52000" {
		msg := parsed.ErrorMsg
		if msg == "" {
			msg = "未知错误"
		}
		return "", fmt.Errorf("百度翻译返回错误 %s：%s", parsed.ErrorCode, msg)
	}
	var parts []string
	for _, item := range parsed.Results {
		if item.Dst != "" {
			parts = append(parts, item.Dst)
		}
	}
	if len(parts) == 0 {
		return "", errEmptyTranslation
	}
	return strings.Join(parts, "\n"), nil
}

func translateBaiduLLM(ctx context.Context, p *active, text string) (string, error) {
	target := p.manifest.TargetLang
	if target == "" {
		target = "zh"
	}
	payload, err := json.Marshal(map[string]string{
		"appid": p.appID,
		"from":  "en",
		"to":    target,
		"q":     text,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.manifest.Endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed struct {
		ErrorCode string `json:"error_code"`
		ErrorMsg  string `json:"error_msg"`
		Results   []struct {
			Dst string `json:"dst"`
		} `json:"trans_result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析百度翻译的响应：%w", err)
	}
	if parsed.ErrorCode != "" && parsed.ErrorCode != "0" && parsed.ErrorCode != "52000" {
		msg := parsed.ErrorMsg
		if msg == "" {
			msg = "未知错误"
		}
		return "", fmt.Errorf("百度翻译返回错误 %s：%s", parsed.ErrorCode, msg)
	}
	var parts []string
	for _, item := range parsed.Results {
		if item.Dst != "" {
			parts = append(parts, item.Dst)
		}
	}
	if len(parts) == 0 {
		return "", errEmptyTranslation
	}
	return strings.Join(parts, "\n"), nil
}

func translateYoudao(ctx context.Context, p *active, text string) (string, error) {
	target := p.manifest.TargetLang
	if target == "" {
		target = "zh-CHS"
	}
	salt := strconv.FormatInt(time.Now().UnixNano(), 10)
	curtime := strconv.FormatInt(time.Now().Unix(), 10)
	input := youdaoInput(text)
	sum := sha256.Sum256([]byte(p.appID + input + salt + curtime + p.apiKey))
	sign := hex.EncodeToString(sum[:])

	form := url.Values{}
	form.Set("q", text)
	form.Set("from", "en")
	form.Set("to", target)
	form.Set("appKey", p.appID)
	form.Set("salt", salt)
	form.Set("sign", sign)
	form.Set("signType", "v3")
	form.Set("curtime", curtime)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.manifest.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed struct {
		ErrorCode   string   `json:"errorCode"`
		Translation []string `json:"translation"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析有道翻译的响应：%w", err)
	}
	if parsed.ErrorCode != "" && parsed.ErrorCode != "0" {
		return "", fmt.Errorf("有道翻译返回错误 %s", parsed.ErrorCode)
	}
	if len(parsed.Translation) == 0 {
		return "", errEmptyTranslation
	}
	return strings.Join(parsed.Translation, "\n"), nil
}

// youdaoInput follows Youdao v3's rule: the first 10 and last 10 characters
// plus the character count when the text is longer than 20 characters.
func youdaoInput(text string) string {
	runes := []rune(text)
	if len(runes) <= 20 {
		return text
	}
	return string(runes[:10]) + strconv.Itoa(len(runes)) + string(runes[len(runes)-10:])
}

func translateGoogle(ctx context.Context, p *active, text string) (string, error) {
	u, err := url.Parse(p.manifest.Endpoint)
	if err != nil {
		return "", err
	}
	target := p.manifest.TargetLang
	if target == "" {
		target = "zh-CN"
	}
	q := u.Query()
	q.Set("client", "gtx")
	q.Set("sl", "en")
	q.Set("tl", target)
	q.Set("dt", "t")
	q.Set("q", text)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 PDFViewer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetErr(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", responseError(resp)
	}
	var parsed []any
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("无法解析 Google 翻译的响应：%w", err)
	}
	if len(parsed) == 0 {
		return "", errEmptyTranslation
	}
	segments, ok := parsed[0].([]any)
	if !ok {
		return "", errEmptyTranslation
	}
	var b strings.Builder
	for _, seg := range segments {
		parts, ok := seg.([]any)
		if !ok || len(parts) == 0 {
			continue
		}
		if s, ok := parts[0].(string); ok {
			b.WriteString(s)
		}
	}
	return b.String(), nil
}

var httpClient = &http.Client{
	Timeout: translationTimeout + 5*time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		// Translation endpoints do not redirect in normal operation. Refusing
		// redirects keeps the request pinned to the manifest-declared host.
		return errors.New("翻译服务返回了重定向，已拒绝")
	},
}

func friendlyNetErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() || errors.Is(ue.Err, context.DeadlineExceeded) {
			return errors.New("翻译请求超时，请检查网络后重试")
		}
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	return fmt.Errorf("网络请求失败：%w", err)
}

func responseError(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
	msg := strings.TrimSpace(string(raw))
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		if parsed.Error.Message != "" {
			msg = parsed.Error.Message
		} else if parsed.Message != "" {
			msg = parsed.Message
		}
	}
	if len([]rune(msg)) > 240 {
		msg = string([]rune(msg)[:240]) + "…"
	}
	return fmt.Errorf("翻译服务返回 %s：%s", strconv.Itoa(resp.StatusCode), msg)
}
