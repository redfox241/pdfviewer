import "./polyfills";
import "./styles.css";
import { api, errorText } from "./bridge";
import { DocumentSave, removeDocumentTab, SerialQueue } from "./document-operations";
import {
  COLORS,
  decodeSidecar,
  type Annotation,
  type DocInfo,
  type InstallCandidate,
  type PluginInfo,
  type PluginKind,
  type RecentEntry,
  type Settings,
  type SidecarLoad,
  type Tool,
  uid,
} from "./model";
import { Viewer, type SearchResult, type SelectionPayload } from "./viewer";
import { buildPrintPlan, exportSummary, planSummary, type PrintOptions } from "./printcore";
import { runExport, runPrint, type PrintContext, type PrintToast } from "./print";

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el as T;
}

function icon(name: string, cls = "icon"): string {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const viewerHost = $("#viewer-host");
const tabList = $("#doc-tab-list");
const pageInput = $<HTMLInputElement>("#page-input");
const pageTotal = $("#page-total");
const zoomLabel = $("#btn-zoom");
const btnSpread = $<HTMLButtonElement>("#btn-spread");
const zoomBadge = $("#zoom-badge");
const progressFill = $("#progress-fill");
const appEl = $("#app");
const workspaceEl = $(".workspace");
const viewerShell = $(".viewer-shell");
const progressLine = $(".progress-line");
const sidebar = $("#sidebar");
const sidebarBody = $("#sidebar-body");
const palette = $("#tool-palette");
const paletteGrip = $<HTMLButtonElement>("#palette-grip");
const paletteColors = $("#palette-colors");
const dockOverlay = $("#dock-overlay");
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
const btnPrint = $<HTMLButtonElement>("#btn-print");

interface DocTab {
  id: string;
  info: DocInfo;
  viewer: Viewer;
  scroller: HTMLElement;
  pages: HTMLElement;
  tabEl: HTMLElement;
  sidecar: SidecarLoad | null;
  ready: boolean;
  closing: boolean;
  readingTimer: number;
  annotationsTimer: number;
  scrollSaveTimer: number;
  readingSave: DocumentSave<ReturnType<Viewer["readingState"]>>;
  annotationsSave: DocumentSave<Annotation[]>;
}

type ToolDock = "top" | "left" | "right";

const TOOL_DOCK_KEY = "pdfviewer.toolDock";
const TOOL_DOCK_ORDER: ToolDock[] = ["top", "left", "right"];
const TOOL_DOCK_LABELS: Record<ToolDock, string> = {
  top: "顶部",
  left: "左侧",
  right: "右侧",
};

let toolDock: ToolDock = "top";
let dockDragging = false;
let dockTarget: ToolDock | null = null;

let settings: Settings;
let viewer: Viewer;
let activeTab: DocTab | null = null;
const tabs: DocTab[] = [];
let currentDoc: DocInfo | null = null;
let sidecar: SidecarLoad | null = null;
let activeTool: Tool = "select";
let toolColor = "#ffd84d";
let pendingSelection: SelectionPayload | null = null;
let selectionColor = "#ffd84d";
let sidebarTab: "thumbs" | "outline" | "notes" = "thumbs";
let searchResults: SearchResult[] = [];
let searchIndex = -1;
let searchCase = false;
let searchTimer = 0;
let opening = false;
let quitting = false;
const openQueue = new SerialQueue();
let platform = "web";
let zoomBadgeTimer = 0;
let plugins: PluginInfo[] = [];

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
    printIncludeAnnotations: true,
    printRangeMode: "all" as const,
    printOnlyAnnotated: false,
    printConfigured: true,
  }));

  selectionColor = settings.highlightColor;
  toolColor = settings.highlightColor;
  void refreshPlugins();

  applyTheme();
  updateNightButton();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (settings.theme === "system") applyTheme();
  });

  buildPalette();
  wireToolDock();
  applyToolDock(readToolDock(), false);
  wireUI();
  wireKeyboard();
  wireFileDrop();
  wireQuitSave();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !quitting) {
      void flushSave().catch(reportSaveError);
    }
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

function updatePrintButton(): void {
  btnPrint.disabled = !activeTab || !activeTab.ready || opening;
}

function updateSpreadButton(): void {
  const ready = activeTab?.ready ?? false;
  const spread = activeTab?.viewer.isTwoPageView() ?? false;
  btnSpread.disabled = !ready;
  btnSpread.classList.toggle("active", spread);
  btnSpread.setAttribute("aria-pressed", String(spread));
  btnSpread.title = spread ? "切换到单页视图" : "切换到双页视图";
}

// ---------------------------------------------------------------- events

function handleReady(tab: DocTab, pages: number): void {
  tab.ready = true;
  if (activeTab !== tab) return;
  setLoading(false);
  emptyEl.classList.add("hidden");
  palette.classList.remove("hidden");
  pageTotal.textContent = String(pages);
  updateProgress(tab);
  updateReadButton(tab);
  updatePrintButton();
  updateSpreadButton();
  if (!sidebar.classList.contains("collapsed")) void refreshSidebar();
  updatePageInput(tab.viewer.getCurrentPage());
  handleZoomChange(tab, tab.viewer.getScale(), tab.viewer.getZoomMode());
  tab.viewer.setTool(activeTool, toolColor);
}

function handlePageChange(tab: DocTab, page: number): void {
  if (activeTab === tab) {
    updatePageInput(page);
    updateReadButton(tab);
    tab.viewer.syncThumbStates();
  }
  scheduleReadingSave(tab, 400);
}

function handleZoomChange(tab: DocTab, scale: number, mode: string): void {
  if (activeTab === tab) applyZoomUI(scale, mode, true);
  scheduleReadingSave(tab, 600);
}

function applyZoomUI(scale: number, mode: string, flash: boolean): void {
  const pct = Math.round(scale * 75);
  zoomLabel.textContent = `${pct}%`;
  zoomLabel.dataset.mode = mode;
  if (!flash) return;
  zoomBadge.textContent = `${pct}%`;
  zoomBadge.classList.remove("hidden");
  window.clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = window.setTimeout(() => zoomBadge.classList.add("hidden"), 900);
}

function handleSelection(tab: DocTab, sel: SelectionPayload | null): void {
  if (activeTab !== tab) return;
  if (!sel || !sel.text.trim()) {
    clearPendingSelection();
    return;
  }
  // Selection alone does not open anything: annotations and translation live
  // in the right-click menu, so left-drag selection stays unobtrusive.
  pendingSelection = sel;
}

function handleAnnotationSelect(tab: DocTab, ann: Annotation | null, anchor: DOMRect | null): void {
  if (activeTab !== tab) return;
  if (!ann) {
    hideAnnotationPopover();
    return;
  }
  showAnnotationPopover(ann, anchor);
}

function handleAnnotationsChange(tab: DocTab): void {
  scheduleAnnotationsSave(tab, 300);
  if (activeTab !== tab) return;
  if (sidebarTab === "notes" && !sidebar.classList.contains("collapsed")) {
    void renderNotesPanel();
  }
  hideAnnotationPopover();
}

function handleReadChange(tab: DocTab): void {
  if (activeTab === tab) {
    updateProgress(tab);
    updateReadButton(tab);
    tab.viewer.syncThumbStates();
  }
  scheduleReadingSave(tab, 400);
}

function handleSearchResults(tab: DocTab, results: SearchResult[], index: number): void {
  if (activeTab !== tab) return;
  searchResults = results;
  searchIndex = index;
  renderSearchResults();
}

function handleNoteRequest(tab: DocTab, page: number, point: { x: number; y: number }, ann: Annotation | null): void {
  if (activeTab !== tab) return;
  openNoteEditor(page, point, ann);
}

// ---------------------------------------------------------------- loading

function setLoading(on: boolean): void {
  loadingEl.classList.toggle("hidden", !on);
}

// ---------------------------------------------------------------- tabs

function createTab(info: DocInfo): DocTab {
  const scroller = document.createElement("main");
  scroller.className = "viewer tab-viewer";
  scroller.dataset.tool = activeTool;
  const pages = document.createElement("div");
  pages.className = "pages";
  scroller.append(pages);
  viewerHost.append(scroller);

  const tabEl = document.createElement("div");
  tabEl.className = "doc-tab";
  tabEl.title = info.path;
  tabEl.setAttribute("role", "tab");
  tabEl.innerHTML = `${icon("file")}<span class="doc-tab-name"></span><button class="doc-tab-close" type="button" title="关闭 (⌘W)">${icon("close")}</button>`;
  const nameEl = tabEl.querySelector(".doc-tab-name")!;
  nameEl.textContent = info.name;

  const tab: DocTab = {
    id: uid(),
    info,
    viewer: null as unknown as Viewer,
    scroller,
    pages,
    tabEl,
    sidecar: null,
    ready: false,
    closing: false,
    readingTimer: 0,
    annotationsTimer: 0,
    scrollSaveTimer: 0,
    readingSave: new DocumentSave((payload) => api.saveReading(info.token, payload, tab.viewer.getPages())),
    annotationsSave: new DocumentSave((payload) => api.saveAnnotations(info.token, payload)),
  };

  tab.viewer = new Viewer(scroller, pages, settings, {
    onReady: (count) => handleReady(tab, count),
    onPageChange: (page) => handlePageChange(tab, page),
    onZoomChange: (scale, mode) => handleZoomChange(tab, scale, mode),
    onSelection: (sel) => handleSelection(tab, sel),
    onAnnotationSelect: (ann, anchor) => handleAnnotationSelect(tab, ann, anchor),
    onAnnotationsChange: () => handleAnnotationsChange(tab),
    onReadChange: () => handleReadChange(tab),
    onSearchResults: (results, index) => handleSearchResults(tab, results, index),
    onNoteRequest: (page, point, ann) => handleNoteRequest(tab, page, point, ann),
    onToast: (msg, kind) => {
      if (kind === "error") void api.logError(`toast: ${msg}`);
      toast(msg, kind ?? "info");
    },
    onDiagnostic: (msg) => void api.logError(`viewer ${info.name}: ${msg}`),
  });
  tab.viewer.setNightMode(settings.nightMode);

  scroller.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(tab.scrollSaveTimer);
      tab.scrollSaveTimer = window.setTimeout(() => scheduleReadingSave(tab, 50), 1200);
    },
    { passive: true },
  );

  tabEl.addEventListener("click", () => activateTab(tab));
  tabEl.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      void closeTab(tab);
    }
  });
  tabEl.querySelector(".doc-tab-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(tab);
  });

  return tab;
}

function renderTabs(): void {
  tabList.innerHTML = "";
  for (const tab of tabs) {
    const isActive = tab === activeTab;
    tab.tabEl.classList.toggle("active", isActive);
    tab.tabEl.setAttribute("aria-selected", isActive ? "true" : "false");
    tabList.append(tab.tabEl);
  }
  const activeEl = activeTab?.tabEl;
  activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function activateTab(tab: DocTab): void {
  if (tab.closing) return;
  if (activeTab !== tab) {
    if (activeTab) {
      if (!searchPanel.classList.contains("hidden")) closeSearch();
      hideContextMenu();
      hideTransCard();
      hideAnnotationPopover();
      activeTab.viewer.scrollRatio();
      activeTab.scroller.classList.remove("active");
      activeTab.tabEl.classList.remove("active");
    }
    activeTab = tab;
    viewer = tab.viewer;
    currentDoc = tab.info;
    sidecar = tab.sidecar;
    clearPendingSelection();
    tab.scroller.classList.add("active");
    tab.tabEl.classList.add("active");
  }

  renderTabs();
  syncActiveUI(tab);
  setLoading(!tab.ready);
  if (tab.ready) {
    viewer.setTool(activeTool, toolColor);
    viewer.setNightMode(settings.nightMode);
  }
  if (!sidebar.classList.contains("collapsed")) void refreshSidebar();

  // Debug handle for automated checks during development.
  if (import.meta.env.DEV || location.protocol === "http:") {
    (window as any).__viewer = viewer;
  }
}

function syncActiveUI(tab: DocTab): void {
  const v = tab.viewer;
  emptyEl.classList.add("hidden");
  updatePrintButton();
  updateSpreadButton();
  if (!tab.ready) {
    palette.classList.add("hidden");
    pageTotal.textContent = "…";
    pageInput.value = "1";
    progressFill.style.width = "0%";
    btnRead.classList.remove("active");
    return;
  }
  palette.classList.remove("hidden");
  pageTotal.textContent = String(v.getPages());
  updatePageInput(v.getCurrentPage());
  applyZoomUI(v.getScale(), v.getZoomMode(), false);
  updateProgress(tab);
  updateReadButton(tab);
}

function showEmptyState(): void {
  activeTab = null;
  currentDoc = null;
  sidecar = null;
  clearPendingSelection();
  hideContextMenu();
  hideTransCard();
  hideAnnotationPopover();
  resetSearchUI();
  setLoading(false);
  emptyEl.classList.remove("hidden");
  palette.classList.add("hidden");
  pageTotal.textContent = "0";
  pageInput.value = "1";
  progressFill.style.width = "0%";
  btnRead.classList.remove("active");
  sidebarBody.innerHTML = "";
  updatePrintButton();
  updateSpreadButton();
  renderTabs();
  void refreshRecent();
}

function resetSearchUI(): void {
  searchPanel.classList.add("hidden");
  window.clearTimeout(searchTimer);
  searchInput.value = "";
  searchResultsEl.innerHTML = "";
  searchCount.textContent = "";
  searchResults = [];
  searchIndex = -1;
}

async function closeTab(tab: DocTab, save = true): Promise<void> {
  if (tab.closing || quitting) return;
  tab.closing = true;
  try {
    if (save && tab.ready) await flushTabUntilSaved(tab);
  } catch (e) {
    tab.closing = false;
    if (!activeTab) activateTab(tab);
    toast(`未关闭「${tab.info.name}」：${errorText(e)}`, "error", {
      label: "重试关闭",
      onClick: () => void closeTab(tab),
    });
    return;
  }

  const wasActive = activeTab === tab;
  if (wasActive && !searchPanel.classList.contains("hidden")) closeSearch();
  const next = removeDocumentTab(tabs, tab, activeTab, (candidate) => !candidate.closing);
  window.clearTimeout(tab.readingTimer);
  window.clearTimeout(tab.annotationsTimer);
  window.clearTimeout(tab.scrollSaveTimer);

  const pages = tab.ready ? tab.viewer.getPages() : 0;
  const progress = tab.ready ? tab.viewer.getProgress() : 0;
  if (wasActive) activeTab = null;
  tab.viewer.destroy();
  tab.scroller.remove();
  tab.tabEl.remove();
  if (wasActive) {
    if (next) activateTab(next);
    else showEmptyState();
  } else {
    renderTabs();
  }

  if (tab.ready) {
    try {
      await api.updateProgress(tab.info.token, pages, progress);
    } catch {
      /* ignore */
    }
  }
  try {
    await api.closeDocument(tab.info.token);
  } catch {
    /* ignore */
  }

  await refreshRecent();
}

// ---------------------------------------------------------------- open/close

function queueOpen(load: () => Promise<DocInfo>, showLoading = false): Promise<void> {
  return openQueue.run(async () => {
    if (quitting) return;
    opening = true;
    updatePrintButton();
    if (showLoading) setLoading(true);
    try {
      const info = await load();
      if (info?.token) {
        if (quitting) await api.closeDocument(info.token);
        else await openInfo(info);
      }
    } catch (e) {
      toast(`打开失败：${errorText(e)}`, "error");
    } finally {
      opening = false;
      setLoading(!!activeTab && !activeTab.ready);
      updatePrintButton();
    }
  });
}

function openDialog(): Promise<void> {
  return queueOpen(api.openDialog);
}

async function openPath(path: string): Promise<void> {
  if (!path.toLowerCase().endsWith(".pdf")) {
    toast("只能打开 PDF 文件", "error");
    return;
  }
  await queueOpen(() => api.openDocument(path), true);
}

async function openInfo(info: DocInfo): Promise<void> {
  const existing = tabs.find((t) => t.info.path === info.path);
  if (existing) {
    try {
      await api.closeDocument(info.token);
    } catch {
      /* ignore */
    }
    activateTab(existing);
    return;
  }

  hideContextMenu();
  hideTransCard();
  hideAnnotationPopover();
  hideSearch();
  setLoading(true);

  const tab = createTab(info);
  tabs.push(tab);
  activateTab(tab);

  let load: SidecarLoad;
  try {
    load = await api.loadSidecar(info.token);
  } catch (e) {
    toast(`读取标注失败：${errorText(e)}`, "error");
    load = { data: "", path: "", portable: false, fingerprint: info.fingerprint, warning: "" };
  }
  tab.sidecar = load;
  if (activeTab === tab) sidecar = load;
  if (load.warning) toast(load.warning, "error");
  if (tab.closing) return;

  const decoded = decodeSidecar(load);
  if (decoded.fingerprint && decoded.fingerprint !== info.fingerprint) {
    toast("文档内容已变更，旧标注可能偏移", "error");
  }

  try {
    await tab.viewer.open(info, decoded.reading, decoded.annotations);
  } catch (e) {
    if (tab.closing) return;
    toast(`无法渲染该 PDF：${errorText(e)}`, "error");
    await closeTab(tab, false);
    return;
  }
  if (tab.closing) return;
  tab.annotationsSave.seed(tab.viewer.getAnnotations());
  scheduleReadingSave(tab, 600);

  if (import.meta.env.DEV || location.protocol === "http:") {
    window.setTimeout(() => {
      void tab.viewer
        .diagnostics()
        .then((d) => console.info("pdf diagnostics", d))
        .catch((e) => console.warn("pdf diagnostics failed", e));
    }, 2500);
  }
}

async function reloadCurrent(): Promise<void> {
  const tab = activeTab;
  if (!tab) return;
  const path = tab.info.path;
  // Do not flush: the point of reloading is to pick up the just-imported data.
  await closeTab(tab, false);
  await openPath(path);
}

// ---------------------------------------------------------------- saving

// Reading state (small, hot path) and annotations (larger, rare) are saved
// independently. SQLite updates rows in place, so page turns and scroll idle
// no longer rewrite a JSON file (and its .bak) every time.

function scheduleReadingSave(tab: DocTab | null = activeTab, delay = 600): void {
  if (!tab || tab.closing || quitting) return;
  window.clearTimeout(tab.readingTimer);
  tab.readingTimer = window.setTimeout(() => {
    if (!tab.closing && !quitting) void flushReading(tab).catch(reportSaveError);
  }, delay);
}

async function flushReading(tab: DocTab): Promise<void> {
  window.clearTimeout(tab.readingTimer);
  const state = tab.viewer.readingState();
  const changed = !tab.readingSave.matches(state);
  try {
    await tab.readingSave.flush(state);
  } catch (e) {
    throw new Error(`保存阅读进度失败：${errorText(e)}`);
  }
  if (changed && tabs.includes(tab)) {
    void api.updateProgress(tab.info.token, tab.viewer.getPages(), tab.viewer.getProgress())
      .catch(() => undefined);
  }
}

function scheduleAnnotationsSave(tab: DocTab | null = activeTab, delay = 400): void {
  if (!tab || tab.closing || quitting) return;
  window.clearTimeout(tab.annotationsTimer);
  tab.annotationsTimer = window.setTimeout(() => {
    if (!tab.closing && !quitting) void flushAnnotations(tab).catch(reportSaveError);
  }, delay);
}

async function flushAnnotations(tab: DocTab): Promise<void> {
  window.clearTimeout(tab.annotationsTimer);
  try {
    await tab.annotationsSave.flush(tab.viewer.getAnnotations());
  } catch (e) {
    throw new Error(`保存标注失败：${errorText(e)}`);
  }
}

async function waitForSaves(saves: Promise<void>[]): Promise<void> {
  for (const result of await Promise.allSettled(saves)) {
    if (result.status === "rejected") throw result.reason;
  }
}

async function flushTabUntilSaved(tab: DocTab): Promise<void> {
  while (tabs.includes(tab)) {
    await waitForSaves([flushReading(tab), flushAnnotations(tab)]);
    if (tab.readingSave.matches(tab.viewer.readingState()) &&
        tab.annotationsSave.matches(tab.viewer.getAnnotations())) return;
  }
}

function flushSave(): Promise<void> {
  return waitForSaves(tabs.filter((t) => t.ready).map(flushTabUntilSaved));
}

function reportSaveError(e: unknown): void {
  toast(errorText(e), "error");
}

function wireQuitSave(): void {
  const rt = (window as Window & { runtime?: {
    EventsOn?: (event: string, callback: () => void) => void;
  } }).runtime;
  if (!rt?.EventsOn) return;
  rt.EventsOn("pdfviewer:save-before-quit", () => void saveBeforeQuit());
  void api.enableSaveOnQuit().catch(() => undefined);
}

async function saveBeforeQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  appEl.inert = true;
  modalHost.inert = true;
  try {
    await flushSave();
    await api.quitAfterSave();
  } catch (e) {
    quitting = false;
    appEl.inert = false;
    modalHost.inert = false;
    toast(`未退出：${errorText(e)}`, "error", {
      label: "重试退出",
      onClick: () => void saveBeforeQuit(),
    });
  }
}

// ---------------------------------------------------------------- toolbar

function updatePageInput(page: number): void {
  if (document.activeElement !== pageInput) pageInput.value = String(page);
}

function updateProgress(tab: DocTab | null = activeTab): void {
  if (!tab) {
    progressFill.style.width = "0%";
    return;
  }
  const pages = tab.viewer.getPages();
  const pct = pages ? (tab.viewer.getReadPages().length / pages) * 100 : 0;
  progressFill.style.width = `${pct.toFixed(2)}%`;
}

function updateReadButton(tab: DocTab | null = activeTab): void {
  if (!tab) {
    btnRead.classList.remove("active");
    return;
  }
  const read = tab.viewer.getReadPages().includes(tab.viewer.getCurrentPage());
  btnRead.classList.toggle("active", read);
}

function updateNightButton(): void {
  btnNight.classList.toggle("active", settings.nightMode);
  btnNight.innerHTML = icon(settings.nightMode ? "sun" : "moon");
}

function cycleZoomMode(): void {
  if (!activeTab) return;
  const mode = viewer.getZoomMode();
  if (mode === "fit-width") viewer.fitPage();
  else if (mode === "fit-page") viewer.actualSize();
  else viewer.fitWidth();
}

// ---------------------------------------------------------------- tool dock

function readToolDock(): ToolDock {
  try {
    const saved = localStorage.getItem(TOOL_DOCK_KEY);
    if (saved === "top" || saved === "left" || saved === "right") return saved;
  } catch {
    // Storage can be unavailable; fall back to the top strip.
  }
  return "top";
}

function applyToolDock(dock: ToolDock, persist = true): void {
  toolDock = dock;
  appEl.dataset.toolDock = dock;

  if (dock === "top") {
    progressLine.before(palette);
  } else if (dock === "left") {
    workspaceEl.insertBefore(palette, viewerShell);
  } else {
    workspaceEl.append(palette);
  }

  const label = TOOL_DOCK_LABELS[dock];
  paletteGrip.title = `拖动工具栏（当前：${label}）· 双击循环切换`;
  paletteGrip.setAttribute("aria-label", `拖动工具栏，当前停靠在${label}`);

  if (persist) {
    try {
      localStorage.setItem(TOOL_DOCK_KEY, dock);
    } catch {
      // Non-fatal: the dock still moves for this session.
    }
  }
}

function cycleToolDock(): void {
  const next = (TOOL_DOCK_ORDER.indexOf(toolDock) + 1) % TOOL_DOCK_ORDER.length;
  applyToolDock(TOOL_DOCK_ORDER[next]);
}

function dockFromPoint(x: number, y: number): ToolDock | null {
  const zones = dockOverlay.querySelectorAll<HTMLElement>(".dock-zone");
  for (const zone of zones) {
    const r = zone.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return zone.dataset.dock as ToolDock;
    }
  }
  return null;
}

function updateDockHighlight(target: ToolDock | null): void {
  dockTarget = target;
  dockOverlay.querySelectorAll<HTMLElement>(".dock-zone").forEach((zone) => {
    zone.classList.toggle("active", zone.dataset.dock === target);
  });
}

function finishToolDockDrag(commit: boolean): void {
  if (!dockDragging) return;
  const target = dockTarget;
  dockDragging = false;
  dockOverlay.classList.add("hidden");
  document.body.classList.remove("dock-dragging");
  palette.classList.remove("dragging");
  updateDockHighlight(null);
  // Re-docking to the same edge would reinsert the strip in the DOM and
  // cancel the click/double-click that is about to be delivered to the grip.
  if (commit && target && target !== toolDock) applyToolDock(target);
}

function wireToolDock(): void {
  paletteGrip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dockDragging = true;
    updateDockHighlight(null);
    dockOverlay.classList.remove("hidden");
    document.body.classList.add("dock-dragging");
    palette.classList.add("dragging");
    paletteGrip.setPointerCapture?.(e.pointerId);
    updateDockHighlight(dockFromPoint(e.clientX, e.clientY));
  });

  paletteGrip.addEventListener("pointermove", (e) => {
    if (!dockDragging) return;
    updateDockHighlight(dockFromPoint(e.clientX, e.clientY));
  });

  paletteGrip.addEventListener("pointerup", (e) => {
    if (!dockDragging) return;
    updateDockHighlight(dockFromPoint(e.clientX, e.clientY));
    finishToolDockDrag(true);
  });

  paletteGrip.addEventListener("pointercancel", () => finishToolDockDrag(false));
  paletteGrip.addEventListener("lostpointercapture", () => finishToolDockDrag(false));

  paletteGrip.addEventListener("dblclick", (e) => {
    e.preventDefault();
    cycleToolDock();
  });
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
      activeTab?.viewer.setToolColor(c.value);
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
  activeTab?.viewer.setTool(tool, toolColor);
  updatePalette();
}

function updatePalette(): void {
  palette.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === activeTool);
  });
  paletteColors.querySelectorAll<HTMLButtonElement>(".swatch").forEach((b) => {
    b.classList.toggle("active", b.dataset.color === toolColor);
  });
  paletteColors.style.display = isColorTool(activeTool) ? "flex" : "none";
}

// ---------------------------------------------------------------- selection actions

function clearPendingSelection(): void {
  pendingSelection = null;
}

function applySelection(type: "highlight" | "underline" | "strikeout", color: string): void {
  if (!pendingSelection) return;
  viewer.annotateSelection(pendingSelection, type, color);
  clearPendingSelection();
}

// ---------------------------------------------------------------- translation

async function refreshPlugins(): Promise<void> {
  plugins = await api.plugins().catch(() => []);
}

function defaultPlugin(kind: PluginKind): PluginInfo | null {
  return (
    plugins.find((p) => p.kind === kind && p.enabled && p.default) ??
    plugins.find((p) => p.kind === kind && p.enabled) ??
    null
  );
}

// Deliberately conservative: at least two Latin letters, English letters must
// make up 60% of letters+CJK, and there may not be more CJK than Latin.
// This keeps mixed strings such as "使用 API 的 response" translatable while
// rejecting Chinese prose.
function looksEnglish(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (letters < 2 || words < 1) return false;
  if (cjk > letters) return false;
  return letters / Math.max(1, letters + cjk) >= 0.6;
}

function isLookupText(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length <= 3 && text.length <= 48 && !/[.!?;:。！？；：]/.test(text);
}

let ctxMenu: HTMLElement | null = null;

// A double-click can select a partial word (span boundary) or swallow a
// neighbouring word (missing space in the text layer). For single-word
// lookups, ask PDF.js text items for the word under the pointer instead of
// trusting the browser's DOM selection.
function refineLookupSelection(sel: SelectionPayload, x: number, y: number): SelectionPayload {
  if (/\s/.test(sel.text.trim())) return sel;
  const pageEl = document.elementFromPoint(x, y)?.closest?.(".page") as HTMLElement | null;
  if (!pageEl) return sel;
  const page = Number(pageEl.dataset.page);
  if (!page) return sel;
  const rect = pageEl.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return sel;
  const nx = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  const word = viewer.wordAtPoint(page, nx, ny);
  if (word && /^[A-Za-z][A-Za-z'’\-]*$/.test(word)) {
    return { ...sel, text: word };
  }
  return sel;
}

function hideContextMenu(): void {
  ctxMenu?.remove();
  ctxMenu = null;
}

function showContextMenu(sel: SelectionPayload, x: number, y: number): void {
  hideContextMenu();
  clearPendingSelection();
  const english = looksEnglish(sel.text);
  const lookup = isLookupText(sel.text);
  const translator = defaultPlugin("translator");
  const dict = defaultPlugin("dictionary");

  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.addEventListener("mousedown", (e) => e.preventDefault());
  const addItem = (label: string, hint: string, disabled: boolean, act: () => void): void => {
    const btn = document.createElement("button");
    btn.className = "ctx-item";
    btn.type = "button";
    const text = document.createElement("span");
    text.textContent = label;
    btn.append(text);
    if (hint) {
      const small = document.createElement("span");
      small.className = "ctx-hint";
      small.textContent = hint;
      btn.append(small);
    }
    btn.disabled = disabled;
    if (disabled && !english) btn.title = "所选内容不是英文";
    btn.addEventListener("click", () => {
      hideContextMenu();
      act();
    });
    el.append(btn);
  };
  const addSep = (): void => {
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    el.append(sep);
  };

  if (lookup) {
    const lookupSel = refineLookupSelection(sel, x, y);
    if (dict) addItem("查词", dict.name, !english, () => void runLookup(lookupSel, dict));
    else addItem("查词（未启用词典插件）", "", !english, () => openSettings(true));
  }
  if (translator) addItem("翻译为中文", translator.name, !english, () => void runTranslate(sel, translator));
  else addItem("翻译为中文（未启用插件）", "", !english, () => openSettings(true));

  addSep();

  const colorRow = document.createElement("div");
  colorRow.className = "ctx-colors";
  const colorLabel = document.createElement("span");
  colorLabel.className = "ctx-label";
  colorLabel.textContent = "颜色";
  colorRow.append(colorLabel);
  const paintColors = (): void => {
    colorRow.querySelectorAll<HTMLButtonElement>(".swatch").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === selectionColor);
    });
  };
  for (const color of COLORS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "swatch";
    swatch.dataset.color = color.value;
    swatch.title = color.name;
    swatch.style.background = color.value;
    swatch.addEventListener("click", () => {
      selectionColor = color.value;
      paintColors();
    });
    colorRow.append(swatch);
  }
  paintColors();
  el.append(colorRow);

  const actions = document.createElement("div");
  actions.className = "ctx-actions";
  const annotate = (type: "highlight" | "underline" | "strikeout", label: string, iconName: string): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-action";
    btn.title = label;
    btn.innerHTML = `${icon(iconName)}<span>${label}</span>`;
    btn.addEventListener("click", () => {
      hideContextMenu();
      viewer.annotateSelection(sel, type, selectionColor);
    });
    actions.append(btn);
  };
  annotate("highlight", "高亮", "highlighter");
  annotate("underline", "下划线", "underline");
  annotate("strikeout", "删除线", "strike");
  el.append(actions);

  addSep();
  addItem("复制", "", false, () => {
    void navigator.clipboard
      .writeText(sel.text)
      .then(() => toast("已复制"))
      .catch(() => toast("复制失败", "error"));
  });

  popoverHost.append(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, y));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  ctxMenu = el;
}

let transCard: HTMLElement | null = null;
let transBody: HTMLElement | null = null;
let transKind: HTMLElement | null = null;
let transMeta: HTMLElement | null = null;
let transCopy: HTMLButtonElement | null = null;
let transRetry: HTMLButtonElement | null = null;
let transRequestID: string | null = null;
let transCopyText = "";
let transGeneration = 0;
let transAnchor: DOMRect | null = null;
let lastTransAction:
  | { type: "translate"; pluginId: string; sel: SelectionPayload }
  | { type: "lookup"; pluginId: string; sel: SelectionPayload }
  | null = null;

function buildTransCard(): void {
  const el = document.createElement("div");
  el.className = "trans-card hidden";
  el.innerHTML = `
    <div class="trans-head">
      <span class="trans-kind"></span>
      <span class="trans-meta"></span>
      <button class="icon-btn small trans-close" type="button" title="关闭">${icon("close")}</button>
    </div>
    <div class="trans-body"></div>
    <div class="trans-foot">
      <button class="pop-btn" type="button" data-act="copy">${icon("copy")}<span>复制</span></button>
      <button class="pop-btn" type="button" data-act="retry">${icon("refresh")}<span>重试</span></button>
    </div>`;
  el.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  el.querySelector(".trans-close")?.addEventListener("click", hideTransCard);
  el.querySelector('[data-act="copy"]')?.addEventListener("click", () => {
    if (!transCopyText) return;
    void navigator.clipboard
      .writeText(transCopyText)
      .then(() => toast("已复制"))
      .catch(() => toast("复制失败", "error"));
  });
  el.querySelector('[data-act="retry"]')?.addEventListener("click", retryTransAction);
  popoverHost.append(el);
  transCard = el;
  transBody = el.querySelector(".trans-body")!;
  transKind = el.querySelector(".trans-kind")!;
  transMeta = el.querySelector(".trans-meta")!;
  transCopy = el.querySelector('[data-act="copy"]') as HTMLButtonElement;
  transRetry = el.querySelector('[data-act="retry"]') as HTMLButtonElement;
}

function openTransCard(rect: DOMRect, kind: string, meta: string): void {
  if (!transCard) buildTransCard();
  if (!transCard || !transBody || !transKind || !transMeta) return;
  hideContextMenu();
  hideAnnotationPopover();
  transGeneration++;
  transAnchor = rect;
  transCopyText = "";
  transCopy?.classList.add("hidden");
  transRetry?.classList.add("hidden");
  transKind.textContent = kind;
  transMeta.textContent = meta;
  transBody.className = "trans-body";
  transBody.innerHTML = "";
  transCard.classList.remove("hidden");
  placeTransCard();
}

function placeTransCard(): void {
  if (!transCard || !transAnchor) return;
  const w = transCard.offsetWidth;
  const h = transCard.offsetHeight;
  const gap = 10;
  let left = transAnchor.left;
  let top = transAnchor.bottom + gap;
  if (top + h > window.innerHeight - 12) top = Math.max(56, transAnchor.top - h - gap);
  left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
  top = Math.max(56, Math.min(window.innerHeight - h - 12, top));
  transCard.style.left = `${left}px`;
  transCard.style.top = `${top}px`;
}

function hideTransCard(): void {
  if (transRequestID) {
    void api.cancelTranslate(transRequestID).catch(() => undefined);
    transRequestID = null;
  }
  transCard?.classList.add("hidden");
  transGeneration++;
  lastTransAction = null;
}

function setTransLoading(label: string): void {
  if (!transBody || !transCard) return;
  transBody.className = "trans-body";
  transBody.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "trans-loading";
  const spin = document.createElement("span");
  spin.className = "trans-spinner";
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(spin, text);
  transBody.append(wrap);
  transCopy?.classList.add("hidden");
  transRetry?.classList.add("hidden");
  placeTransCard();
}

function setTransError(message: string): void {
  if (!transBody) return;
  transBody.className = "trans-body";
  transBody.innerHTML = "";
  const box = document.createElement("div");
  box.className = "trans-error";
  box.textContent = message;
  transBody.append(box);
  transRetry?.classList.remove("hidden");
  transCopy?.classList.add("hidden");
  placeTransCard();
}

// PDF text layers put every visual line on its own line. Sending those raw
// newlines to a translation model can split a sentence around a place name or
// produce template-like output such as "向……发起突袭 葛底斯堡". Join soft
// line wraps, keep blank-line paragraph breaks, and repair hyphenated wraps.
function translationInput(text: string): string {
  return text
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/([^\n])\n(?!\n)/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function runTranslate(sel: SelectionPayload, plugin: PluginInfo): Promise<void> {
  lastTransAction = { type: "translate", pluginId: plugin.id, sel };
  openTransCard(sel.rect, "英 → 简中", plugin.model ? `${plugin.name} · ${plugin.model}` : plugin.name);
  const generation = transGeneration;
  setTransLoading("正在翻译…");
  if (transRequestID) await api.cancelTranslate(transRequestID).catch(() => undefined);
  const reqID = `tr-${uid()}`;
  transRequestID = reqID;
  try {
    const result = await api.translate(reqID, plugin.id, translationInput(sel.text));
    if (transRequestID !== reqID || generation !== transGeneration) return;
    transRequestID = null;
    if (!transBody || !transMeta) return;
    transBody.className = "trans-body";
    transBody.innerHTML = "";
    const sourceLabel = document.createElement("div");
    sourceLabel.className = "trans-label";
    sourceLabel.textContent = "原文";
    const source = document.createElement("div");
    source.className = "trans-source";
    source.textContent = sel.text;
    const divider = document.createElement("div");
    divider.className = "trans-divider";
    const targetLabel = document.createElement("div");
    targetLabel.className = "trans-label";
    targetLabel.textContent = "译文";
    const text = document.createElement("div");
    text.className = "trans-text";
    text.textContent = result.text;
    transBody.append(sourceLabel, source, divider, targetLabel, text);
    transCopyText = result.text;
    transMeta.textContent = `${plugin.name}${result.cached ? " · 缓存" : ""}`;
    transCopy?.classList.remove("hidden");
    transRetry?.classList.add("hidden");
    placeTransCard();
    void appendSentenceWords(sel.text, generation);
  } catch (e) {
    if (transRequestID !== reqID || generation !== transGeneration) return;
    transRequestID = null;
    setTransError(errorText(e));
  }
}

// After a sentence translation, look up every unique word in the enabled
// offline dictionary and show phonetics, POS and all senses.
async function appendSentenceWords(text: string, generation: number): Promise<void> {
  if (!transBody) return;
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) ?? []) {
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(match);
  }
  if (tokens.length < 2) return;

  const section = document.createElement("div");
  section.className = "trans-words";
  const head = document.createElement("div");
  head.className = "trans-words-head";
  const title = document.createElement("span");
  title.className = "trans-words-title";
  title.textContent = "单词";
  const meta = document.createElement("span");
  meta.className = "trans-words-meta";
  meta.textContent = `共 ${tokens.length} 个`;
  head.append(title, meta);
  const body = document.createElement("div");
  body.className = "trans-words-body";
  const loading = document.createElement("div");
  loading.className = "trans-loading";
  const spin = document.createElement("span");
  spin.className = "trans-spinner";
  const loadingText = document.createElement("span");
  loadingText.textContent = "正在查词…";
  loading.append(spin, loadingText);
  body.append(loading);
  section.append(head, body);
  transBody.append(section);
  placeTransCard();

  const dict = defaultPlugin("dictionary");
  if (!dict) {
    body.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "trans-sub";
    hint.textContent = "启用离线词典插件后，可在这里查看每个单词的音标、词性和释义。";
    body.append(hint);
    placeTransCard();
    return;
  }
  meta.textContent = `${dict.name} · 共 ${tokens.length} 个`;
  try {
    const results = await api.lookupWords(dict.id, text);
    if (generation !== transGeneration || !transBody?.contains(section)) return;
    body.innerHTML = "";
    const found = results.filter((r) => r.found && r.entries.length > 0);
    if (!found.length) {
      const empty = document.createElement("div");
      empty.className = "trans-sub";
      empty.textContent = "离线词典未收录这些单词。";
      body.append(empty);
    }
    for (const res of found) {
      const row = document.createElement("div");
      row.className = "word-row";
      const line = document.createElement("div");
      line.className = "word-head";
      const name = document.createElement("span");
      name.className = "word-name";
      name.textContent = res.word;
      line.append(name);
      if (res.phonetic) {
        const ph = document.createElement("span");
        ph.className = "word-phonetic";
        ph.textContent = res.phonetic;
        line.append(ph);
      }
      row.append(line);
      const entries = document.createElement("div");
      entries.className = "word-entries";
      for (const entry of res.entries) {
        const item = document.createElement("div");
        item.className = "word-entry";
        if (entry.pos) {
          const pos = document.createElement("span");
          pos.className = "dict-pos";
          pos.textContent = entry.pos;
          item.append(pos);
        }
        const def = document.createElement("span");
        def.className = "word-def";
        def.textContent = entry.translation;
        item.append(def);
        entries.append(item);
      }
      row.append(entries);
      if (res.lemma) {
        const lemma = document.createElement("div");
        lemma.className = "trans-sub";
        lemma.textContent = `原型：${res.lemma}`;
        row.append(lemma);
      }
      body.append(row);
    }
    const missing = results.filter((r) => !r.found).map((r) => r.word);
    if (missing.length) {
      const note = document.createElement("div");
      note.className = "word-missing";
      const shown = missing.slice(0, 12).join("、");
      note.textContent = `未收录：${shown}${missing.length > 12 ? "…" : ""}`;
      body.append(note);
    }
    meta.textContent = `${dict.name} · ${found.length}/${results.length} 词`;
    placeTransCard();
  } catch (e) {
    if (generation !== transGeneration || !transBody?.contains(section)) return;
    body.innerHTML = "";
    const error = document.createElement("div");
    error.className = "trans-sub";
    error.textContent = `查词失败：${errorText(e)}`;
    body.append(error);
    placeTransCard();
  }
}

async function runLookup(sel: SelectionPayload, plugin: PluginInfo): Promise<void> {
  lastTransAction = { type: "lookup", pluginId: plugin.id, sel };
  if (transRequestID) {
    void api.cancelTranslate(transRequestID).catch(() => undefined);
    transRequestID = null;
  }
  openTransCard(sel.rect, "离线词典", plugin.name);
  setTransLoading("正在查词…");
  try {
    const result = await api.lookupWord(plugin.id, sel.text);
    if (!transBody) return;
    transBody.className = "trans-body";
    transBody.innerHTML = "";
    if (!result.found) {
      const empty = document.createElement("div");
      empty.className = "trans-empty";
      empty.textContent = `词表中没有「${result.word}」`;
      const hint = document.createElement("div");
      hint.className = "trans-sub";
      hint.textContent = "离线词典只支持查词；整句请使用在线翻译插件。";
      transBody.append(empty, hint);
      transCopy?.classList.add("hidden");
      transRetry?.classList.add("hidden");
      placeTransCard();
      return;
    }

    const head = document.createElement("div");
    head.className = "dict-head";
    const word = document.createElement("span");
    word.className = "dict-word";
    word.textContent = result.word;
    head.append(word);
    if (result.phonetic) {
      const ph = document.createElement("span");
      ph.className = "dict-phonetic";
      ph.textContent = result.phonetic;
      head.append(ph);
    }
    transBody.append(head);
    if (result.lemma) {
      const lemma = document.createElement("div");
      lemma.className = "trans-sub";
      lemma.textContent = `原型：${result.lemma}`;
      transBody.append(lemma);
    }
    const list = document.createElement("div");
    list.className = "dict-entries";
    for (const entry of result.entries) {
      const row = document.createElement("div");
      row.className = "dict-entry";
      if (entry.pos) {
        const pos = document.createElement("span");
        pos.className = "dict-pos";
        pos.textContent = entry.pos;
        row.append(pos);
      }
      const def = document.createElement("span");
      def.className = "dict-def";
      def.textContent = entry.translation;
      row.append(def);
      list.append(row);
    }
    transBody.append(list);
    transCopyText = result.entries
      .map((e) => (e.pos ? `${e.pos} ${e.translation}` : e.translation))
      .join("\n");
    transCopy?.classList.remove("hidden");
    transRetry?.classList.add("hidden");
    placeTransCard();
  } catch (e) {
    setTransError(errorText(e));
  }
}

function retryTransAction(): void {
  if (!lastTransAction) return;
  const action = lastTransAction;
  if (action.type === "translate") {
    const plugin = plugins.find((p) => p.id === action.pluginId);
    if (plugin) void runTranslate(action.sel, plugin);
  } else {
    const plugin = plugins.find((p) => p.id === action.pluginId);
    if (plugin) void runLookup(action.sel, plugin);
  }
}

document.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented) return;
  const target = e.target as Node | null;
  if (!target || !activeTab || !activeTab.pages.contains(target)) return;
  // Pin the payload captured on mouseup. Re-reading the live DOM selection
  // here can return a different word after WebKit handles the right-click.
  const sel = pendingSelection ?? viewer.readSelection();
  if (!sel) return;
  e.preventDefault();
  showContextMenu(sel, e.clientX, e.clientY);
});

// ---------------------------------------------------------------- plugin settings

let pluginListEl: HTMLElement | null = null;
let pluginEditorEl: HTMLElement | null = null;
let pendingInstallToken: string | null = null;

function pluginKindLabel(kind: PluginKind): string {
  return kind === "translator" ? "在线翻译" : "离线词典";
}

function providerLabel(p: PluginInfo): string {
  if (p.kind === "dictionary") return "SQLite";
  switch (p.provider) {
    case "openai":
      return "OpenAI 兼容";
    case "deepl":
      return "DeepL";
    case "google":
      return "Google 翻译";
    case "baidu":
      return "百度翻译";
    case "baidu-llm":
      return "百度大模型翻译";
    case "youdao":
      return "有道翻译";
    default:
      return p.provider;
  }
}

function needsCredentials(p: PluginInfo): boolean {
  if (!p.requiresKey) return false;
  if (!p.hasKey) return true;
  return p.requiresAppId && !p.hasAppId;
}

async function refreshPluginSection(): Promise<void> {
  const list = pluginListEl;
  if (!list || !list.isConnected) return;
  await refreshPlugins();
  list.innerHTML = "";
  if (!plugins.length) {
    const empty = document.createElement("div");
    empty.className = "plugin-empty";
    empty.textContent = "尚未安装插件。离线词典和在线翻译都需要安装一个插件后才会启用。";
    list.append(empty);
    return;
  }
  for (const plugin of plugins) list.append(pluginRow(plugin));
}

function pluginRow(p: PluginInfo): HTMLElement {
  const row = document.createElement("div");
  row.className = "plugin-row";
  const main = document.createElement("div");
  main.className = "plugin-main";

  const title = document.createElement("div");
  title.className = "plugin-title";
  const name = document.createElement("span");
  name.className = "plugin-name";
  name.textContent = p.name;
  const kind = document.createElement("span");
  kind.className = "plugin-badge";
  kind.textContent = pluginKindLabel(p.kind);
  title.append(name, kind);
  if (p.default) {
    const badge = document.createElement("span");
    badge.className = "plugin-badge default";
    badge.textContent = "默认";
    title.append(badge);
  }
  const meta = document.createElement("div");
  meta.className = "plugin-meta";
  const bits = [`v${p.version}`, providerLabel(p)];
  if (p.model) bits.push(p.model);
  if (p.host) bits.push(p.host);
  if (p.license) bits.push(p.license);
  meta.textContent = bits.join(" · ");

  main.append(title, meta);
  if (p.description) {
    const desc = document.createElement("div");
    desc.className = "plugin-desc";
    desc.textContent = p.description;
    main.append(desc);
  }
  if (needsCredentials(p)) {
    const warn = document.createElement("div");
    warn.className = "plugin-warn";
    warn.textContent = p.requiresAppId ? "尚未配置 AppID / 密钥" : "尚未配置 API Key";
    main.append(warn);
  }

  const actions = document.createElement("div");
  actions.className = "plugin-actions";
  const toggle = document.createElement("label");
  toggle.className = "switch";
  toggle.title = p.enabled ? "停用插件" : "启用插件";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = p.enabled;
  const track = document.createElement("span");
  track.className = "switch-track";
  toggle.append(check, track);
  check.addEventListener("change", () => {
    if (check.checked && needsCredentials(p)) {
      check.checked = false;
      showKeyEditor(p, true);
      return;
    }
    void applyPluginUpdate(api.setPluginEnabled(p.id, check.checked));
  });
  actions.append(toggle);

  if (!p.default) {
    const def = document.createElement("button");
    def.type = "button";
    def.className = "mini-link";
    def.textContent = "设为默认";
    def.addEventListener("click", () => {
      if (needsCredentials(p)) {
        showKeyEditor(p, true);
        return;
      }
      void applyPluginUpdate(api.setPluginDefault(p.id));
    });
    actions.append(def);
  }
  if (p.kind === "translator" && p.requiresKey) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "mini-link";
    key.textContent = p.requiresAppId
      ? (p.hasKey && p.hasAppId ? "更换凭据" : "配置凭据")
      : p.hasKey
        ? "更换密钥"
        : "配置密钥";
    key.addEventListener("click", () => showKeyEditor(p, false));
    actions.append(key);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mini-link danger";
  remove.textContent = "卸载";
  remove.addEventListener("click", () => showUninstallConfirm(p));
  actions.append(remove);

  row.append(main, actions);
  return row;
}

async function applyPluginUpdate(promise: Promise<PluginInfo[]>): Promise<void> {
  try {
    plugins = await promise;
    await refreshPluginSection();
  } catch (e) {
    toast(`插件操作失败：${errorText(e)}`, "error");
    await refreshPluginSection();
  }
}

function clearPluginEditor(): void {
  if (!pluginEditorEl) return;
  pluginEditorEl.innerHTML = "";
  pluginEditorEl.classList.add("hidden");
}

function showKeyEditor(p: PluginInfo, enableAfter: boolean): void {
  if (!pluginEditorEl) return;
  const box = pluginEditorEl;
  box.innerHTML = "";
  box.classList.remove("hidden");
  const twoPart = p.requiresAppId;
  const baidu = p.provider === "baidu" || p.provider === "baidu-llm";
  const title = document.createElement("div");
  title.className = "plugin-editor-title";
  title.textContent = twoPart
    ? `${p.name} · ${baidu ? "AppID 与 API Key" : "AppID 与密钥"}`
    : `${p.name} · API Key`;
  const hint = document.createElement("div");
  hint.className = "plugin-editor-hint";
  hint.textContent = twoPart
    ? baidu
      ? "百度翻译需要 AppID 与 API Key。两者以明文保存在本机插件配置文件中（权限 0600），不会随插件卸载保留。"
      : "有道翻译需要 AppKey 与 AppSecret。两者以明文保存在本机插件配置文件中（权限 0600），不会随插件卸载保留。"
    : "密钥以明文保存在本机插件配置文件中（权限 0600），不会随插件卸载保留。";

  const appIDInput = document.createElement("input");
  appIDInput.type = "text";
  appIDInput.placeholder = p.hasAppId
    ? "输入新的 AppID（留空则保持不变）"
    : baidu
      ? "粘贴 AppID"
      : "粘贴 AppID / AppKey";
  appIDInput.autocomplete = "off";
  appIDInput.spellcheck = false;

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = p.hasKey
    ? "输入新的 API Key（留空则保持不变）"
    : twoPart
      ? baidu
        ? "粘贴 API Key"
        : "粘贴密钥 / AppSecret"
      : "粘贴 API Key";
  input.autocomplete = "off";

  const actions = document.createElement("div");
  actions.className = "plugin-editor-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "modal-btn primary";
  save.textContent = "保存";
  save.addEventListener("click", async () => {
    const appID = appIDInput.value.trim();
    const value = input.value.trim();
    if (twoPart && !appID) {
      appIDInput.focus();
      return;
    }
    if (!value) {
      input.focus();
      return;
    }
    save.disabled = true;
    try {
      if (twoPart) {
        plugins = await api.setPluginCredentials(p.id, appID, value);
      } else {
        plugins = await api.setPluginKey(p.id, value);
      }
      if (enableAfter) plugins = await api.setPluginEnabled(p.id, true);
      toast(twoPart ? "凭据已保存" : "密钥已保存");
      clearPluginEditor();
      await refreshPluginSection();
    } catch (e) {
      toast(`保存失败：${errorText(e)}`, "error");
    } finally {
      save.disabled = false;
    }
  });
  actions.append(save);
  if (p.hasKey) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "modal-btn ghost";
    clear.textContent = twoPart ? "清除凭据" : "清除密钥";
    clear.addEventListener("click", async () => {
      try {
        if (twoPart) {
          plugins = await api.setPluginCredentials(p.id, "", "");
        } else {
          plugins = await api.setPluginKey(p.id, "");
        }
        plugins = await api.setPluginEnabled(p.id, false);
        toast(twoPart ? "凭据已清除，插件已停用" : "密钥已清除，插件已停用");
        clearPluginEditor();
        await refreshPluginSection();
      } catch (e) {
        toast(`清除失败：${errorText(e)}`, "error");
      }
    });
    actions.append(clear);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "modal-btn ghost";
  cancel.textContent = "取消";
  cancel.addEventListener("click", clearPluginEditor);
  actions.append(cancel);
  box.append(title, hint);
  if (twoPart) {
    const idLabel = document.createElement("label");
    idLabel.className = "plugin-input-label";
    idLabel.textContent = baidu ? "AppID" : "AppID / AppKey";
    box.append(idLabel, appIDInput);
    const keyLabel = document.createElement("label");
    keyLabel.className = "plugin-input-label";
    keyLabel.textContent = baidu ? "API Key" : "密钥 / AppSecret";
    box.append(keyLabel);
  }
  box.append(input, actions);
  window.setTimeout(() => (twoPart ? appIDInput : input).focus(), 20);
}

function showUninstallConfirm(p: PluginInfo): void {
  if (!pluginEditorEl) return;
  const box = pluginEditorEl;
  box.innerHTML = "";
  box.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "plugin-editor-title";
  title.textContent = `卸载 ${p.name}？`;
  const hint = document.createElement("div");
  hint.className = "plugin-editor-hint";
  hint.textContent = "插件文件、配置和 API Key 都会删除，操作不可撤销。";
  const actions = document.createElement("div");
  actions.className = "plugin-editor-actions";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "modal-btn danger";
  confirm.textContent = "卸载";
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      plugins = await api.uninstallPlugin(p.id);
      toast("插件已卸载");
      clearPluginEditor();
      await refreshPluginSection();
    } catch (e) {
      toast(`卸载失败：${errorText(e)}`, "error");
      confirm.disabled = false;
    }
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "modal-btn ghost";
  cancel.textContent = "取消";
  cancel.addEventListener("click", clearPluginEditor);
  actions.append(confirm, cancel);
  box.append(title, hint, actions);
}

async function installPluginFlow(): Promise<void> {
  try {
    const candidate = await api.pickPlugin();
    if (candidate) handleCandidate(candidate);
  } catch (e) {
    toast(`插件校验失败：${errorText(e)}`, "error");
  }
}

function handleCandidate(candidate: InstallCandidate): void {
  if (pendingInstallToken && pendingInstallToken !== candidate.token) {
    void api.cancelPluginInstall(pendingInstallToken).catch(() => undefined);
  }
  pendingInstallToken = candidate.token;
  if (!pluginEditorEl) {
    void commitCandidate(candidate);
    return;
  }
  if (candidate.existing) {
    showInstallConfirm(candidate);
    return;
  }
  void commitCandidate(candidate);
}

function showInstallConfirm(candidate: InstallCandidate): void {
  if (!pluginEditorEl) return;
  const box = pluginEditorEl;
  box.innerHTML = "";
  box.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "plugin-editor-title";
  title.textContent = `已安装 ${candidate.name}`;
  const hint = document.createElement("div");
  hint.className = "plugin-editor-hint";
  hint.textContent = `当前 v${candidate.existingVersion}，新包 v${candidate.version}。更新会保留原有开关和 API Key。`;
  const actions = document.createElement("div");
  actions.className = "plugin-editor-actions";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "modal-btn primary";
  confirm.textContent = "更新插件";
  confirm.addEventListener("click", () => void commitCandidate(candidate));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "modal-btn ghost";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    void api.cancelPluginInstall(candidate.token).catch(() => undefined);
    pendingInstallToken = null;
    clearPluginEditor();
  });
  actions.append(confirm, cancel);
  box.append(title, hint, actions);
}

async function commitCandidate(candidate: InstallCandidate): Promise<void> {
  try {
    plugins = await api.installPlugin(candidate.token);
    pendingInstallToken = null;
    toast(`已安装 ${candidate.name} v${candidate.version}`);
    clearPluginEditor();
    await refreshPluginSection();
  } catch (e) {
    toast(`安装失败：${errorText(e)}`, "error");
    void api.cancelPluginInstall(candidate.token).catch(() => undefined);
    pendingInstallToken = null;
    clearPluginEditor();
  }
}

async function installDropped(path: string): Promise<void> {
  if (!pluginListEl?.isConnected) {
    toast("请先打开设置页的插件列表，再拖入插件文件", "error");
    return;
  }
  try {
    const candidate = await api.stagePlugin(path);
    if (candidate) handleCandidate(candidate);
  } catch (e) {
    toast(`插件校验失败：${errorText(e)}`, "error");
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
  // Keep the left-drag selection alive for the right-click menu; WebKit may
  // otherwise move the selection to the word under the pointer.
  if (e.button !== 2 && !(t instanceof Element && t.closest(".ctx-menu, .trans-card"))) {
    clearPendingSelection();
  }
  if (ctxMenu && !ctxMenu.contains(t)) hideContextMenu();
  if (transCard && !transCard.classList.contains("hidden") && !transCard.contains(t)) hideTransCard();
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
  if (!activeTab) {
    sidebarBody.innerHTML = "";
    return;
  }
  if (!activeTab.ready) {
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
  if (!activeTab) {
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
  activeTab?.viewer.clearSearch();
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
    activeTab?.viewer.clearSearch();
    return;
  }
  searchTimer = window.setTimeout(() => {
    void activeTab?.viewer.runSearch(q, searchCase);
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
    row.addEventListener("click", () => activeTab?.viewer.gotoSearchResult(i));
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

// ---------------------------------------------------------------- print

function openPrintPanel(): void {
  const doc = currentDoc;
  if (!doc) {
    toast("请先打开 PDF");
    return;
  }
  const total = viewer.getPages();
  if (!total) return;

  const body = document.createElement("div");
  body.className = "print-panel";
  body.innerHTML = `
    <div class="field">
      <label>打印范围</label>
      <div class="print-range-row">
        <select data-k="rangeMode">
          <option value="all">全部页面</option>
          <option value="current">当前页</option>
          <option value="custom">自定义</option>
        </select>
        <input type="text" data-k="rangeText" placeholder="如 1-3,5,8-10" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="field row">
      <label>包含标注</label>
      <input type="checkbox" data-k="annotations" />
    </div>
    <div class="field row">
      <label>仅打印有标注的页</label>
      <input type="checkbox" data-k="only" />
    </div>
    <p class="print-summary" data-k="print-summary"></p>
    <p class="print-summary muted" data-k="export-summary"></p>
    <p class="print-hint">导出始终包含全部页面；标注以矢量叠加，正文仍可选中、搜索。${
      doc.size > 100 * 1024 * 1024 ? " 当前文件较大，生成时需要整份载入内存。" : ""
    }</p>
  `;

  const modeSel = body.querySelector<HTMLSelectElement>('[data-k="rangeMode"]')!;
  const rangeInput = body.querySelector<HTMLInputElement>('[data-k="rangeText"]')!;
  const annotationsBox = body.querySelector<HTMLInputElement>('[data-k="annotations"]')!;
  const onlyBox = body.querySelector<HTMLInputElement>('[data-k="only"]')!;
  const printSummary = body.querySelector<HTMLElement>('[data-k="print-summary"]')!;
  const exportLine = body.querySelector<HTMLElement>('[data-k="export-summary"]')!;

  modeSel.value = settings.printRangeMode ?? "all";
  annotationsBox.checked = settings.printIncludeAnnotations ?? true;
  onlyBox.checked = settings.printOnlyAnnotated ?? false;

  const options = (): PrintOptions => ({
    rangeMode: modeSel.value as PrintOptions["rangeMode"],
    rangeText: rangeInput.value,
    includeAnnotations: annotationsBox.checked,
    onlyAnnotated: onlyBox.checked,
  });

  const makeContext = (opts: PrintOptions): PrintContext => ({
    doc,
    annotations: viewer.getAnnotations(),
    totalPages: total,
    currentPage: viewer.getCurrentPage(),
    options: opts,
    toast: toast as PrintToast,
  });

  let printButton: HTMLButtonElement | null = null;
  const refresh = () => {
    const opts = options();
    rangeInput.disabled = opts.rangeMode !== "custom";
    const built = buildPrintPlan(total, viewer.getCurrentPage(), viewer.getAnnotations(), opts);
    printSummary.textContent = built.error || planSummary(built.plan, opts.includeAnnotations);
    printSummary.classList.toggle("error", Boolean(built.error));
    exportLine.textContent = exportSummary(total, viewer.getAnnotations(), opts.includeAnnotations);
    if (printButton) printButton.disabled = Boolean(built.error);
  };

  const persist = (opts: PrintOptions) => {
    settings = {
      ...settings,
      printIncludeAnnotations: opts.includeAnnotations,
      printRangeMode: opts.rangeMode,
      printOnlyAnnotated: opts.onlyAnnotated,
      printConfigured: true,
    };
    void api.saveSettings(settings).catch((e) => toast(`保存打印选项失败：${errorText(e)}`, "error"));
  };

  showModal({
    title: "打印",
    body,
    focus: rangeInput,
    actions: [
      { label: "取消", kind: "ghost", onClick: () => undefined },
      {
        label: "导出 PDF…",
        kind: "ghost",
        onClick: () => {
          const opts = options();
          persist(opts);
          window.setTimeout(() => void runExport(makeContext(opts)), 0);
          return undefined;
        },
      },
      {
        label: "打印…",
        kind: "primary",
        onClick: () => {
          const opts = options();
          const built = buildPrintPlan(total, viewer.getCurrentPage(), viewer.getAnnotations(), opts);
          if (built.error) {
            toast(built.error, "error");
            return undefined;
          }
          persist(opts);
          window.setTimeout(() => void runPrint(makeContext(opts)), 0);
          return undefined;
        },
      },
    ],
  });

  const buttons = [...modalHost.querySelectorAll<HTMLButtonElement>(".modal-foot .modal-btn")];
  printButton = buttons[2] ?? null;
  const changed = () => refresh();
  modeSel.addEventListener("change", changed);
  rangeInput.addEventListener("input", changed);
  annotationsBox.addEventListener("change", changed);
  onlyBox.addEventListener("change", changed);
  refresh();
}

// ---------------------------------------------------------------- settings

function openSettings(focusPlugins = false): void {
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
      <label>阅读数据（SQLite）</label>
      <code>${sidecar?.path ? escapeHtml(sidecar.path) : "打开文档后显示"}</code>
      <div class="sidecar-actions">
        <button class="mini-link" data-act="export">导出 .pdfviewer.json</button>
        <button class="mini-link" data-act="import">从同名文件导入</button>
        <button class="mini-link" data-act="reveal">在文件管理器中显示</button>
        <button class="mini-link" data-act="copy-path">复制路径</button>
      </div>
    </div>
    <div class="field sidecar">
      <label>打印缓存</label>
      <p class="plugin-hint">打印/导出生成的临时 PDF 存放在配置目录的 cache/print 下，启动时自动清理 24 小时前的文件。</p>
      <div class="sidecar-actions">
        <button class="mini-link" data-act="clear-print">清理打印缓存</button>
      </div>
    </div>
    <div class="field plugins">
      <div class="plugin-head">
        <label>翻译与查词插件</label>
        <div class="plugin-head-actions">
          <button class="mini-link" type="button" data-act="plugin-dir">打开插件目录</button>
          <button class="mini-link" type="button" data-act="plugin-install">安装插件…</button>
        </div>
      </div>
      <p class="plugin-intro">默认不安装任何插件。启用后，在线翻译只会访问插件声明的域名；离线词典完全在本机查询。</p>
      <p class="plugin-hint">插件是 .pdfplugin 文件：可在仓库运行 make plugins 生成示例；离线词典优先用 make ecdict（ECDICT，约 9 万词条）。安装后需要打开右侧开关才会生效。</p>
      <div class="plugin-list" id="plugin-list"></div>
      <div class="plugin-editor hidden" id="plugin-editor"></div>
    </div>
    <div class="field meta-line">PDF Viewer ${"0.2.0"} · Go + Wails + pdf.js</div>
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
  body.querySelector('[data-act="clear-print"]')?.addEventListener("click", async () => {
    try {
      await api.clearPrintCache();
      toast("打印缓存已清理");
    } catch (e) {
      toast(`清理失败：${errorText(e)}`, "error");
    }
  });
  body.querySelector('[data-act="export"]')?.addEventListener("click", async () => {
    const doc = currentDoc;
    if (!doc) return;
    try {
      await flushSave();
      const path = await api.exportSidecar(doc.token);
      toast(`已导出到 ${path}`);
    } catch (e) {
      toast(`导出失败：${errorText(e)}`, "error");
    }
  });
  body.querySelector('[data-act="import"]')?.addEventListener("click", async () => {
    const doc = currentDoc;
    if (!doc) return;
    try {
      const path = await api.importSidecar(doc.token);
      closeSettings?.();
      toast(`已从 ${path} 导入`);
      await reloadCurrent();
    } catch (e) {
      toast(`导入失败：${errorText(e)}`, "error");
    }
  });

  pluginListEl = body.querySelector("#plugin-list");
  pluginEditorEl = body.querySelector("#plugin-editor");
  body.querySelector('[data-act="plugin-install"]')?.addEventListener("click", () => void installPluginFlow());
  body.querySelector('[data-act="plugin-dir"]')?.addEventListener("click", () => void api.openPluginsDir());

  let closeSettings: (() => void) | null = null;
  closeSettings = showModal({
    title: "设置",
    body,
    onClose: () => {
      if (pendingInstallToken) {
        void api.cancelPluginInstall(pendingInstallToken).catch(() => undefined);
        pendingInstallToken = null;
      }
      pluginListEl = null;
      pluginEditorEl = null;
    },
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
            printIncludeAnnotations: settings.printIncludeAnnotations,
            printRangeMode: settings.printRangeMode,
            printOnlyAnnotated: settings.printOnlyAnnotated,
            printConfigured: true,
          };
          settings = next;
          applyTheme();
          for (const tab of tabs) {
            tab.viewer.setSettings(next);
            tab.viewer.setToolColor(next.highlightColor);
          }
          updateNightButton();
          selectionColor = next.highlightColor;
          toolColor = next.highlightColor;
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
  void refreshPluginSection();
  if (focusPlugins) {
    window.setTimeout(() => body.querySelector(".plugins")?.scrollIntoView({ block: "center" }), 80);
  }
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
  onClose?: () => void;
}): () => void {
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

  let closed = false;
  const closeModal = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
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
  return closeModal;
}

// ---------------------------------------------------------------- toast

function toast(
  message: string,
  kind: "info" | "error" = "info",
  action?: { label: string; onClick: () => void },
): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.onClick();
      el.remove();
    });
    el.append(btn);
  }
  toastHost.append(el);
  window.setTimeout(() => el.classList.add("show"), 20);
  window.setTimeout(
    () => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 220);
    },
    kind === "error" ? 4200 : action ? 7000 : 2400,
  );
}

// ---------------------------------------------------------------- wiring

function wireUI(): void {
  // Wails drag regions swallow the native title bar double-click, so toggle
  // the window size ourselves. Skip controls that live inside the bar.
  $("#topbar").addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest("button, input, select, textarea, a, [role='button']")) return;
    e.preventDefault();
    void api.toggleMaximise().catch((err) => {
      void api.logError(`toggle maximise failed: ${errorText(err)}`);
    });
  });

  $("#btn-open").addEventListener("click", () => void openDialog());
  $("#btn-empty-open").addEventListener("click", () => void openDialog());
  $("#btn-tab-new").addEventListener("click", () => void openDialog());

  $("#btn-prev").addEventListener("click", () => activeTab?.viewer.prevPage());
  $("#btn-next").addEventListener("click", () => activeTab?.viewer.nextPage());
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      activeTab?.viewer.goToPage(Number(pageInput.value) || 1);
      pageInput.blur();
    }
  });
  pageInput.addEventListener("blur", () => {
    activeTab?.viewer.goToPage(Number(pageInput.value) || 1);
  });

  $("#btn-zoom-out").addEventListener("click", () => activeTab?.viewer.zoomBy(1 / 1.2));
  $("#btn-zoom-in").addEventListener("click", () => activeTab?.viewer.zoomBy(1.2));
  $("#btn-zoom").addEventListener("click", cycleZoomMode);
  $("#btn-fit").addEventListener("click", () => activeTab?.viewer.fitWidth());
  btnSpread.addEventListener("click", () => {
    if (!activeTab?.ready) return;
    const v = activeTab.viewer;
    v.setTwoPageView(!v.isTwoPageView());
    updateSpreadButton();
  });
  $("#btn-rotate").addEventListener("click", () => activeTab?.viewer.rotate(90));

  $("#btn-search").addEventListener("click", () => {
    if (searchPanel.classList.contains("hidden")) openSearch();
    else closeSearch();
  });
  $("#btn-night").addEventListener("click", () => {
    settings.nightMode = !settings.nightMode;
    for (const tab of tabs) tab.viewer.setNightMode(settings.nightMode);
    updateNightButton();
    void api.saveSettings(settings).catch(() => undefined);
  });
  btnRead.addEventListener("click", () => activeTab?.viewer.toggleReadCurrent());
  btnPrint.addEventListener("click", () => openPrintPanel());

  $("#btn-sidebar").addEventListener("click", () => {
    if (sidebar.classList.contains("collapsed")) openSidebar();
    else closeSidebar();
  });
  $("#sidebar-close").addEventListener("click", closeSidebar);
  $("#btn-settings").addEventListener("click", () => openSettings());

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => openSidebar(tab.dataset.tab as "thumbs" | "outline" | "notes"));
  });

  searchInput.addEventListener("input", runSearchDebounced);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) activeTab?.viewer.prevSearchResult();
      else activeTab?.viewer.nextSearchResult();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  });
  $("#search-prev").addEventListener("click", () => activeTab?.viewer.prevSearchResult());
  $("#search-next").addEventListener("click", () => activeTab?.viewer.nextSearchResult());
  $("#search-close").addEventListener("click", closeSearch);
  $("#search-case").addEventListener("click", () => {
    searchCase = !searchCase;
    $("#search-case").classList.toggle("active", searchCase);
    runSearchDebounced();
  });

  window.addEventListener("resize", () => {
    clearPendingSelection();
    hideAnnotationPopover();
  });

}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    if (quitting) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const typing =
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);

    if (key === "Escape") {
      if (ctxMenu) {
        hideContextMenu();
        return;
      }
      if (transCard && !transCard.classList.contains("hidden")) {
        hideTransCard();
        return;
      }
      if (!searchPanel.classList.contains("hidden")) {
        closeSearch();
        return;
      }
      clearPendingSelection();
      hideAnnotationPopover();
      if (activeTool !== "select") setTool("select");
      return;
    }

    if (mod && key.toLowerCase() === "o") {
      e.preventDefault();
      void openDialog();
      return;
    }
    if (mod && key.toLowerCase() === "w") {
      e.preventDefault();
      if (activeTab) void closeTab(activeTab);
      return;
    }
    if (mod && key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
      return;
    }
    if (mod && key.toLowerCase() === "p") {
      e.preventDefault();
      if (
        currentDoc &&
        !opening &&
        !modalHost.firstElementChild &&
        !document.querySelector(".print-progress")
      ) {
        openPrintPanel();
      }
      return;
    }
    if (mod && (key === "=" || key === "+")) {
      e.preventDefault();
      activeTab?.viewer.zoomBy(1.2);
      return;
    }
    if (mod && key === "-") {
      e.preventDefault();
      activeTab?.viewer.zoomBy(1 / 1.2);
      return;
    }
    if (mod && key === "0") {
      e.preventDefault();
      activeTab?.viewer.actualSize();
      return;
    }
    if (mod && key === "1") {
      e.preventDefault();
      activeTab?.viewer.fitWidth();
      return;
    }
    if (mod && key === "2") {
      e.preventDefault();
      activeTab?.viewer.fitPage();
      return;
    }
    if (mod && key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) activeTab?.viewer.redo();
      else activeTab?.viewer.undo();
      return;
    }
    if (mod && key.toLowerCase() === "y") {
      e.preventDefault();
      activeTab?.viewer.redo();
      return;
    }

    if (mod || e.altKey) return;
    if (typing) return;
    if (!currentDoc || !activeTab) return;
    const scroller = activeTab.scroller;

    switch (key) {
      case "PageDown":
      case " ":
        e.preventDefault();
        scroller.scrollBy({ top: scroller.clientHeight * 0.92, behavior: "smooth" });
        break;
      case "PageUp":
        e.preventDefault();
        scroller.scrollBy({ top: -scroller.clientHeight * 0.92, behavior: "smooth" });
        break;
      case "ArrowDown":
        e.preventDefault();
        scroller.scrollBy({ top: 88, behavior: "auto" });
        break;
      case "ArrowUp":
        e.preventDefault();
        scroller.scrollBy({ top: -88, behavior: "auto" });
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
    const list = paths ?? [];
    const plugin = list.find((p) => p.toLowerCase().endsWith(".pdfplugin"));
    if (plugin) {
      void installDropped(plugin);
      return;
    }
    const pdfs = list.filter((p) => p.toLowerCase().endsWith(".pdf"));
    if (pdfs.length) void openMany(pdfs);
    else if (list.length) toast("只能打开 PDF 文件或安装 .pdfplugin 插件", "error");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

async function openMany(paths: string[]): Promise<void> {
  await Promise.all(paths.map(openPath));
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
