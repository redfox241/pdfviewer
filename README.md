# PDF Viewer

一个本地优先的跨平台 PDF 阅读器：**Go + Wails + pdf.js**，一套代码构建 macOS 与 Windows 版本。打开即读，选中句子就能留下颜色；标注与阅读进度保存在本地 SQLite 库，可一键导出为旁挂 JSON，原 PDF 永不被修改。

## 功能

- **阅读**：连续滚动、页面跳转、旋转、夜间阅读模式、记住上次位置与缩放
- **缩放**：25%–500%，⌘/Ctrl + 滚轮或触控板捏合，适合宽度 / 适合整页 / 实际大小
- **标注**：高亮（5 色）、下划线、删除线、手绘记号笔、涂改带、区域框选、便签、橡皮擦，完整撤销 / 重做
- **阅读进度**：停留自动标记已读，也可手动标记；顶部进度条、缩略图勾选、最近列表百分比
- **导航**：缩略图侧栏、PDF 大纲、标注列表
- **搜索**：文档内全文搜索、结果列表、上下跳转、区分大小写
- **打印与导出**：把当前标注以矢量方式叠加到原 PDF 上，打印时可选全部 / 当前页 / 页码范围与「仅含标注页」；也可导出带标注的 PDF 副本（正文仍可选中、搜索，含可搜索的便签附录）
- **翻译与查词**：选中文字 → 右键 →「翻译为中文」或「查词」；整句翻译后会按单词列出音标、词性和全部释义，在线翻译（OpenAI 兼容 / DeepL / Google / 百度 / 有道）与离线词典都以可选插件提供，默认不安装
- **本地优先**：默认完全离线、无账号、无遥测；仅在你安装并启用在线翻译插件后，才会按插件声明的域名发起请求。阅读数据存本地 SQLite（WAL），旁挂 JSON 只用于导出/交换，原文件不变

## 技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Wails v2（WKWebView / WebView2，无 cgo） |
| 后端 | Go 1.23+，负责窗口、文件流（支持 Range）、SQLite 持久化、设置、最近文件 |
| 渲染 | pdf.js 4.10.38（文本层 + canvas，兼容 Safari 16.4+ WebView）；pdf-lib 1.17 + fontkit（打印/导出矢量叠加） |
| 前端 | TypeScript + Vite，原生 DOM 组件 |

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。PDF 格式科普：[网页版](docs/pdf-format-guide.html) · [PDF 版](docs/pdf-format-guide.pdf)。

## 目录结构

```
.
├── main.go                 # Wails 入口与窗口配置
├── app.go                  # 绑定给前端的 Go 接口
├── internal/
│   ├── notestore/          # SQLite 阅读数据（WAL，增量写）
│   ├── annot/              # 便携 JSON 格式、校验、指纹、导入/导出
│   ├── plugin/             # 翻译 / 离线词典插件（安装、校验、HTTP、SQLite）
│   ├── library/            # 最近文件
│   ├── pdfstream/          # 本地 PDF Range 流
│   ├── printstage/         # 打印 PDF 暂存与临时文件清理
│   └── settings/           # 设置
├── plugins/                # 可打包的示例插件源码（默认不安装）
├── frontend/
│   ├── src/viewer.ts       # pdf.js 封装、虚拟滚动、缩放、搜索、工具
│   ├── src/main.ts         # 应用装配与 UI 交互
│   ├── src/print.ts        # 打印/导出流程、进度与取消
│   ├── src/printcore.ts    # 范围解析、标注排序、PDF 坐标换算
│   ├── src/print.worker.ts # 后台生成打印 PDF
│   ├── src/styles.css      # 界面样式
│   └── scripts/            # 构建前复制 cMaps / 字体 / wasm
├── build/                  # 图标与打包配置
├── scripts/                # 跨平台构建脚本（sh / PowerShell）
├── Makefile                # make mac / win / all 等快捷命令
└── docs/DESIGN.md
```

## 开发

前置：Go 1.26.0+、Node.js 20.19+（20.x）或 22.12+、[Wails CLI](https://wails.io/docs/gettingstarted/installation)。

```bash
# 安装 Wails CLI（国内网络可用 GOPROXY=https://goproxy.cn,direct）
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 确保 $(go env GOPATH)/bin 在 PATH 中，例如 macOS：
export PATH="$HOME/go/bin:$PATH"
```

### 一键构建（macOS / Linux）

根目录提供 `Makefile` 和 `scripts/build.sh`，会自动查找 `wails`（PATH 或 `$(go env GOPATH)/bin`）。

```bash
make mac                 # macOS 通用包（Intel + Apple Silicon）
make win                 # Windows x64 exe（可在 macOS 上交叉编译）
make win-installer       # Windows x64 NSIS 安装包（需要 makensis）
make all                 # macOS 通用包 + Windows x64

make dev                 # 热重载开发
make test                # go test ./...
make doctor              # 检查构建环境
make plugins             # 打包 plugins/* 为 build/plugins/*.pdfplugin
make ecdict              # 下载并构建 ECDICT 高精度离线词典（约 54 MB 下载，9 万词条）
make clean               # 删除 build/bin、build/plugins 和 frontend/dist

make mac CLEAN=1         # 构建前执行 wails build -clean
```

也可以直接调用脚本：

```bash
./scripts/build.sh mac
./scripts/build.sh win --clean
```

### 一键构建（Windows PowerShell）

```powershell
.\scripts\build.ps1 win
.\scripts\build.ps1 win -Clean
.\scripts\build.ps1 win-installer
.\scripts\build.ps1 dev
.\scripts\build.ps1 test

# 如果被执行策略拦截：
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 win
```

> macOS 包只能在 macOS 上构建；Windows 包可以在 macOS / Linux / Windows 上构建。
> Windows 安装包需要 NSIS（`makensis`），参见 [Wails Windows Installer](https://wails.io/docs/guides/windows-installer/)。

产物位于 `build/bin/`：macOS 为 `pdfviewer.app`，Windows 为 `PDF Viewer.exe`。

如果不想用脚本，也可以直接调用 Wails CLI：

```bash
wails build -platform darwin/universal
wails build -platform windows/amd64
wails build -platform windows/amd64 -nsis
```

## 使用

1. 点击「打开」、把 PDF 拖进窗口，或从「最近阅读」继续。
2. 选中文字后 → 右键：
   - 选颜色后点「高亮 / 下划线 / 删除线」
   - 「复制」复制原文
   - 「翻译为中文」或「查词」（需先安装并启用插件）
3. 顶部标注工具栏可切换选择、高亮、下划线、删除线、记号笔、涂改带、区域框选、便签、橡皮擦。
4. 页面停留 3 秒自动标记已读（可在设置中关闭）；`R` 手动切换本页已读。
5. `⌘/Ctrl + F` 搜索，`Enter` / `Shift + Enter` 在结果间跳转。
6. `⌘/Ctrl + P` 打印：选择范围与是否包含标注后，macOS 会打开「预览」的打印对话框；Windows 用系统默认阅读器打开，按 `Ctrl+P` 打印（关联缺失或损坏时自动改用系统自带的 Edge）。同一面板可用「导出 PDF…」生成带标注的副本。
7. 点击顶部工具栏「适合宽度」右侧的按钮，在单页和双页视图间切换。双页从第 1 页开始成对显示，切换时保留当前页码。

### 快捷键

| 操作 | macOS | Windows |
|------|-------|---------|
| 打开 / 搜索 | ⌘O / ⌘F | Ctrl+O / Ctrl+F |
| 打印 | ⌘P | Ctrl+P |
| 放大 / 缩小 / 实际大小 | ⌘± / ⌘0 | Ctrl± / Ctrl0 |
| 适合宽度 / 整页 | ⌘1 / ⌘2 | Ctrl+1 / Ctrl+2 |
| 上/下翻屏 | PgUp / PgDn、Space | 同左 |
| 首/末页 | Home / End | 同左 |
| 高亮 / 下划线 / 删除线 | H / U / S | 同左 |
| 记号笔 / 橡皮擦 / 便签 | P / E / N | 同左 |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Y |
| 标记本页已读 | R | R |

## 翻译与查词插件

翻译是可选能力，默认不安装任何插件。插件是声明式的 `.pdfplugin` 包，不执行代码：

- **在线翻译**：内置 OpenAI 兼容、DeepL、Google、百度、有道五种请求适配器；百度需要 AppID 与 API Key，有道需要 AppKey 与 AppSecret。启用后只访问 manifest 声明的域名，15 秒超时，译文有内存缓存。
- **句子单词详解**：整句翻译完成后，使用已启用的离线词典逐词显示音标、词性和多条中文释义；变形词会显示原型，未收录的词会单独标注。
- **离线词典**：读取插件自带的 SQLite 词表，选中单词/短语时查词，不联网。
- 安装、开关、API Key 和卸载都在「设置 → 翻译与查词插件」中完成，立即生效。
- 没有启用插件时，右键菜单仍显示入口并引导到设置；非英文内容会置灰。

示例插件源码在 `plugins/`，打包后安装：

```bash
./scripts/pack-plugins.sh
# 设置 → 翻译与查词插件 → 安装插件… → build/plugins/dictionary-sample.pdfplugin
```

Windows PowerShell：

```powershell
.\scripts\pack-plugins.ps1
```

离线词典推荐用 ECDICT：运行 `make ecdict` 会下载并构建约 6 万基础词、9 万词条的精简词典，含音标、词性、多义项和常见变形，准确度明显高于 FreeDict。FreeDict 仍保留为来源清晰、体积小的轻量选项，但它是自动生成的词表，释义质量有限。完整 manifest 格式、词典 schema、安全边界和自制流程见 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 数据存储

- 阅读进度与标注：本地 SQLite（WAL），默认位于
  - macOS：`~/Library/Application Support/PDFViewer/library.db`
  - Windows：`%APPDATA%\PDFViewer\library.db`
- 文档以内容指纹（大小 + 首尾各 1 MiB 哈希）识别，移动/重命名 PDF 不丢数据。
- 旁挂 `报告.pdf.pdfviewer.json` 只用于**显式导出/导入**；旧版 sidecar 会在首次打开时自动导入一次，之后不再回写、不生成 `.bak`。
- 设置与最近文件：`PDFViewer/settings.json`、`PDFViewer/recent.json`。
- 打印/导出的临时 PDF：`PDFViewer/cache/print/`（权限 0600），启动时自动清理 24 小时前的文件；设置中可手动清理。
- 插件与密钥：`PDFViewer/plugins/<id>/`；API Key 明文保存在插件的 `.config.json`（权限 `0600`），卸载插件会一并删除。
- 设置面板提供「导出 .pdfviewer.json」「从同名文件导入」。

## 测试

```bash
go test ./...
cd frontend && npm test
```

后端覆盖 SQLite 增量读写、阅读状态 round-trip、标注 reconcile、旧 sidecar 迁移、指纹稳定性、打印暂存与清理；前端 Vitest 覆盖页码范围解析、便签排序、范围摘要、PDF 坐标/旋转变换，以及真实 pdf-lib 生成（含中文附录与旋转页）。前端交互（打开、翻页保存、标注保存、导出/导入入口）已在 Chromium + mock 绑定下验证，并用隔离 HOME 运行真实 Wails 应用确认数据库落盘、旧 sidecar 自动导入且不再生成 `.bak`。

## 已知限制（v0.2）

- 扫描件没有文本层：使用「区域框选」标注；OCR 计划在 v2。
- 暂不支持加密 PDF 的密码输入弹窗；带密码的 PDF 也无法打印/导出。
- 标注不会写回原 PDF（设计如此）；「打印 → 导出 PDF…」生成带标注的副本，原文件不变。副本会保留正文文本层、书签、链接与表单，但原文档的数字签名会失效。
- 打印/导出需要把整份 PDF 载入内存，超过 100 MB 会先提示；临时文件放在配置目录 `cache/print/`，启动时清理 24 小时前的文件。
- 文件关联（双击 PDF 打开）与多标签页在 v1.1。
- 旋转角度不跨会话保存。
- 尚未启用单实例锁：同一文档被两个窗口同时编辑时，后保存的一方可能覆盖前者。
- 标注暂不支持拖动 / 缩放，搜索暂不支持整词匹配（均在 v1.1）。

## Roadmap

- v1.1：文件关联、多标签页、旋转持久化、密码弹窗、标注拖拽与缩放
- v2：OCR、跨文档全文索引、双页 / 分屏
