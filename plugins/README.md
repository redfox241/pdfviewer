# 插件

本目录是插件源码，不是已安装的插件。每个子目录对应一个 `.pdfplugin` 包：

```bash
./scripts/pack-plugins.sh
# 产物在 build/plugins/*.pdfplugin
```

然后在 App 的「设置 → 翻译与查词插件」里点「安装插件…」，或把 `.pdfplugin` 拖进已打开的插件列表。

| 目录 | 类型 | 说明 |
|------|------|------|
| `translator-openai-compatible` | translator | OpenAI 兼容接口示例（DeepSeek） |
| `translator-deepl` | translator | DeepL Free 端点 |
| `translator-google` | translator | 免密钥的 Google 网页端点 |
| `translator-baidu` | translator | 百度通用文本翻译（AppID + 密钥） |
| `translator-baidu-llm` | translator | 百度大模型文本翻译（AppID + API Key） |
| `translator-youdao` | translator | 有道智云文本翻译 v3（AppKey + 密钥） |
| `translator-ollama` | translator | 本机 Ollama 整句翻译（完全离线，需先安装模型） |
| `dictionary-sample` | dictionary | 常用词条（含变形）的演示词表，不是完整词典 |

插件默认不安装。在线翻译插件只有在你启用后才会访问 manifest 中声明的域名；离线词典插件不会联网。

离线词典优先用 `make ecdict` 构建 ECDICT 精简版（约 6 万词，MIT），比 FreeDict 准确得多。FreeDict+WikDict（约 2.6 万词，CC BY-SA 3.0）保留为轻量选项，步骤见 [docs/PLUGINS.md](../docs/PLUGINS.md#freedictwikdict推荐来源清晰)。仓库不附带词典数据。

完整格式见 [docs/PLUGINS.md](../docs/PLUGINS.md)。仓库不附带任何第三方词典数据，`dictionary-sample` 的词条为演示用自编内容；导入其他词典前请自行确认授权。
