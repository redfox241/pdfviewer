# 翻译与查词插件

阅读器默认不带任何翻译能力。插件是一个 `.pdfplugin` zip 包；安装并在设置中启用后，右键菜单才会出现「翻译为中文」或「查词」。

插件不是可执行代码。App 只读取 manifest，按 manifest 描述发 HTTP 请求，或读取 manifest 指定的 SQLite 词典。这样插件无法访问你的 PDF、标注、Go 接口或其他本地文件。

## 安装与开关

- 设置 →「翻译与查词插件」→「安装插件…」，选择 `.pdfplugin`。
- 也可以把 `.pdfplugin` 拖进已打开的插件列表。
- 每个插件有独立开关；同类插件中用「设为默认」决定右键菜单使用哪一个。
- 安装、开关、密钥、卸载都立即生效，不随设置页的「保存」按钮。
- 没有启用插件时，右键菜单仍显示「翻译为中文（未启用插件）」，点击会跳到设置。
- 卸载会删除插件目录、配置和 API Key。

安装校验：zip 总量上限 2 MB（translation）/ 300 MB（dictionary），最多 4096 个文件；manifest 上限 64 KB；拒绝路径穿越、符号链接和内部保留文件名 `.config.json`；同 id 更新必须版本号不低于已安装版本，并会保留原来的开关和密钥。

## manifest.json

必须位于 zip 根目录。

```json
{
  "id": "translator-openai-compatible",
  "name": "OpenAI 兼容翻译",
  "version": "1.0.0",
  "kind": "translator",
  "description": "可选，显示在设置里",
  "author": "可选",
  "homepage": "可选",
  "provider": "openai",
  "endpoint": "https://api.deepseek.com/chat/completions",
  "model": "deepseek-chat",
  "targetLang": "zh-CN"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{0,63}$`，卸载/更新以它为准 |
| `name` | 是 | 显示名称，≤80 字符 |
| `version` | 是 | `1`、`1.2` 或 `1.2.3`，可带 `-beta` 后缀 |
| `kind` | 是 | `translator` 或 `dictionary` |
| `provider` | translator 必填 | `openai`、`deepl`、`google`、`baidu`、`baidu-llm`、`youdao` |
| `endpoint` | translator 必填 | 完整 URL，必须 https；本机回环地址允许 http |
| `model` | openai 必填 | 例如 `deepseek-chat`、`qwen2.5:7b` |
| `targetLang` | 否 | 默认：OpenAI/Google 为 `zh-CN`，DeepL 为 `ZH-HANS` |
| `data` | dictionary 必填 | 包内 SQLite 文件相对路径 |

### translator

宿主内置三种请求格式，manifest 不能自定义请求模板：

- `openai`：`POST endpoint`，`Authorization: Bearer <key>`，请求体为 `{model, messages, temperature, stream:false}`，读取 `choices[0].message.content`。适用于 OpenAI、DeepSeek、Kimi、Qwen、Ollama 等兼容接口。
- `deepl`：`POST endpoint`，`Authorization: DeepL-Auth-Key <key>`，表单 `text` + `target_lang`，读取 `translations[0].text`。Free 端点 `https://api-free.deepl.com/v2/translate`，Pro 端点 `https://api.deepl.com/v2/translate`。
- `google`：`GET endpoint`，参数 `client=gtx&sl=en&tl=<target>&dt=t&q=<text>`，读取嵌套数组。免密钥，但没有服务保证。
- `baidu`：`POST endpoint`，表单包含 `q`、`from=en`、`to=<target>`、`appid`、`salt`、`sign`。`sign = md5(appid + q + salt + 密钥)`。读取 `trans_result[].dst`。对应通用文本翻译接口。
- `baidu-llm`：`POST endpoint`，JSON 包含 `appid`、`from=en`、`to=<target>`、`q`；请求头 `Authorization: Bearer <API Key>`。读取 `trans_result[].dst`。对应大模型文本翻译端点 `https://fanyi-api.baidu.com/ait/api/aiTextTranslate`，需要在百度翻译开放平台申请 AppID 与 API Key。
- `youdao`：`POST endpoint`，表单包含 `q`、`from=en`、`to=<target>`、`appKey`、`salt`、`curtime`、`signType=v3`、`sign`。`sign = sha256(AppKey + input + salt + curtime + 密钥)`，其中 `input` 在原文超过 20 个字符时取前 10 + 字符数 + 后 10。读取 `translation` 数组。需要在有道智云申请 AppKey 与 AppSecret。

只允许访问 `endpoint` 的主机（含端口）；HTTP 重定向会被拒绝，避免请求被转发到白名单之外的地址。网络超时 15 秒，响应上限 4 MB，单次文本上限 20,000 字符。

`openai` / `deepl` 在非本机端点时必须配置 API Key；`baidu` / `baidu-llm` 需要 AppID 与 API Key/密钥；`youdao` 需要 AppKey 与 AppSecret。Google 插件不需要凭据。凭据以明文保存在插件目录的 `.config.json`（权限 `0600`），不会返回给前端；设置页对百度/有道会显示两个输入框。

### dictionary

词典是只读 SQLite 文件，最少需要：

```sql
CREATE TABLE entries (
  word TEXT NOT NULL,
  phonetic TEXT,
  pos TEXT,
  translation TEXT NOT NULL,
  lemma TEXT
);
CREATE INDEX entries_word ON entries(word COLLATE NOCASE);
```

`phonetic`、`pos`、`lemma` 可省略。查询按 `word` 大小写不敏感匹配，最多显示 8 条释义；`lemma` 非空时卡片会显示「原型：…」。变形词（`running`、`ran`）可以直接作为独立行存在，也可以由转换脚本从 ECDICT 的 `exchange` 字段生成。

用 CSV 生成：

```bash
python3 scripts/build-dict.py my-words.csv my-words.sqlite
# CSV: word,phonetic,pos,translation,lemma
```

脚本也识别 ECDICT 风格的 CSV（包含 `exchange` 与 `definition` 列），可用 `--limit 50000` 按词频裁剪；例如把 ECDICT 的 `ecdict.csv` 转成 5 万词的表：

```bash
python3 scripts/build-dict.py ecdict.csv ecdict-50k.sqlite --limit 50000
python3 scripts/make-dict-plugin.py \
  --db ecdict-50k.sqlite --id ecdict-50k --name "ECDICT 5 万词" \
  --out build/plugins/ecdict-50k.pdfplugin
```

`make-dict-plugin.py` 会校验 `entries` 表结构并生成带 manifest 的 zip。数据授权由使用者自行确认；本仓库不附带第三方词典数据，也不下载任何词表。

### ECDICT（推荐：准确度更高）

FreeDict 的 `eng-zho` 是自动生成的轻量词表，覆盖约 2.6 万词，但释义质量和覆盖都不够稳定。实测中会出现 `issue → 水果`、`fine → 七`、`make → 的` 这类明显错误的词义；这不是渲染问题，而是词表本身的局限。

ECDICT 的释义质量、覆盖和词形信息都明显更好，适合作为默认离线词典。需要更准确的离线词典时，用 ECDICT 构建：

```bash
make ecdict
```

它会下载约 54 MB 的 ECDICT SQLite 数据，按词频筛选约 6 万基础词条，解析中文释义中的词性和多义项，并用 ECDICT 的 `exchange` 字段补全常见变形，最终约 9 万词条 / 11 万行释义，生成：

```text
build/plugins/ecdict-essential.pdfplugin
```

也可以在已有 `ecdict.csv` 时手动构建：

```bash
python3 scripts/build-ecdict.py ecdict.csv ecdict-essential.sqlite --limit 60000
python3 scripts/make-dict-plugin.py \
  --db ecdict-essential.sqlite --id ecdict-essential --name "ECDICT 精简英汉词典" \
  --license "MIT" --license-file ECDICT-LICENSE \
  --out build/plugins/ecdict-essential.pdfplugin
```

ECDICT 采用 MIT 许可，但它是多来源汇编；随包附带 LICENSE 与 NOTICE，商业分发前建议自行确认上游数据授权。

### Ollama 本地整句翻译

如果希望**整句翻译也完全离线**，安装 [Ollama](https://ollama.com/)，拉取一个模型，然后安装示例插件：

```bash
ollama pull qwen2.5:7b
make plugins
# 安装 build/plugins/translator-ollama.pdfplugin
```

manifest 中的 endpoint 是 `http://127.0.0.1:11434/v1/chat/completions`，模型默认 `qwen2.5:7b`；如果本机模型名不同，修改 `plugins/translator-ollama/manifest.json` 后重新打包。它不会联网，也不需要 API Key。整句翻译质量取决于模型和机器性能。

### FreeDict+WikDict（轻量、来源清晰）

FreeDict 的 `eng-zho` 约 2.6 万词头，有真实 IPA、词性、中文释义，数据许可为 **CC BY-SA 3.0**。仓库不附带数据，但提供 TEI 转换器。下载并转换（以 2025.11.23 版为例）：

```bash
curl -LO https://download.freedict.org/dictionaries/eng-zho/2025.11.23/freedict-eng-zho-2025.11.23.src.tar.xz
tar -xf freedict-eng-zho-2025.11.23.src.tar.xz
python3 scripts/build-freedict.py eng-zho/eng-zho.tei eng-zho.sqlite
python3 scripts/make-dict-plugin.py \
  --db eng-zho.sqlite --id freedict-eng-zho --name "FreeDict 英汉词典" \
  --description "FreeDict+WikDict 英汉词典，含 IPA、词性和中文释义" \
  --license "CC BY-SA 3.0" --license-file eng-zho/COPYING \
  --source "FreeDict+WikDict eng-zho 2025.11.23" \
  --notice "© Karl Bartel and Wiktionary contributors. Converted with scripts/build-freedict.py." \
  --out build/plugins/freedict-eng-zho.pdfplugin
```

生成的 SQLite 是原数据的**改编版本**，必须继续以 CC BY-SA 3.0 分发并署名。`make-dict-plugin.py` 会把完整 `LICENSE` 与说明转换修改的 `NOTICE` 一起放进插件 zip；插件目录可通过设置页「打开插件目录」访问，数据文件也保持可导出。

## 打包

```bash
./scripts/pack-plugins.sh
```

脚本遍历 `plugins/*/`，把内容压到 zip 根目录；含 `entries.csv` 的目录会先调用 `build-dict.py` 生成 `dict.sqlite`。手动打包时也必须保证 `manifest.json` 在 zip 根目录，而不是多套一层文件夹。

## 行为约定

- 右键菜单只对 PDF 文本层中的选中内容生效；通过启发式判断是否为英文，非英文时翻译项置灰。
- 单词/短词优先使用启用的离线词典；整句使用默认翻译插件。
- 整句翻译完成后，宿主会用已启用的离线词典按单词补全音标、词性和释义；同一句中的重复单词只查一次。
- 同一张译文卡片只保留一个请求，发起新翻译会取消旧请求；关闭卡片或按 Esc 也会取消。
- 译文有内存 LRU 缓存（200 条，按插件、模型、目标语言和原文哈希），失败不缓存。
- 结果卡片显示在选区旁；可复制、重试，长文本在卡片内滚动。
