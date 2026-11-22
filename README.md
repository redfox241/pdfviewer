# PDF Viewer

一个本地优先的跨平台 PDF 阅读器：**Go + Wails + pdf.js**，一套代码构建 macOS 与 Windows 版本。打开即读，选中句子就能留下颜色，标注与阅读进度保存在文档旁边，原 PDF 永不被修改。

## 功能

- **阅读**：连续滚动、页面跳转、旋转、夜间阅读模式、记住上次位置与缩放
- **缩放**：25%–500%，⌘/Ctrl + 滚轮或触控板捏合，适合宽度 / 适合整页 / 实际大小
- **标注**：高亮（5 色）、下划线、删除线、手绘记号笔、涂改带、区域框选、便签、橡皮擦，完整撤销 / 重做
- **阅读进度**：停留自动标记已读，也可手动标记；顶部进度条、缩略图勾选、最近列表百分比
- **导航**：缩略图侧栏、PDF 大纲、标注列表
- **搜索**：文档内全文搜索、结果列表、上下跳转、区分大小写
- **本地优先**：完全离线、无账号、无遥测；标注写入旁挂 JSON，原文件不变

## 技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Wails v2（WKWebView / WebView2，无 cgo） |
| 后端 | Go 1.23+，负责窗口、文件流（支持 Range）、标注存储、设置、最近文件 |
| 渲染 | pdf.js 4.10.38（文本层 + canvas，兼容 Safari 16.4+ WebView） |
| 前端 | TypeScript + Vite，原生 DOM 组件 |

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录结构

```
.
├── main.go                 # Wails 入口与窗口配置
├── app.go                  # 绑定给前端的 Go 接口
├── internal/
│   ├── annot/              # sidecar 读写、校验、指纹、原子写
│   ├── library/            # 最近文件
│   ├── pdfstream/          # 本地 PDF Range 流
│   └── settings/           # 设置
├── frontend/
│   ├── src/viewer.ts       # pdf.js 封装、虚拟滚动、缩放、搜索、工具
│   ├── src/main.ts         # 应用装配与 UI 交互
│   ├── src/styles.css      # 界面样式
│   └── scripts/            # 构建前复制 cMaps / 字体 / wasm
├── build/                  # 图标与打包配置
└── docs/DESIGN.md
```

## 开发

前置：Go 1.23+、Node.js 20+、[Wails CLI](https://wails.io/docs/gettingstarted/installation)。

```bash
# 安装 Wails CLI（国内网络可用 GOPROXY=https://goproxy.cn,direct）
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 热重载开发
wails dev

# 构建 macOS 通用包（Intel + Apple Silicon）
wails build -platform darwin/universal

# 构建 Windows 可执行文件 / 安装包
wails build -platform windows/amd64
wails build -platform windows/amd64 -nsis
```

产物位于 `build/bin/`：macOS 为 `pdfviewer.app`，Windows 为 `PDF Viewer.exe`。

## 使用

1. 点击「打开」、把 PDF 拖进窗口，或从「最近阅读」继续。
2. 选中文字后：
   - 点击浮动工具条上的颜色 → 高亮
   - 点击下划线 / 删除线 → 划线
   - 点击复制 → 复制原文
3. 左侧工具条可切换记号笔、涂改带、区域框选、便签、橡皮擦。
4. 页面停留 3 秒自动标记已读（可在设置中关闭）；`R` 手动切换本页已读。
5. `⌘/Ctrl + F` 搜索，`Enter` / `Shift + Enter` 在结果间跳转。

### 快捷键

| 操作 | macOS | Windows |
|------|-------|---------|
| 打开 / 搜索 | ⌘O / ⌘F | Ctrl+O / Ctrl+F |
| 放大 / 缩小 / 实际大小 | ⌘± / ⌘0 | Ctrl± / Ctrl0 |
| 适合宽度 / 整页 | ⌘1 / ⌘2 | Ctrl+1 / Ctrl+2 |
| 上/下翻屏 | PgUp / PgDn、Space | 同左 |
| 首/末页 | Home / End | 同左 |
| 高亮 / 下划线 / 删除线 | H / U / S | 同左 |
| 记号笔 / 橡皮擦 / 便签 | P / E / N | 同左 |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Y |
| 标记本页已读 | R | R |

## 数据存储

- 标注与阅读进度：默认写入与 PDF 同目录的 `报告.pdf.pdfviewer.json`；目录不可写时自动改存应用数据目录。
  - macOS：`~/Library/Application Support/PDFViewer/notes/`
  - Windows：`%APPDATA%\PDFViewer\notes\`
- 设置与最近文件：`~/Library/Application Support/PDFViewer/`、`%APPDATA%\PDFViewer\`
- 写入使用「临时文件 + rename」原子替换，并保留一份 `.bak`。
- 通过文件大小、mtime 与前 1 MB 哈希检测文档是否被替换；不匹配时提示标注可能偏移。

## 测试

```bash
go test ./...
```

前端交互（打开、选择、高亮、撤销、搜索跳转、缩略图、夜间、手绘、橡皮擦、便签、已读进度、重开恢复、旋转）已在 Chromium 中做过端到端验证。

## 已知限制（v0.1）

- 扫描件没有文本层：使用「区域框选」标注；OCR 计划在 v2。
- 暂不支持加密 PDF 的密码输入弹窗。
- 标注不会写回原 PDF（设计如此）；「导出带标注的 PDF」在 v1.1。
- 文件关联（双击 PDF 打开）与多标签页在 v1.1。
- 旋转角度不跨会话保存。
- 标注暂不支持拖动 / 缩放，搜索暂不支持整词匹配（均在 v1.1）。

## Roadmap

- v1.1：导出带标注 PDF、文件关联、多标签页、旋转持久化、密码弹窗
- v2：OCR、跨文档全文索引、标注拖拽与缩放、双页 / 分屏
