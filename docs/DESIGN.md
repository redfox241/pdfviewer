# PDF 阅读器设计文档（v0.1 草案）

> 状态：已确认并实现 v0.1 · 日期：2026-11-22 · 目标平台：macOS（Intel / Apple Silicon）+ Windows 10/11 x64

## 1. 目标与非目标

**一句话定位**：本地优先、离线可用的跨平台 PDF 阅读器，以 Go 作为应用骨架与数据层，专注「读得舒服」和「标记读过的内容」。

### 1.1 必须满足

| # | 需求 |
|---|------|
| R1 | 一套代码同时构建 macOS 与 Windows 版本 |
| R2 | 打开本地 PDF，连续滚动阅读，页面跳转 |
| R3 | 缩放：按钮、快捷键、Ctrl/⌘+滚轮、触控板捏合、适合宽度/整页/100% |
| R4 | 选中文本后高亮 / 下划线 / 删除线 / 手绘涂抹 / 橡皮擦 |
| R5 | 标注、阅读进度、上次阅读位置持久化，重开即恢复 |
| R6 | 大文档可用：≥500 页、≥100 MB 不卡死、不爆内存 |
| R7 | 文档内搜索、缩略图、大纲导航 |
| R8 | 默认完全离线，无后台网络请求、无遥测；仅当用户安装并启用在线翻译插件后，才按插件 manifest 声明的域名发起请求（Go 侧执行、域名固定、拒绝重定向） |

### 1.2 非目标（v1 明确不做）

- 编辑 PDF 正文、表单填写、数字签名
- OCR（扫描件 v1 仅支持「拖框区域标注」）
- 云同步、协作、移动端、多标签页
- 真正的脱敏删除（redaction）——v1 的「涂改带」只是视觉遮盖，不改动原文件

---

## 2. 技术选型

### 2.1 关键约束：Go 没有可用的纯 Go PDF 渲染引擎

这是本项目的核心技术事实，必须先讲清楚：

| 能力 | Go 生态现状 |
|------|-------------|
| PDF 解析/拆分/合并 | `pdfcpu` 可用，成熟 |
| 文本抽取 | `ledongthuc/pdf` 可用，质量一般 |
| **PDF 光栅化渲染** | **无纯 Go 实现**；只能 cgo 绑定 MuPDF（`go-fitz`） |
| 文本坐标 / 选区 | MuPDF 绑定能力有限，需要自己补 |
| 字体、CJK、加密、损坏文件容错 | 纯 Go 方案差距明显 |

结论：想要「渲染质量接近系统预览、文本选择准确、缩放清晰」，纯 Go GUI（Fyne / Gio）目前做不到。必须在下面三条路里选。

### 2.2 方案对比

| 维度 | A. Wails v2 + pdf.js（推荐） | B. Go + Fyne + go-fitz(MuPDF) | C. Electron + pdf.js |
|------|------------------------------|-------------------------------|----------------------|
| 渲染质量 | 优秀（Chrome/Firefox 级 pdf.js） | 好（MuPDF），但 UI 是位图拼装 | 优秀 |
| 文本选择/高亮 | pdf.js 文本层，成熟 | 需自研坐标映射，工作量大 | 成熟 |
| 跨平台构建 | 纯 Go，无 cgo，交叉编译简单 | cgo + 各平台 MuPDF 库，打包痛苦 | 简单但体积大 |
| 安装包体积 | ~15 MB + 系统 WebView | ~25–40 MB（含 MuPDF） | ~120 MB+ |
| 内存占用 | 中（系统 WebView 共享进程） | 低 | 高 |
| Go 代码占比 | 后端/应用层约 40% | 约 90% | 约 0% |
| 界面精致度 | 高（HTML/CSS） | 中 | 高 |
| 主要风险 | WebView 差异、worker 打包 | 交叉编译、文本层缺失 | 体积、内存、不像原生 |

**选 A。** Go 负责窗口、文件系统、持久化、设置、本地资源流式服务；UI 渲染复用 pdf.js（Mozilla 维护，事实标准）。这样既满足「用 Go 开发」的主体诉求，又不在最难的渲染环节重复造轮子。

> 如果你更看重「几乎全部逻辑都是 Go」，可以选 B，但预计开发量翻倍，且 Windows 交叉编译需要 MinGW 工具链、macOS 需要两套架构的 MuPDF 静态库。设计文档按 A 展开，B 作为备选保留。

### 2.3 依赖清单

| 层 | 选型 | 说明 |
|----|------|------|
| 桌面框架 | Wails v2（稳定版） | 原生 WebView，Go↔JS 绑定，单二进制 |
| 渲染 | `pdfjs-dist`（最新稳定版，ESM） | 含 worker、文本层、大纲、加密支持 |
| 前端 | TypeScript + Vite，原生 DOM 组件 | 不引入 React/Vue：pdf.js 本身是命令式 DOM 操作，框架收益低 |
| Go | 标准库为主；`pdfcpu` 仅备用（元数据/导出） | 无 cgo |
| 测试 | Go `testing`、Vitest、（可选）Playwright | |

### 2.4 可选翻译插件

翻译不是内置能力，而是可安装的声明式插件，默认不安装：

- `.pdfplugin` 是 zip，内含 `manifest.json`；词典插件另含 SQLite 数据。插件内没有任何可执行代码。
- 宿主只为 translator 执行五种内置 HTTP 适配器（OpenAI 兼容 / DeepL / Google / 百度 / 有道），或为 dictionary 只读查询 SQLite。
- endpoint 在安装时校验（https，仅本机允许 http），运行时请求固定到该主机并拒绝重定向；API Key 存于插件目录 `.config.json`（0600）。
- 安装校验拒绝 zip-slip、符号链接、超限文件；更新需版本不回退；卸载删除配置与密钥。
- 右键菜单按选中内容选择：单词/短词优先离线词典，整句走默认在线翻译；非英文置灰。
- 整句译文下方附带逐词详解：音标、词性、多条释义；复用离线词典插件，批量查询一次打开数据库。
- 翻译请求 15 秒超时，前端可取消；内存 LRU 缓存 200 条，失败不缓存。

插件格式、示例与安全边界见 [PLUGINS.md](PLUGINS.md)。

---

## 3. 总体架构

```
┌────────────────────────────── Wails 应用进程 ──────────────────────────────┐
│                                                                            │
│   Go 侧                                     WebView 侧                      │
│   ┌────────────────────┐   bindings/events   ┌──────────────────────────┐  │
│   │ app.go  窗口/生命周期│◄──────────────────►│ UI 层（TypeScript）       │  │
│   │ library 最近文件     │                     │  ├ 工具栏 / 侧栏 / 对话框 │  │
│   │ notestore SQLite 库  │                     │  ├ 页面容器 + 虚拟滚动    │  │
│   │ annot   导出/导入格式 │                     │  ├ pdf.js 渲染 + 文本层   │  │
│   │ settings 设置        │   HTTP Range 流     │  ├ 标注叠加层（SVG/DOM）  │  │
│   │ pdfstream 本地资源   │◄───────────────────►│  └ 标注叠加层（SVG/DOM）  │  │
│   └─────────┬──────────┘                     └──────────────────────────┘  │
│             │                                                              │
└─────────────┼──────────────────────────────────────────────────────────────┘
              │
     ┌────────▼─────────┐        ┌──────────────────────────────┐
     │ App Support 目录  │        │ <文档>.pdfviewer.json         │
     │ library.db (WAL)  │        │ 仅显式导出/导入（可选）       │
     │ 设置/最近文件/缓存 │        │ 标注 + 阅读进度（非破坏性）   │
     └──────────────────┘        └──────────────────────────────┘
```

**职责边界**

- Go：文件对话框、读取 PDF 字节流（支持 Range）、SQLite 持久化、sidecar 导入/导出、设置、最近文件、窗口状态、单实例、插件安装与翻译/查词请求。
- 前端：一切渲染与交互、坐标换算、撤销栈、搜索索引、标注绘制。
- 原则：**Go 不碰 PDF 内部结构，前端不碰任意文件系统路径**（路径由 Go 下发 token 授权）。

---

## 4. 功能设计

### 4.1 阅读

- 默认连续纵向滚动；可切换单页模式。
- 左侧栏两种标签：缩略图 / 大纲（`getOutline`，无大纲时隐藏）。
- 工具栏：页码输入框 / 总页数、上一页、下一页、缩放控件、旋转。
- 记住每份文档的 `lastPage + 页内滚动比例 + 缩放 + 视图模式`，重开恢复。
- 旋转：0/90/180/270，仅影响显示，标注坐标随之变换。
- 夜间模式：画布反色 + 轻微降对比（`filter: invert(0.9) hue-rotate(180deg)`），文字层同步，标注颜色保持可辨。
- 触控板双指滚动、惯性、⌘+滚轮缩放；触控板捏合（WebKit 以 `ctrl+wheel` 形式派发）统一处理并 `preventDefault`，避免整个 WebView 被缩放。

### 4.2 缩放

| 项 | 规格 |
|----|------|
| 范围 | 25% – 500% |
| 预设 | 适合宽度、适合整页、100%、上次值 |
| 操作 | 工具栏 ±、⌘/Ctrl + `+`/`-`/`0`、Ctrl+滚轮、捏合 |
| 渲染策略 | 位图按 `min(zoom × DPR, 3)` 渲染，超出部分用 CSS 放大，避免 500% 时单页 canvas 超过 100 MB |
| 刻度约定 | 100% = 96 dpi 实际大小（pdf.js 内部 scale = 4/3）；界面百分比 = `scale × 75` |

### 4.3 标注与「涂改」

工具集（顶部标注工具条 + 快捷键）：

| 工具 | 行为 | 数据 |
|------|------|------|
| 选择 | 默认，文本选择/复制/点选已有标注 | — |
| 高亮 | 选中文本 → 吸附行框 → 生成矩形组；4 色 + 透明度 | `quads[]` |
| 下划线 / 删除线 | 同上，画在行框底部/中部 | `quads[]` |
| 记号笔（手绘） | 按住拖动，半透明粗线，模拟荧光笔涂抹 | `paths[]` |
| 涂改带 | 不透明底色粗线，视觉遮盖（非真删除） | `paths[]` |
| 区域高亮 | 拖框，用于扫描件/图片型 PDF | `quads[]` |
| 便签 | 点击页面插入备注气泡，可展开编辑 | `point` |
| 橡皮擦 | 点击/划过删除命中的标注（可撤销） | — |

交互细节：

- 选中文字不弹浮动工具条；右键菜单提供颜色、高亮 / 下划线 / 删除线、复制，以及翻译 / 查词入口；
  使用高亮 / 下划线 / 删除线工具时则选中即落笔，适合连续标记。
- 同一段连续选区合并为一条标注；跨页选区按页拆分为多条，共享 `groupId`。
- 点击标注可选中、改色、加备注、删除；拖动与缩放排期 v1.1。
- 右侧「标注」面板按页列出，点击定位并闪烁。
- 撤销/重做覆盖增、删、改、移动，栈上限 100 步。
- v1.1：导出「带标注的新 PDF」（pdf-lib 扁平化），原文件永不修改。

### 4.4 阅读进度（回答「哪些读过了」）

- 每页有 `已读 / 未读` 状态。
- 自动判定（默认开）：页面 ≥80% 可见且停留 ≥3 秒 → 标记已读；可关闭。
- 手动：缩略图右键 / 工具栏按钮切换；支持「标记到此处」「清除本页」。
- 顶部细进度条 = 已读页数 / 总页数；缩略图右上角打勾。
- 最近文件列表显示每份文档的百分比进度。

### 4.5 搜索

- ⌘/Ctrl+F 唤起顶部搜索条，输入即搜（200ms 防抖）。
- 范围：当前文档全文；选项：区分大小写（整词匹配排期 v1.1）。
- 基于 pdf.js 文本层按页构建字符串缓存（LRU 20 页），命中项高亮并支持 Enter / Shift+Enter 上下跳转。
- 结果计数 `3/57`，无结果给出提示。

### 4.6 设置

主题（浅色/深色/跟随系统）、默认缩放、自动已读开关与时长、标注默认色与透明度、界面语言（中/英）、sidecar 存放策略、清空缓存、恢复默认。

### 4.7 快捷键

| 操作 | macOS | Windows |
|------|-------|---------|
| 打开 | ⌘O | Ctrl+O |
| 搜索 | ⌘F | Ctrl+F |
| 放大/缩小/重置 | ⌘± / ⌘0 | Ctrl± / Ctrl0 |
| 适合宽度 / 整页 | ⌘1 / ⌘2 | Ctrl+1 / Ctrl+2 |
| 上/下一页 | ↑↓ / PgUp PgDn | 同左 |
| 跳到首/末页 | ⌘↑ / ⌘↓ | Ctrl+Home/End |
| 高亮 / 下划线 / 删除线 | H / U / S | 同左 |
| 记号笔 / 橡皮擦 | P / E | 同左 |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Y |
| 标记本页已读 | R | R |
| 关闭文档 / 退出 | ⌘W / ⌘Q | Ctrl+W / Alt+F4 |

---

## 5. 数据设计

### 5.1 存放位置

- **默认（日常读写）**：本地 SQLite 库，WAL 模式：
  - macOS `~/Library/Application Support/PDFViewer/library.db`
  - Windows `%APPDATA%\PDFViewer\library.db`
- 表：`documents` / `reading` / `read_pages` / `annotations`；阅读位置只更新一行，标注按 id 增量 upsert。
- **便携格式**：`报告.pdf.pdfviewer.json`（schema v1）只在两种场景出现：
  1. 用户点「导出 .pdfviewer.json」；
  2. 打开时数据库里还没有该文档的状态，且同目录存在旧版 sidecar（一次性导入）。
- 旧 sidecar 导入后**不再回写**，也不会生成 `.bak`；用户可自行删除或保留作为备份。
- 设置与最近文件：`PDFViewer/settings.json` / `recent.json`。
- 原则：**永不修改原 PDF**；sidecar 丢失只丢标注，不丢文档。

### 5.2 指纹与冲突

- 内容指纹 = `size + sha256(前 1 MiB + 后 1 MiB)`，**不包含 mtime**；复制、恢复、移动文件不会改变身份。
- 数据库以 `content_id` 为唯一键，`path` 只是映射：移动/重命名 PDF 后仍能找回阅读数据。
- 所有写入在单个事务中完成；SQLite 自身提供多进程锁，配合 `busy_timeout=5s`。
- 显式导出仍用「临时文件 + fsync + rename」原子替换，避免半截 JSON。

### 5.3 Schema（v1）

```json
{
  "schema": 1,
  "doc": {
    "name": "report.pdf",
    "size": 12345678,
    "fingerprint": "12345678:9f2c...",
    "pages": 120
  },
  "reading": {
    "lastPage": 37,
    "scrollRatio": 0.42,
    "zoom": 1.25,
    "viewMode": "continuous",
    "readPages": [1, 2, 3, 4, 5],
    "updatedAt": "2026-11-22T08:30:00Z"
  },
  "annotations": [
    {
      "id": "0f3a…",
      "type": "highlight",
      "page": 12,
      "color": "#FFE066",
      "opacity": 0.45,
      "quads": [
        { "x": 0.118, "y": 0.342, "w": 0.512, "h": 0.021 }
      ],
      "text": "被选中的原文，便于检索与复制",
      "note": "",
      "createdAt": "2026-11-22T08:12:00Z",
      "updatedAt": "2026-11-22T08:12:00Z"
    },
    {
      "id": "7b1c…",
      "type": "ink",
      "page": 13,
      "color": "#E4572E",
      "opacity": 0.5,
      "width": 0.006,
      "paths": [[{ "x": 0.21, "y": 0.55 }, { "x": 0.23, "y": 0.56 }]]
    }
  ]
}
```

- `type` 枚举：`highlight | underline | strikeout | ink | redact | note | box`
- 所有坐标均为**归一化坐标**（见 5.4），与缩放、窗口大小、DPR 无关。
- `schema` 单调递增，Go 端负责迁移（v1 只需原样读写，预留 `migrate()` 入口）。
- 文件上限保护：单文档标注 > 20 MB 时提示并拒绝（防止异常数据拖垮 UI）。

### 5.4 坐标系统（关键约定）

- 基准视口 = `page.getViewport({ scale: 1, rotation: page.rotate })`（页面的固有旋转）。
- 存储：`x = 元素内 X / 基准宽`，`y = 元素内 Y / 基准高`，全部落在 `[0,1]`。
- 显示：叠加层 SVG 的 `viewBox` 设为基准宽高、`preserveAspectRatio="none"`，CSS 宽高 100%，缩放/窗口变化时零换算。
- 用户旋转 ≠ 0 时，渲染前对坐标做一次旋转矩阵变换（0/90/180/270 四组固定公式），存储值不变。
- 线宽同样归一化到页面宽度，保证 500% 放大时墨迹比例不变。

---

## 6. 关键技术实现

### 6.1 页面虚拟化与渲染调度

1. 打开文档后仅 `getPage()` 取每页尺寸（不渲染），生成占位 DOM，总高度 = Σ页高 + 间距。
2. `IntersectionObserver`（rootMargin 上下各 1.5 屏）维护「可见页集合」。
3. 渲染队列按「距视口距离」排序；可见页立即以目标 scale 渲染，相邻页空闲时低倍渲染。
4. 滚动离开的页面调用 `renderTask.cancel()`，超过 12 页的 canvas 释放为空白占位（保留尺寸），回收内存。
5. 缩放变化时先 CSS 缩放现有位图（瞬时反馈），300ms 防抖后按新 scale 重绘。

### 6.2 文本选择 → 归一化矩形

1. 监听页面文本层 `mouseup`，若 `selection` 非空且位于当前页内。
2. 遍历 `range.getClientRects()`，减去页面元素矩形，除以显示尺寸 → 归一化矩形。
3. 行合并：纵向重叠 > 50% 视为同一行；相邻行间距 < 0.6 行高视为同段，最终得到一组 `quads`。
4. 选中文本用 `selection.toString()` 存入 `text`，用于面板预览与全文检索。
5. 扫描件无文本层：自动提示切换「区域高亮」拖框工具。

### 6.3 标注叠加层

- 每页一个绝对定位容器，内含一个 SVG（矩形/路径）与少量 DOM（便签气泡）。
- `pointer-events` 按工具切换：选择模式仅标注元素可点，绘制模式整层接管。
- 墨迹采样：`pointermove` 按 4px 距离抽稀 + `requestAnimationFrame` 合帧，避免高频重绘。
- 绘制中的标注使用临时图层，`pointerup` 后提交到状态与撤销栈。

### 6.4 大文件加载

- Go 注册受控资源路由（如 `wails://app/pdf/<token>`），以 `http.ServeContent` 输出，天然支持 Range。
- 前端 `getDocument({ url, rangeChunkSize: 65536 })`，pdf.js 按需分片拉取，100 MB 文档秒开。
- token 与文档绑定、随窗口生命周期失效，杜绝前端任意读盘。
- 备选：≤20 MB 文件可直接走 binding 传 `Uint8Array`，减少一次 HTTP 往返。

### 6.5 撤销 / 重做

- 前端维护操作栈：`{ do, undo }` 闭包化，或「逆操作 + 快照」二选一；标注量小，采用逆操作。
- 每次提交防抖 500ms 落盘；关闭文档、切换文档、应用退出前强制 flush。
- 落盘失败（磁盘满/只读）在 UI 顶部提示，不阻塞继续阅读。

### 6.6 Go ⇄ 前端接口

| 绑定 | 说明 |
|------|------|
| `OpenDialog() (path, err)` | 系统文件选择框（*.pdf） |
| `OpenDocument(path) (DocInfo, err)` | 校验、计算内容指纹、分配 token、登记文档 |
| `GetDocumentURL(token) (url, err)` | 返回带 Range 的本地 URL |
| `LoadSidecar(token) (string, err)` | 从 SQLite 组装便携 JSON（前端解析） |
| `SaveReading(token, reading, pages)` | 只更新阅读位置/缩放/已读页 |
| `SaveAnnotations(token, json)` | 按 id 增量 upsert + 删除缺失项 |
| `ExportSidecar(token)` / `ImportSidecar(token)` | 显式导出/导入旁挂 JSON |
| `ListRecent() / TouchRecent(path) / RemoveRecent(path)` | 最近文件 |
| `GetSettings() / SaveSettings(json)` | 设置 |
| `ChooseExportPath() (path, err)` | v1.1 导出 |
| 事件 `doc:changed` | 外部文件变更通知 |

### 6.7 安全

- 仅加载本地资源，CSP 禁止外链；生产构建关闭 DevTools。
- 文件路径只经 Go 授权；sidecar JSON 前端解析前做 schema 校验，非法字段丢弃。
- 不执行 PDF 内嵌 JavaScript；不自动打开外部链接（点击链接需确认后交给系统浏览器）。

---

## 7. 目录结构

```
pdfviewer/
├── go.mod
├── main.go                    # Wails 入口
├── app.go                     # App 结构体、绑定方法
├── internal/
│   ├── library/               # 最近文件、路径校验
│   ├── annot/                 # 便携 JSON schema、校验、指纹、导出
│   ├── notestore/             # SQLite（documents/reading/read_pages/annotations）
│   ├── settings/              # 设置读写
│   └── pdfstream/             # Range 资源路由、token 管理
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts            # 启动、事件绑定
│       ├── viewer/            # pdf.js 封装、虚拟滚动、渲染调度、文本层
│       ├── annot/             # 工具、叠加层、选区换算、撤销栈、持久化
│       ├── ui/                # 工具栏、侧栏、搜索、对话框
│       ├── state/             # 轻量 store（订阅式）
│       └── styles/
├── build/                     # 图标、Info.plist、NSIS 配置
├── scripts/                   # build.sh（macOS/Linux）与 build.ps1（Windows）
├── Makefile                   # make mac / win / all 等快捷命令
└── docs/DESIGN.md
```

---

## 8. 构建与发布

| 场景 | 命令 |
|------|------|
| 开发热重载 | `make dev` 或 `wails dev` |
| macOS 通用包 | `make mac` 或 `wails build -platform darwin/universal` → `.app` |
| Windows 可执行文件 | `make win` 或 `wails build -platform windows/amd64` → `.exe` |
| Windows 安装包 | `make win-installer` 或 `wails build -platform windows/amd64 -nsis` |
| macOS + Windows | `make all`（需要 macOS 主机） |
| Windows（PowerShell） | `.\scripts\build.ps1 win` / `win-installer` |
| CI | GitHub Actions 矩阵：macos-latest / windows-latest，产物上传 Release |

- 签名：自用可 ad-hoc；分发需 Apple Developer ID + `notarytool` 公证，Windows 建议代码签名证书（可选）。
- Windows 若缺 WebView2 运行时，安装包内置引导器自动安装（Wails 默认行为）。
- 文件关联（双击 PDF 打开）与「打开方式」注册放到 v1.1（macOS 改 Info.plist，Windows 走 NSIS 注册表）。

---

## 9. 性能指标（验收口径）

| 指标 | 目标 |
|------|------|
| 冷启动到可交互 | < 1.5 s |
| 100 页文档首屏 | < 800 ms |
| 滚动帧率（中端笔记本） | ≥ 55 fps |
| 200 页文档 @150% 内存 | < 600 MB |
| 缩放/标注视觉反馈 | < 16 ms |
| 500 页文档打开（仅布局） | < 1.5 s |

---

## 10. 测试计划

- **Go 单测**：SQLite 增量读写、阅读状态 round-trip、标注 reconcile、sidecar 迁移/导入、破损 JSON 容错、指纹稳定性。
- **TS 单测（Vitest）**：归一化坐标往返、选区矩形合并、旋转变换、撤销栈、搜索命中映射。
- **手工矩阵**：
  - 系统：macOS 13/14/15（Intel + ARM）、Windows 10/11。
  - 文档：文本型 / 扫描型 / 加密（有密码、仅权限密码）/ 超大（>200 MB）/ 旋转页面 / 双栏 / 中日韩 / 从右到左 / 损坏文件。
  - 交互：捏合缩放、4K + 200% 系统缩放、深浅色切换、断网。
- Playwright 仅覆盖纯 Web 逻辑（用 mock PDF），Wails 壳层以手工回归为主。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| pdf.js worker 在 Wails 资源服务下加载失败 | 白屏/极慢 | Vite 配置 worker 为独立 ESM 产物，启动自检并回退到主线程模式 |
| WKWebView 捏合缩放整页 | 缩放错乱 | 拦截 `ctrl+wheel` 与 `gesture*`，`preventDefault`；CSS `touch-action` |
| 高倍缩放内存爆炸 | 崩溃 | 渲染 scale 上限 3 + 页面回收 + canvas 尺寸上限告警 |
| 扫描件无文本层 | 无法高亮句子 | 区域框选工具；OCR 列入 v2 |
| 多端/网盘与本地库不一致 | 标注丢失 | 内容指纹 + 事务 + busy_timeout + 显式导出/导入 |
| 加密/损坏 PDF | 打不开 | 捕获 pdf.js 异常，给明确错误码与「用系统预览打开」入口 |
| 双栏/复杂版式选区合并错误 | 高亮错位 | 按行 y 聚类 + x 排序，跨列断开；提供「手动框选」兜底 |
| 中文文本层字间空格 | 搜索/复制异常 | 文本归一化（去零宽字符、合并孤立空格），保留双向映射 |

---

## 12. 里程碑（估算）

| 阶段 | 内容 | 人日 |
|------|------|------|
| M0 | Wails 脚手架、打开文件、单页渲染、构建链路跑通 | 0.5 |
| M1 | 连续滚动 + 虚拟化、缩放、缩略图、大纲、搜索、记忆位置 | 2 |
| M2 | 文本选择 → 高亮/下划线/删除线、sidecar 持久化、撤销栈 | 2 |
| M3 | 手绘/涂改带/橡皮擦/便签、已读进度、主题、设置 | 1.5 |
| M4 | 打包、图标、CI、性能调优、测试与文档 | 1 |
| 合计 | | **~7 人日** |

---

## 13. 已确认事项（2026-11-22）

1. 技术路线：**Wails v2 + pdf.js**，Go 负责骨架与数据层。
2. 标注存储：**本地 SQLite 为主，旁挂 JSON 为可选导出/交换格式**；导出带标注 PDF 放到 v1.1。
3. 首版范围：**按本文档全量 MVP**。
4. 界面风格：**系统原生简洁**（暖灰纸面、细工具栏、松绿强调色）。

## 14. 实施记录（v0.1）

实际依赖：Wails v2.17.1、**pdfjs-dist 4.10.38（锁定版本）**、TypeScript 5.9、Vite 7。

与设计稿的差异与补充：

- 叠层结构：把工具栏、搜索条、空状态、加载层移到**不随文档滚动的 viewer shell** 中，避免浮动控件被滚走。
- 工具栏颜色选择与选中文字浮动条合并；高亮 / 下划线 / 删除线可一键落笔。
- 阅读进度去重：SQLite 只更新变化字段，内容未变化时不写库；不再每次滚动重写 JSON + `.bak`。
- 旋转：pdf.js 的文本层需要 `[data-main-rotation]` 旋转规则才能与 canvas 对齐；已补齐，旋转后选区与标注坐标仍然正确。
- `LoadSidecar` 直接返回原始 JSON 字符串（避免 `[]byte` 的 base64 编解码歧义）。
- 最近文件时间戳使用 Unix 毫秒，避免 Wails 对 `time.Time` 的绑定告警。
- 暂未实现：加密 PDF 密码弹窗、搜索整词、旋转持久化、导出 PDF、文件关联。
- 验证：`go test ./...` 通过；macOS 原生应用完成「启动 → 打开 → 渲染 → 标注 → 保存 → 重开恢复」链路；Windows amd64 交叉构建通过；前端在 Chromium 中完成交互回归。

### 兼容性事故记录：白页问题

初版使用 pdfjs-dist 6.5.x，在 Chromium 中正常，但在 macOS 的 WKWebView 中整页空白。原因：pdf.js 6 依赖一批 Safari 18 尚未实现的新 API，包括
`Map.prototype.getOrInsertComputed`、`Float16Array`、`URL.parse`、
`Uint8Array.fromBase64/toBase64` 等，`page.render()` 直接抛出
`TypeError: getOrInsertComputed is not a function`，而错误此前只写进控制台，画布保持空白。

修复方式：

1. 锁定 **pdfjs-dist 4.10.38**（兼容 Safari 16.4+，API 需求少得多）。
2. 在主线程与 module worker 中注入 `Promise.withResolvers`（以及 Map upsert）兼容垫片；
   worker 的垫片由构建脚本拼接在 pdf.worker.min.mjs 之前，保证先于 pdf.js 初始化执行。
3. 文本层 scale 变量从 `--total-scale-factor` 改为 v4 使用的 `--scale-factor`（同时保留两者）。
4. 渲染失败不再静默：记录到 `app.log`，并给出错误提示；开发模式下额外输出画布像素诊断。

## 15. 原始待确认事项（已归档）

1. **技术路线**：是否接受 Wails + pdf.js（Go 做骨架/数据层）？还是坚持尽量纯 Go（Fyne + MuPDF，工期约翻倍）？
2. **标注存储**：默认旁挂 JSON（非破坏）是否合适？是否 v1 就要「导出带标注的 PDF」？
3. **界面风格**：偏「系统原生简洁」还是「纸质阅读/复古工程手册」风？
4. **v1 范围**：搜索、缩略图、夜间模式是否都保留在首版？
