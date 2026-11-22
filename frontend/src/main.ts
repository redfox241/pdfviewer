import "./polyfills";
import "./styles.css";
import { api, errorText } from "./bridge";
import {
  COLORS,
  decodeSidecar,
  type Annotation,
  type DocInfo,
  type RecentEntry,
  type Settings,
  type Sidecar,
  type SidecarLoad,
  type Tool,
  uid,
} from "./model";
import { Viewer, type SearchResult, type SelectionPayload } from "./viewer";

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el as T;
}

function icon(name: string, cls = "icon"): string {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const viewerEl = $("#viewer");
const pagesEl = $("#pages");
const docTitle = $("#doc-title");
const docName = $("#doc-name");
const pageInput = $<HTMLInputElement>("#page-input");
const pageTotal = $("#page-total");
const zoomLabel = $("#btn-zoom");
const zoomBadge = $("#zoom-badge");
const progressFill = $("#progress-fill");
const sidebar = $("#sidebar");
const sidebarBody = $("#sidebar-body");
const palette = $("#tool-palette");
const paletteColors = $("#palette-colors");
const emptyEl = $("#empty");
const loadingEl = $("#loading");
const searchPanel = $("#search-panel");
const searchInput = $<HTMLInputElement>("#search-input");
const searchCount = $("#search-count");
const searchResultsEl = $("#search-results");
const toastHost = $("#toast-host");
const popoverHost = $("#popover-host");
const modalHost = $("#modal-host");
const btnRead = $("#btn-read");
const btnNight = $("#btn-night");

let settings: Settings;
let viewer: Viewer;
let currentDoc: DocInfo | null = null;
let sidecar: SidecarLoad | null = null;
let activeTool: Tool = "select";
let toolColor = "#ffd84d";
let pendingSelection: SelectionPayload | null = null;
let selectionColor = "#ffd84d";
let saveTimer = 0;
let dirty = false;
let lastPayload = "";
let saveChain: Promise<void> = Promise.resolve();
let scrollSaveTimer = 0;
let sidebarTab: "thumbs" | "outline" | "notes" = "thumbs";
let searchResults: SearchResult[] = [];
let searchIndex = -1;
let searchCase = false;
let searchTimer = 0;
let opening = false;
let platform = "web";
let zoomBadgeTimer = 0;

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  void api.ping().catch(() => undefined);
  platform = await api.platform().catch(() => "web");
  document.body.dataset.platform = platform;
  settings = await api.settings().catch(() => ({
    theme: "system",
    defaultZoom: "fit-width",
    autoRead: true,
    readDwellSec: 3,
    highlightColor: "#ffd84d",
    nightMode: false,
    language: "zh",
  }));

  selectionColor = settings.highlightColor;
  toolColor = settings.highlightColor;

  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (settings.theme === "system") applyTheme();
  });

  viewer = new Viewer(viewerEl, pagesEl, settings, {
    onReady: handleReady,
    onPageChange: handlePageChange,
    onZoomChange: handleZoomChange,
    onSelection: handleSelection,
    onAnnotationSelect: handleAnnotationSelect,
    onAnnotationsChange: handleAnnotationsChange,
    onReadChange: handleReadChange,
    onSearchResults: handleSearchResults,
    onNoteRequest: handleNoteRequest,
    onToast: (msg, kind) => {
      if (kind === "error") void api.logError(`toast: ${msg}`);
      toast(msg, kind ?? "info");
    },
    onDiagnostic: (msg) => void api.logError(`viewer: ${msg}`),
  });

  // Debug handle for automated checks during development.
  if (import.meta.env.DEV || location.protocol === "http:") {
    (window as any).__viewer = viewer;
  }

  viewer.setNightMode(settings.nightMode);
  updateNightButton();
  buildPalette();
  buildSelectionToolbar();
  wireUI();
  wireKeyboard();
  wireFileDrop();
  window.addEventListener("beforeunload", () => {
    void flushSave();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushSave();
  });
  await refreshRecent();

  const warnings = (await api.startupWarnings().catch(() => [] as string[])) ?? [];
  for (const w of warnings) toast(w, "error");

  const startup = await api.startupDocument().catch((e) => {
    void api.logError(`startupDocument failed: ${errorText(e)}`);
    return "";
  });
  if (startup) await openPath(startup);

  window.setTimeout(() => document.body.classList.add("ready"), 60);
}

function applyTheme(): void {
  const resolved =
    settings.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : settings.theme;
  document.documentElement.dataset.theme = resolved;
}

// ---------------------------------------------------------------- events

function handleReady(pages: number): void {
  setLoading(false);
  emptyEl.classList.add("hidden");
  palette.classList.remove("hidden");
  pageTotal.textContent = String(pages);
  updateProgress();
  updateReadButton();
  if (!sidebar.classList.contains("collapsed")) void refreshSidebar();
  updatePageInput(viewer.getCurrentPage());
  handleZoomChange(viewer.getScale(), viewer.getZoomMode());
  viewer.setTool(activeTool, toolColor);
}

function handlePageChange(page: number): void {
  updatePageInput(page);
  updateReadButton();
  viewer.syncThumbStates();
  scheduleSave(400);
}

function handleZoomChange(scale: number, mode: string): void {
  const pct = Math.round(scale * 75);
  zoomLabel.textContent = `${pct}%`;
  zoomBadge.textContent = `${pct}%`;
  zoomBadge.classList.remove("hidden");
  window.clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = window.setTimeout(() => zoomBadge.classList.add("hidden"), 900);
  zoomLabel.dataset.mode = mode;
  scheduleSave(600);
}

function handleSelection(sel: SelectionPayload | null): void {
  if (!sel || !sel.text.trim()) {
    hideSelectionToolbar();
    return;
  }
  pendingSelection = sel;
  showSelectionToolbar(sel);
}

function handleAnnotationSelect(ann: Annotation | null, anchor: DOMRect | null): void {
  if (!ann) {
    hideAnnotationPopover();
    return;
  }
  showAnnotationPopover(ann, anchor);
}

function handleAnnotationsChange(): void {
  scheduleSave(300);
  if (sidebarTab === "notes" && !sidebar.classList.contains("collapsed")) {
    void renderNotesPanel();
  }
  hideAnnotationPopover();
}

function handleReadChange(): void {
  updateProgress();
  updateReadButton();
  viewer.syncThumbStates();
  scheduleSave(400);
}

function handleSearchResults(results: SearchResult[], index: number): void {
  searchResults = results;
  searchIndex = index;
  renderSearchResults();
}

function handleNoteRequest(page: number, point: { x: number; y: number }, ann: Annotation | null): void {
  openNoteEditor(page, point, ann);
}

// ---------------------------------------------------------------- loading

function setLoading(on: boolean): void {
  loadingEl.classList.toggle("hidden", !on);
}

// ---------------------------------------------------------------- open/close

async function openDialog(): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const info = await api.openDialog();
    if (!info || !info.token) return;
    await openInfo(info);
  } catch (e) {
    toast(`打开失败：${errorText(e)}`, "error");
  } finally {
    opening = false;
  }
}

async function openPath(path: string): Promise<void> {
  if (opening) return;
  if (!path.toLowerCase().endsWith(".pdf")) {
    toast("只能打开 PDF 文件", "error");
    return;
  }
  opening = true;
  setLoading(true);
  try {
    const info = await api.openDocument(path);
    if (info?.token) await openInfo(info);
  } catch (e) {
    toast(`打开失败：${errorText(e)}`, "error");
    if (!currentDoc) setLoading(false);
  } finally {
    opening = false;
  }
}

async function openInfo(info: DocInfo): Promise<void> {
  await closeCurrent();
  setLoading(true);
  hideSelectionToolbar();
  hideAnnotationPopover();
  hideSearch();
  currentDoc = info;
  sidecar = null;
  dirty = false;
  lastPayload = "";
  docName.textContent = info.name;
  docTitle.title = info.path;
  pageInput.value = "1";
  pageTotal.textContent = "…";

  let load: SidecarLoad;
  try {
    load = await api.loadSidecar(info.token);
  } catch (e) {
    toast(`读取标注失败：${errorText(e)}`, "error");
    load = { data: "", path: "", portable: true, fingerprint: info.fingerprint, warning: "" };
  }
  sidecar = load;
  if (load.warning) toast(load.warning, "error");

  const decoded = decodeSidecar(load);
  if (decoded.fingerprint && decoded.fingerprint !== info.fingerprint) {
    toast("文档内容已变更，旧标注可能偏移", "error");
  }

  try {
    await viewer.open(info, decoded.reading, decoded.annotations);
  } catch (e) {
    setLoading(false);
    toast(`无法渲染该 PDF：${errorText(e)}`, "error");
    currentDoc = null;
    docName.textContent = "未打开文档";
    docTitle.title = "";
    emptyEl.classList.remove("hidden");
    palette.classList.add("hidden");
    try {
      await api.closeDocument(info.token);
    } catch {
      /* ignore */
    }
    return;
  }
  scheduleSave(600);

  if (import.meta.env.DEV || location.protocol === "http:") {
    window.setTimeout(() => {
      void viewer
        .diagnostics()
        .then((d) => console.info("pdf diagnostics", d))
        .catch((e) => console.warn("pdf diagnostics failed", e));
    }, 2500);
  }
}

async function closeCurrent(): Promise<void> {
  if (!currentDoc) return;
  await flushSave();
  const doc = currentDoc;
  currentDoc = null;
  try {
    await api.updateProgress(doc.token, viewer.getPages(), viewer.getProgress());
    await api.closeDocument(doc.token);
  } catch {
    /* ignore */
  }
  viewer.close();
  sidecar = null;
  lastPayload = "";
  hideSelectionToolbar();
  hideAnnotationPopover();
  hideSearch();
  emptyEl.classList.remove("hidden");
  palette.classList.add("hidden");
  docName.textContent = "未打开文档";
  docTitle.title = "";
  pageTotal.textContent = "0";
  pageInput.value = "1";
  progressFill.style.width = "0%";
  sidebarBody.innerHTML = "";
  await refreshRecent();
}

// ---------------------------------------------------------------- saving

function scheduleSave(delay = 400): void {
  if (!currentDoc) return;
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), delay);
}

function buildPayload(): string {
  const doc = currentDoc!;
  const payload: Sidecar = {
    schema: 1,
    doc: {
      name: doc.name,
      size: doc.size,
      fingerprint: doc.fingerprint,
      pages: viewer.getPages(),
    },
    reading: viewer.readingState(),
    annotations: viewer.getAnnotations(),
  };
  return JSON.stringify(payload);
}

function flushSave(): Promise<void> {
  const doc = currentDoc;
  if (!doc) return Promise.resolve();
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (!dirty) return saveChain;
  const payload = buildPayload();
  dirty = false;
  if (payload === lastPayload) return saveChain;
  lastPayload = payload;

  saveChain = saveChain.then(async () => {
    try {
      const path = await api.saveSidecar(doc.token, payload);
      if (sidecar) sidecar.path = path;
    } catch (e) {
      dirty = true;
      toast(`保存标注失败：${errorText(e)}`, "error");
    }
  });

  void api.updateProgress(doc.token, viewer.getPages(), viewer.getProgress()).catch(() => undefined);
  return saveChain;
}

// ---------------------------------------------------------------- toolbar

function updatePageInput(page: number): void {
  if (document.activeElement !== pageInput) pageInput.value = String(page);
}

function updateProgress(): void {
  const pages = viewer.getPages();
  const pct = pages ? (viewer.getReadPages().length / pages) * 100 : 0;
  progressFill.style.width = `${pct.toFixed(2)}%`;
}

function updateReadButton(): void {
  const read = viewer.getReadPages().includes(viewer.getCurrentPage());
  btnRead.classList.toggle("active", read);
}

function updateNightButton(): void {
  btnNight.classList.toggle("active", settings.nightMode);
  btnNight.innerHTML = icon(settings.nightMode ? "sun" : "moon");
}

function cycleZoomMode(): void {
  const mode = viewer.getZoomMode();
  if (mode === "fit-width") viewer.fitPage();
  else if (mode === "fit-page") viewer.actualSize();
  else viewer.fitWidth();
}

function buildPalette(): void {
  paletteColors.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c.value;
    b.title = c.name;
    b.dataset.color = c.value;
    b.addEventListener("click", () => {
      selectionColor = c.value;
      toolColor = c.value;
      viewer.setToolColor(c.value);
      updatePalette();
      if (activeTool === "select" || !isColorTool(activeTool)) {
        setTool("highlight");
      }
    });
    paletteColors.append(b);
  }
  palette.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool as Tool));
  });
}

function isColorTool(tool: Tool): boolean {
  return ["highlight", "underline", "strikeout", "ink", "redact", "box"].includes(tool);
}

function setTool(tool: Tool): void {
  activeTool = tool;
  viewer.setTool(tool, toolColor);
  updatePalette();
}

function updatePalette(): void {
  palette.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === activeTool);
  });
  paletteColors.querySelectorAll<HTMLButtonElement>(".swatch").forEach((b) => {
    b.classList.toggle("active", b.dataset.color === toolColor);
  });
  palette.classList.toggle("with-colors", isColorTool(activeTool));
  paletteColors.style.display = isColorTool(activeTool) ? "grid" : "none";
}

// ---------------------------------------------------------------- selection toolbar

let selToolbar: HTMLElement | null = null;

function buildSelectionToolbar(): void {
  const el = document.createElement("div");
  el.className = "sel-toolbar hidden";
  el.innerHTML = `
    <div class="sel-colors">${COLORS.map(
      (c) => `<button class="swatch" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`,
    ).join("")}</div>
    <div class="sel-actions">
      <button class="sel-btn" data-act="highlight" title="高亮">${icon("highlighter")}</button>
      <button class="sel-btn" data-act="underline" title="下划线">${icon("underline")}</button>
      <button class="sel-btn" data-act="strikeout" title="删除线">${icon("strike")}</button>
      <span class="sel-divider"></span>
      <button class="sel-btn" data-act="copy" title="复制">${icon("copy")}</button>
    </div>`;
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.querySelectorAll<HTMLButtonElement>(".sel-colors .swatch").forEach((b) => {
    b.addEventListener("click", () => {
      selectionColor = b.dataset.color!;
      applySelection("highlight", selectionColor);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".sel-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "copy") {
        void copySelection();
      } else if (act === "highlight" || act === "underline" || act === "strikeout") {
        applySelection(act, selectionColor);
      }
    });
  });
  popoverHost.append(el);
  selToolbar = el;
}

function showSelectionToolbar(sel: SelectionPayload): void {
  if (!selToolbar) return;
  selToolbar.classList.remove("hidden");
  const r = sel.rect;
  const tw = selToolbar.offsetWidth;
  const th = selToolbar.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.top - th - 10;
  if (top < 64) top = r.bottom + 10;
  left = Math.max(12, Math.min(window.innerWidth - tw - 12, left));
  top = Math.max(56, Math.min(window.innerHeight - th - 12, top));
  selToolbar.style.left = `${left}px`;
  selToolbar.style.top = `${top}px`;
}

function hideSelectionToolbar(): void {
  pendingSelection = null;
  selToolbar?.classList.add("hidden");
}

function applySelection(type: "highlight" | "underline" | "strikeout", color: string): void {
  if (!pendingSelection) return;
  viewer.annotateSelection(pendingSelection, type, color);
  hideSelectionToolbar();
}

async function copySelection(): Promise<void> {
  if (!pendingSelection) return;
  try {
    await navigator.clipboard.writeText(pendingSelection.text);
    toast("已复制");
  } catch {
    toast("复制失败", "error");
  }
}

// ---------------------------------------------------------------- annotation popover

let annPopover: HTMLElement | null = null;
let popoverAnnId: string | null = null;

function buildAnnotationPopover(): void {
  const el = document.createElement("div");
  el.className = "ann-popover hidden";
  el.innerHTML = `
    <div class="ann-row">
      ${COLORS.map((c) => `<button class="swatch" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join("")}
    </div>
    <div class="ann-row ann-actions">
      <button class="pop-btn" data-act="note">${icon("note")}<span>备注</span></button>
      <button class="pop-btn danger" data-act="delete">${icon("trash")}<span>删除</span></button>
    </div>`;
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.querySelectorAll<HTMLButtonElement>(".swatch").forEach((b) => {
    b.addEventListener("click", () => {
      if (!popoverAnnId) return;
      viewer.updateAnnotation(popoverAnnId, { color: b.dataset.color! });
      hideAnnotationPopover();
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".pop-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const id = popoverAnnId;
      if (!id) return;
      const ann = viewer.getAnnotation(id);
      if (!ann) return;
      if (b.dataset.act === "delete") {
        viewer.deleteAnnotations([id]);
        hideAnnotationPopover();
      } else if (b.dataset.act === "note") {
        hideAnnotationPopover();
        if (ann.type === "note") {
          openNoteEditor(ann.page, ann.point ?? { x: 0.5, y: 0.5 }, ann);
        } else {
          openNoteEditor(ann.page, ann.quads?.[0] ? { x: ann.quads[0].x, y: ann.quads[0].y } : { x: 0.5, y: 0.5 }, ann);
        }
      }
    });
  });
  popoverHost.append(el);
  annPopover = el;
}

function showAnnotationPopover(ann: Annotation, anchor: DOMRect | null): void {
  if (!annPopover) buildAnnotationPopover();
  if (!annPopover) return;
  popoverAnnId = ann.id;
  annPopover.classList.remove("hidden");
  const r = anchor ?? new DOMRect(window.innerWidth / 2, 120, 1, 1);
  const w = annPopover.offsetWidth;
  const h = annPopover.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  let top = r.top - h - 10;
  if (top < 56) top = r.bottom + 10;
  left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
  top = Math.max(56, Math.min(window.innerHeight - h - 12, top));
  annPopover.style.left = `${left}px`;
  annPopover.style.top = `${top}px`;
}

function hideAnnotationPopover(): void {
  popoverAnnId = null;
  annPopover?.classList.add("hidden");
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target as Node;
  if (annPopover && !annPopover.contains(t) && !(t instanceof Element && t.closest(".ann"))) {
    hideAnnotationPopover();
  }
  if (selToolbar && !selToolbar.contains(t)) hideSelectionToolbar();
});

// ---------------------------------------------------------------- note editor

function openNoteEditor(
  page: number,
  point: { x: number; y: number },
  ann: Annotation | null,
): void {
  const body = document.createElement("div");
  body.className = "note-editor";
  const label = document.createElement("label");
  label.textContent = ann ? `第 ${ann.page} 页备注` : `第 ${page} 页便签`;
  const ta = document.createElement("textarea");
  ta.placeholder = "写点想法…（支持多行）";
  ta.value = ann?.note ?? "";
  body.append(label, ta);

  showModal({
    title: ann ? "编辑备注" : "添加便签",
    body,
    actions: [
      { label: "取消", kind: "ghost", onClick: () => undefined },
      {
        label: "保存",
        kind: "primary",
        onClick: () => {
          const text = ta.value.trim();
          if (ann) {
            viewer.updateAnnotation(ann.id, { note: text });
          } else if (!text) {
            return undefined;
          } else {
            const now = new Date().toISOString();
            viewer.addAnnotations([
              {
                id: uid(),
                type: "note",
                page,
                color: "#f2b84b",
                point,
                note: text,
                createdAt: now,
                updatedAt: now,
              },
            ]);
          }
          if (text) toast("备注已保存");
          return undefined;
        },
      },
    ],
    focus: ta,
  });
}

// ---------------------------------------------------------------- sidebar

async function refreshSidebar(): Promise<void> {
  if (!currentDoc) {
    sidebarBody.innerHTML = "";
    return;
  }
  if (sidebarTab === "thumbs") {
    await viewer.renderThumbnails(sidebarBody);
  } else if (sidebarTab === "outline") {
    sidebarBody.innerHTML = "";
    const ok = await viewer.renderOutline(sidebarBody);
    if (!ok) {
      sidebarBody.innerHTML = `<div class="side-empty">此文档没有大纲</div>`;
    }
  } else {
    await renderNotesPanel();
  }
}

async function renderNotesPanel(): Promise<void> {
  const anns = [...viewer.getAnnotations()].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt));
  sidebarBody.innerHTML = "";
  if (!anns.length) {
    sidebarBody.innerHTML = `<div class="side-empty">还没有标注。选中文字后即可高亮。</div>`;
    return;
  }
  const byPage = new Map<number, Annotation[]>();
  for (const a of anns) {
    const arr = byPage.get(a.page) ?? [];
    arr.push(a);
    byPage.set(a.page, arr);
  }
  const wrap = document.createElement("div");
  wrap.className = "notes";
  for (const [page, list] of byPage) {
    const head = document.createElement("div");
    head.className = "notes-page";
    head.textContent = `第 ${page} 页`;
    wrap.append(head);
    for (const a of list) {
      const row = document.createElement("div");
      row.className = "note-row";
      const dot = document.createElement("i");
      dot.className = "note-dot";
      dot.style.background = a.color;
      const text = document.createElement("div");
      text.className = "note-text";
      const kind = document.createElement("span");
      kind.className = "note-kind";
      kind.textContent = typeLabel(a.type);
      const content = document.createElement("span");
      content.className = "note-content";
      const src = a.note || a.text || "(无文字)";
      content.textContent = src.length > 90 ? `${src.slice(0, 90)}…` : src;
      text.append(kind, content);
      row.append(dot, text);
      row.addEventListener("click", () => {
        viewer.goToPage(a.page);
        viewer.setSelectedAnnotation(a.id);
      });
      wrap.append(row);
    }
  }
  sidebarBody.append(wrap);
}

function typeLabel(type: Annotation["type"]): string {
  switch (type) {
    case "highlight":
      return "高亮";
    case "underline":
      return "下划线";
    case "strikeout":
      return "删除线";
    case "ink":
      return "笔记";
    case "redact":
      return "涂改";
    case "box":
      return "框选";
    case "note":
      return "便签";
    default:
      return type;
  }
}

function openSidebar(tab: "thumbs" | "outline" | "notes" = sidebarTab): void {
  sidebarTab = tab;
  sidebar.classList.remove("collapsed");
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  void refreshSidebar();
}

function closeSidebar(): void {
  sidebar.classList.add("collapsed");
}

// ---------------------------------------------------------------- search

function openSearch(): void {
  if (!currentDoc) {
    toast("请先打开一份 PDF");
    return;
  }
  searchPanel.classList.remove("hidden");
  const selected = window.getSelection()?.toString().trim() ?? "";
  if (selected && selected.length < 60 && document.activeElement !== searchInput) {
    searchInput.value = selected;
    void runSearchDebounced();
  }
  searchInput.focus();
  searchInput.select();
}

function closeSearch(): void {
  searchPanel.classList.add("hidden");
  window.clearTimeout(searchTimer);
  searchInput.value = "";
  searchResultsEl.innerHTML = "";
  searchCount.textContent = "";
  searchResults = [];
  searchIndex = -1;
  viewer.clearSearch();
}

function hideSearch(): void {
  closeSearch();
}

function runSearchDebounced(): void {
  window.clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) {
    searchCount.textContent = "";
    searchResultsEl.innerHTML = "";
    viewer.clearSearch();
    return;
  }
  searchTimer = window.setTimeout(() => {
    void viewer.runSearch(q, searchCase);
  }, 220);
}

function renderSearchResults(): void {
  if (!searchResults.length) {
    searchResultsEl.innerHTML = searchInput.value.trim()
      ? `<div class="side-empty">没有匹配项</div>`
      : "";
    searchCount.textContent = searchInput.value.trim() ? "0" : "";
    return;
  }
  searchCount.textContent = `${searchIndex + 1} / ${searchResults.length}`;
  searchResultsEl.innerHTML = "";
  const shown = searchResults.slice(0, 120);
  shown.forEach((r, i) => {
    const row = document.createElement("button");
    row.className = "search-hit" + (i === searchIndex ? " active" : "");
    const page = document.createElement("span");
    page.className = "hit-page";
    page.textContent = String(r.page);
    const snip = document.createElement("span");
    snip.className = "hit-snippet";
    snip.textContent = r.snippet;
    row.append(page, snip);
    row.addEventListener("click", () => viewer.gotoSearchResult(i));
    searchResultsEl.append(row);
  });
  const active = searchResultsEl.querySelector<HTMLElement>(".search-hit.active");
  if (active) {
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < searchResultsEl.scrollTop) searchResultsEl.scrollTop = top;
    else if (bottom > searchResultsEl.scrollTop + searchResultsEl.clientHeight) {
      searchResultsEl.scrollTop = bottom - searchResultsEl.clientHeight;
    }
  }
}

// ---------------------------------------------------------------- recent

async function refreshRecent(): Promise<void> {
  const list = $("#recent-list");
  let entries: RecentEntry[] = [];
  try {
    entries = (await api.recent()) ?? [];
  } catch {
    entries = [];
  }
  list.innerHTML = "";
  if (!entries.length) {
    const em = document.createElement("div");
    em.className = "recent-empty";
    em.textContent = "还没有最近阅读";
    list.append(em);
    return;
  }
  for (const entry of entries.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "recent-row";
    const main = document.createElement("button");
    main.className = "recent-main";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    const pct = Math.round((entry.progress || 0) * 100);
    meta.textContent = entry.pages
      ? `${entry.pages} 页 · 已读 ${pct}%`
      : "PDF 文档";
    const bar = document.createElement("i");
    bar.className = "recent-bar";
    bar.style.width = `${pct}%`;
    main.append(name, meta, bar);
    main.addEventListener("click", () => void openPath(entry.path));
    const del = document.createElement("button");
    del.className = "recent-del";
    del.title = "从列表移除";
    del.innerHTML = icon("close");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api.removeRecent(entry.path).catch(() => undefined);
      void refreshRecent();
    });
    row.append(main, del);
    list.append(row);
  }
}

// ---------------------------------------------------------------- settings

function openSettings(): void {
  const body = document.createElement("div");
  body.className = "settings";

  body.innerHTML = `
    <div class="field">
      <label>主题</label>
      <select data-k="theme">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>
    <div class="field">
      <label>默认缩放</label>
      <select data-k="defaultZoom">
        <option value="fit-width">适合宽度</option>
        <option value="fit-page">适合整页</option>
        <option value="actual">实际大小</option>
      </select>
    </div>
    <div class="field row">
      <label>夜间阅读（反色）</label>
      <input type="checkbox" data-k="nightMode" />
    </div>
    <div class="field row">
      <label>停留后自动标记已读</label>
      <input type="checkbox" data-k="autoRead" />
    </div>
    <div class="field inline">
      <label>停留时长（秒）</label>
      <input type="number" min="1" max="60" step="1" data-k="readDwellSec" />
    </div>
    <div class="field">
      <label>默认高亮颜色</label>
      <div class="settings-colors">${COLORS.map(
        (c) => `<button class="swatch" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`,
      ).join("")}</div>
    </div>
    <div class="field sidecar">
      <label>标注文件</label>
      <code>${sidecar?.path ? escapeHtml(sidecar.path) : "打开文档后显示"}</code>
      <div class="sidecar-actions">
        <button class="mini-link" data-act="reveal">在文件管理器中显示</button>
        <button class="mini-link" data-act="copy-path">复制路径</button>
      </div>
    </div>
    <div class="field meta-line">PDF Viewer ${"0.1.0"} · Go + Wails + pdf.js</div>
  `;

  const themeSel = body.querySelector<HTMLSelectElement>('[data-k="theme"]')!;
  const zoomSel = body.querySelector<HTMLSelectElement>('[data-k="defaultZoom"]')!;
  const night = body.querySelector<HTMLInputElement>('[data-k="nightMode"]')!;
  const auto = body.querySelector<HTMLInputElement>('[data-k="autoRead"]')!;
  const dwell = body.querySelector<HTMLInputElement>('[data-k="readDwellSec"]')!;
  themeSel.value = settings.theme;
  zoomSel.value = settings.defaultZoom;
  night.checked = settings.nightMode;
  auto.checked = settings.autoRead;
  dwell.value = String(settings.readDwellSec);

  let chosenColor = settings.highlightColor;
  const swatches = [...body.querySelectorAll<HTMLButtonElement>(".settings-colors .swatch")];
  const paint = () => swatches.forEach((s) => s.classList.toggle("active", s.dataset.color === chosenColor));
  paint();
  swatches.forEach((s) =>
    s.addEventListener("click", () => {
      chosenColor = s.dataset.color!;
      paint();
    }),
  );

  body.querySelector('[data-act="reveal"]')?.addEventListener("click", () => {
    if (sidecar?.path) void api.reveal(sidecar.path);
  });
  body.querySelector('[data-act="copy-path"]')?.addEventListener("click", async () => {
    if (!sidecar?.path) return;
    await navigator.clipboard.writeText(sidecar.path).then(() => toast("路径已复制")).catch(() => toast("复制失败", "error"));
  });

  showModal({
    title: "设置",
    body,
    actions: [
      { label: "取消", kind: "ghost", onClick: () => undefined },
      {
        label: "保存",
        kind: "primary",
        onClick: async () => {
          const next: Settings = {
            theme: themeSel.value as Settings["theme"],
            defaultZoom: zoomSel.value as Settings["defaultZoom"],
            autoRead: auto.checked,
            readDwellSec: Math.max(1, Math.min(60, Number(dwell.value) || 3)),
            highlightColor: chosenColor,
            nightMode: night.checked,
            language: settings.language,
          };
          settings = next;
          applyTheme();
          viewer.setSettings(next);
          updateNightButton();
          selectionColor = next.highlightColor;
          toolColor = next.highlightColor;
          viewer.setToolColor(next.highlightColor);
          try {
            await api.saveSettings(next);
            toast("设置已保存");
          } catch (e) {
            toast(`保存设置失败：${errorText(e)}`, "error");
          }
        },
      },
    ],
  });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ---------------------------------------------------------------- modal

interface ModalAction {
  label: string;
  kind?: "primary" | "ghost" | "danger";
  onClick: () => void | Promise<void> | undefined;
}

function showModal(opts: {
  title: string;
  body: HTMLElement;
  actions: ModalAction[];
  focus?: HTMLElement;
}): void {
  modalHost.innerHTML = "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");

  const head = document.createElement("div");
  head.className = "modal-head";
  const title = document.createElement("h2");
  title.textContent = opts.title;
  const close = document.createElement("button");
  close.className = "icon-btn small";
  close.innerHTML = icon("close");
  head.append(title, close);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "modal-body";
  bodyWrap.append(opts.body);

  const foot = document.createElement("div");
  foot.className = "modal-foot";

  const closeModal = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };

  for (const action of opts.actions) {
    const btn = document.createElement("button");
    btn.className = `modal-btn ${action.kind ?? "ghost"}`;
    btn.textContent = action.label;
    btn.addEventListener("click", async () => {
      const keep = await action.onClick();
      if (keep !== undefined) return;
      closeModal();
    });
    foot.append(btn);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  };
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", closeModal);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeModal();
  });

  modal.append(head, bodyWrap, foot);
  backdrop.append(modal);
  modalHost.append(backdrop);
  opts.focus?.focus();
}

// ---------------------------------------------------------------- toast

function toast(message: string, kind: "info" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastHost.append(el);
  window.setTimeout(() => el.classList.add("show"), 20);
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 220);
  }, kind === "error" ? 4200 : 2400);
}

// ---------------------------------------------------------------- wiring

function wireUI(): void {
  $("#btn-open").addEventListener("click", () => void openDialog());
  $("#btn-empty-open").addEventListener("click", () => void openDialog());

  $("#btn-prev").addEventListener("click", () => viewer.prevPage());
  $("#btn-next").addEventListener("click", () => viewer.nextPage());
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      viewer.goToPage(Number(pageInput.value) || 1);
      pageInput.blur();
    }
  });
  pageInput.addEventListener("blur", () => {
    viewer.goToPage(Number(pageInput.value) || 1);
  });

  $("#btn-zoom-out").addEventListener("click", () => viewer.zoomBy(1 / 1.2));
  $("#btn-zoom-in").addEventListener("click", () => viewer.zoomBy(1.2));
  $("#btn-zoom").addEventListener("click", cycleZoomMode);
  $("#btn-fit").addEventListener("click", () => viewer.fitWidth());
  $("#btn-rotate").addEventListener("click", () => viewer.rotate(90));

  $("#btn-search").addEventListener("click", () => {
    if (searchPanel.classList.contains("hidden")) openSearch();
    else closeSearch();
  });
  $("#btn-night").addEventListener("click", () => {
    settings.nightMode = !settings.nightMode;
    // Debug handle for automated checks during development.
  if (import.meta.env.DEV || location.protocol === "http:") {
    (window as any).__viewer = viewer;
  }

  viewer.setNightMode(settings.nightMode);
    updateNightButton();
    void api.saveSettings(settings).catch(() => undefined);
  });
  btnRead.addEventListener("click", () => viewer.toggleReadCurrent());

  $("#btn-sidebar").addEventListener("click", () => {
    if (sidebar.classList.contains("collapsed")) openSidebar();
    else closeSidebar();
  });
  $("#sidebar-close").addEventListener("click", closeSidebar);
  $("#btn-settings").addEventListener("click", openSettings);

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => openSidebar(tab.dataset.tab as "thumbs" | "outline" | "notes"));
  });

  searchInput.addEventListener("input", runSearchDebounced);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) viewer.prevSearchResult();
      else viewer.nextSearchResult();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  });
  $("#search-prev").addEventListener("click", () => viewer.prevSearchResult());
  $("#search-next").addEventListener("click", () => viewer.nextSearchResult());
  $("#search-close").addEventListener("click", closeSearch);
  $("#search-case").addEventListener("click", () => {
    searchCase = !searchCase;
    $("#search-case").classList.toggle("active", searchCase);
    runSearchDebounced();
  });

  viewerEl.addEventListener("scroll", () => {
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(() => scheduleSave(50), 1200);
  });

  window.addEventListener("resize", () => {
    hideSelectionToolbar();
    hideAnnotationPopover();
  });

}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const typing =
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);

    if (key === "Escape") {
      if (!searchPanel.classList.contains("hidden")) {
        closeSearch();
        return;
      }
      hideSelectionToolbar();
      hideAnnotationPopover();
      if (activeTool !== "select") setTool("select");
      return;
    }

    if (mod && key.toLowerCase() === "o") {
      e.preventDefault();
      void openDialog();
      return;
    }
    if (mod && key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
      return;
    }
    if (mod && (key === "=" || key === "+")) {
      e.preventDefault();
      viewer.zoomBy(1.2);
      return;
    }
    if (mod && key === "-") {
      e.preventDefault();
      viewer.zoomBy(1 / 1.2);
      return;
    }
    if (mod && key === "0") {
      e.preventDefault();
      viewer.actualSize();
      return;
    }
    if (mod && key === "1") {
      e.preventDefault();
      viewer.fitWidth();
      return;
    }
    if (mod && key === "2") {
      e.preventDefault();
      viewer.fitPage();
      return;
    }
    if (mod && key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) viewer.redo();
      else viewer.undo();
      return;
    }
    if (mod && key.toLowerCase() === "y") {
      e.preventDefault();
      viewer.redo();
      return;
    }

    if (mod || e.altKey) return;
    if (typing) return;
    if (!currentDoc) return;

    switch (key) {
      case "PageDown":
      case " ":
        e.preventDefault();
        viewerEl.scrollBy({ top: viewerEl.clientHeight * 0.92, behavior: "smooth" });
        break;
      case "PageUp":
        e.preventDefault();
        viewerEl.scrollBy({ top: -viewerEl.clientHeight * 0.92, behavior: "smooth" });
        break;
      case "ArrowDown":
        e.preventDefault();
        viewerEl.scrollBy({ top: 88, behavior: "auto" });
        break;
      case "ArrowUp":
        e.preventDefault();
        viewerEl.scrollBy({ top: -88, behavior: "auto" });
        break;
      case "Home":
        e.preventDefault();
        viewer.goToPage(1);
        break;
      case "End":
        e.preventDefault();
        viewer.goToPage(viewer.getPages());
        break;
      case "h":
      case "H":
        if (pendingSelection) applySelection("highlight", selectionColor);
        else setTool("highlight");
        break;
      case "u":
      case "U":
        if (pendingSelection) applySelection("underline", selectionColor);
        else setTool("underline");
        break;
      case "s":
      case "S":
        if (pendingSelection) applySelection("strikeout", selectionColor);
        else setTool("strikeout");
        break;
      case "p":
      case "P":
        setTool("ink");
        break;
      case "e":
      case "E":
        setTool("eraser");
        break;
      case "n":
      case "N":
        setTool("note");
        break;
      case "v":
      case "V":
        setTool("select");
        break;
      case "r":
      case "R":
        viewer.toggleReadCurrent();
        break;
      default:
        break;
    }
  });
}

function wireFileDrop(): void {
  const rt = (window as any).runtime;
  rt?.EventsOn?.("wails:file-drop", (_x: number, _y: number, paths: string[]) => {
    const pdf = (paths ?? []).find((p) => p.toLowerCase().endsWith(".pdf"));
    if (pdf) void openPath(pdf);
    else if (paths?.length) toast("只能打开 PDF 文件", "error");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (settings?.theme === "system") applyTheme();
  });

window.addEventListener("error", (e) => {
  void api.logError(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  void api.logError(`unhandled rejection: ${r instanceof Error ? r.stack : String(r)}`);
});

void boot().catch((e) => {
  console.error(e);
  const detail =
    e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
  void api.logError(`boot failed: ${detail}`);
  document.body.innerHTML = `<pre class="boot-error">启动失败：${escapeHtml(errorText(e))}</pre>`;
});
