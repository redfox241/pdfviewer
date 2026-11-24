import * as pdfjsLib from "pdfjs-dist";
import {
  clamp,
  normRot,
  pointInQuad,
  rotatePoint,
  rotateQuad,
  uid,
  unrotateQuad,
  type Annotation,
  type DocInfo,
  type Quad,
  type ReadingState,
  type Settings,
  type Tool,
  type ZoomMode,
} from "./model";
import { History } from "./history";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const NS = "http://www.w3.org/2000/svg";
const SIDE_PAD = 32;
const SPREAD_GAP = 18;
const MIN_SCALE = 1 / 3; // 25% of 96 dpi
const MAX_SCALE = 20 / 3; // 500% of 96 dpi

type PdfDoc = any;
type PdfPage = any;

interface PageMeta {
  baseW: number;
  baseH: number;
  intrinsicRot: number;
}

interface PageView {
  num: number;
  meta: PageMeta;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textEl: HTMLDivElement;
  svg: SVGSVGElement;
  badge: HTMLElement;
  renderedScale: number;
  textScale: number;
  textRot: number;
  renderTask: any;
  textLayer: any;
  page: PdfPage | null;
}

export interface SelectionGroup {
  page: number;
  quads: Quad[];
  text: string;
}

export interface SelectionPayload {
  text: string;
  page: number;
  quads: Quad[];
  groups: SelectionGroup[];
  rect: DOMRect;
}

export interface SearchResult {
  page: number;
  snippet: string;
}

export interface ViewerEvents {
  onReady(pages: number): void;
  onPageChange(page: number): void;
  onZoomChange(scale: number, mode: ZoomMode): void;
  onSelection(sel: SelectionPayload | null): void;
  onAnnotationSelect(ann: Annotation | null, anchor: DOMRect | null): void;
  onAnnotationsChange(): void;
  onReadChange(): void;
  onSearchResults(results: SearchResult[], index: number): void;
  onNoteRequest(page: number, point: { x: number; y: number }, ann: Annotation | null): void;
  onToast(message: string, kind?: "info" | "error"): void;
  onDiagnostic?(message: string): void;
}

interface TextCacheEntry {
  items: any[];
  text: string;
}

export class Viewer {
  readonly scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private events: ViewerEvents;
  private settings: Settings;

  private pdf: PdfDoc | null = null;
  private docInfo: DocInfo | null = null;
  private numPages = 0;
  private metas: PageMeta[] = [];
  private pageViews = new Map<number, PageView>();

  private scale = 1;
  private zoomMode: ZoomMode = "fit-width";
  private twoPageView = false;
  private rotationDelta = 0;
  private currentPage = 1;
  private annotations: Annotation[] = [];
  private readPages = new Set<number>();
  private selectedAnn: string | null = null;

  private tool: Tool = "select";
  private toolColor = "#ffd84d";

  private history = new History(120);
  private visible = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private thumbObserver: IntersectionObserver | null = null;
  private queue: number[] = [];
  private pumping = false;
  private loadGen = 0;

  private textCache = new Map<number, TextCacheEntry>();
  private searchQuery = "";
  private searchCase = false;
  private searchHits: SearchResult[] = [];
  private searchIndex = -1;
  private searchRanges = new Map<number, Range[]>();
  private searchGen = 0;

  private drag: {
    kind: "ink" | "redact" | "box" | "erase";
    page: PageView;
    points: { x: number; y: number }[];
    el: SVGElement | null;
    eraseIds: Set<string>;
  } | null = null;

  private readTimer = 0;
  private readTimerPage = 0;
  private scrollRaf = 0;
  private navigationTop: number | null = null;
  private scaleTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private pointerDownAt: { x: number; y: number } | null = null;
  private lastVisibleScrollRatio = 0;

  constructor(scroller: HTMLElement, pagesEl: HTMLElement, settings: Settings, events: ViewerEvents) {
    this.scroller = scroller;
    this.pagesEl = pagesEl;
    this.settings = settings;
    this.events = events;
    this.pagesEl.style.setProperty("--spread-gap", `${SPREAD_GAP}px`);

    this.pagesEl.addEventListener("pointerdown", this.onPointerDown);
    this.pagesEl.addEventListener("pointermove", this.onPointerMove);
    this.pagesEl.addEventListener("pointerup", this.onPointerUp);
    this.pagesEl.addEventListener("pointercancel", this.onPointerUp);
    this.pagesEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.pagesEl.addEventListener("mouseup", this.onMouseUp);
    this.pagesEl.addEventListener("dblclick", this.onDoubleClick);
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.scroller);
  }

  // ---------------------------------------------------------------- opening

  async open(
    info: DocInfo,
    reading: ReadingState | null,
    annotations: Annotation[],
  ): Promise<void> {
    const gen = ++this.loadGen;
    this.reset();

    let pdf: PdfDoc;
    try {
      pdf = await pdfjsLib.getDocument({
        url: info.url,
        rangeChunkSize: 65536,
        cMapUrl: "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "standard_fonts/",
      } as any).promise;
    } catch (err) {
      // Fallback for environments where the asset route is unavailable.
      const b64 = await (window as any).go?.main?.App?.ReadDocumentBase64?.(info.token);
      if (!b64) throw err;
      const bin = atob(b64 as string);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "standard_fonts/",
      } as any).promise;
    }

    if (gen !== this.loadGen) {
      void pdf.destroy();
      return;
    }

    this.pdf = pdf;
    this.docInfo = info;
    this.numPages = pdf.numPages;
    if (this.numPages < 1) throw new Error("文档没有页面");

    const first = await pdf.getPage(1);
    const firstVp = first.getViewport({ scale: 1 });
    const base: PageMeta = {
      baseW: firstVp.width,
      baseH: firstVp.height,
      intrinsicRot: first.rotate,
    };

    this.annotations = annotations.map((a) => ({ ...a }));
    this.readPages = new Set(reading?.readPages ?? []);
    this.rotationDelta = 0;
    this.currentPage = clamp(reading?.lastPage ?? 1, 1, this.numPages);

    if (this.numPages <= 350) {
      this.metas = await this.fetchSizes(pdf, this.numPages, base);
    } else {
      this.metas = Array.from({ length: this.numPages }, () => ({ ...base }));
    }
    if (gen !== this.loadGen) return;

    this.buildPages();
    this.observer = new IntersectionObserver(this.onIntersect, {
      root: this.scroller,
      rootMargin: "180% 0px",
    });
    for (const pv of this.pageViews.values()) this.observer.observe(pv.el);

    const desired =
      reading?.zoom && reading.zoom > 0.1
        ? clamp(reading.zoom, MIN_SCALE, MAX_SCALE)
        : this.initialScaleFromSettings();

    this.applyScaleInternal(desired, reading?.zoom ? "custom" : this.initialMode());
    this.renderVisibleNow();

    this.lastVisibleScrollRatio = reading?.scrollRatio ?? 0;
    requestAnimationFrame(() => {
      if (gen !== this.loadGen) return;
      this.scrollToPage(this.currentPage, reading?.scrollRatio ?? 0, true);
      this.events.onReady(this.numPages);
      this.events.onPageChange(this.currentPage);
      this.events.onReadChange();
      this.events.onZoomChange(this.scale, this.zoomMode);
    });
  }

  private async fetchSizes(pdf: PdfDoc, n: number, fallback: PageMeta): Promise<PageMeta[]> {
    const metas: PageMeta[] = new Array(n);
    let next = 1;
    const worker = async () => {
      while (next <= n) {
        const i = next++;
        try {
          const p = await pdf.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          metas[i - 1] = { baseW: vp.width, baseH: vp.height, intrinsicRot: p.rotate };
        } catch {
          metas[i - 1] = { ...fallback };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, n) }, worker));
    for (let i = 0; i < n; i++) if (!metas[i]) metas[i] = { ...fallback };
    return metas;
  }

  private buildPages(): void {
    this.pagesEl.innerHTML = "";
    this.pageViews.clear();

    for (let n = 1; n <= this.numPages; n++) {
      const meta = this.metas[n - 1]!;
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(n);

      const canvas = document.createElement("canvas");
      canvas.className = "page-canvas";

      const textEl = document.createElement("div");
      textEl.className = "textLayer";

      const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
      svg.classList.add("annot-layer");
      svg.setAttribute("preserveAspectRatio", "none");

      const badge = document.createElement("div");
      badge.className = "page-marker";
      badge.title = "已读";
      badge.textContent = "✓";

      el.append(canvas, textEl, svg, badge);

      const pv: PageView = {
        num: n,
        meta,
        el,
        canvas,
        textEl,
        svg,
        badge,
        renderedScale: 0,
        textScale: 0,
        textRot: -1,
        renderTask: null,
        textLayer: null,
        page: null,
      };
      this.pageViews.set(n, pv);
      this.applyPageBox(pv);
      this.updateBadge(pv);
    }
    this.arrangePageRows();
  }

  private get pagesPerRow(): number {
    return this.twoPageView ? 2 : 1;
  }

  private arrangePageRows(): void {
    const rows = document.createDocumentFragment();
    let row: HTMLElement | null = null;
    for (const pv of this.pageViews.values()) {
      if (!row || (pv.num - 1) % this.pagesPerRow === 0) {
        row = document.createElement("div");
        row.className = "page-row";
        rows.append(row);
      }
      row.append(pv.el);
    }
    this.pagesEl.replaceChildren(rows);
  }

  private *rowSizes(): Generator<{ w: number; h: number; gap: number }> {
    const swap = normRot(this.rotationDelta) % 180 !== 0;
    const step = this.pagesPerRow;
    for (let i = 0; i < this.metas.length; i += step) {
      let w = 0;
      let h = 0;
      const count = Math.min(step, this.metas.length - i);
      for (let j = 0; j < count; j++) {
        const m = this.metas[i + j]!;
        w += swap ? m.baseH : m.baseW;
        h = Math.max(h, swap ? m.baseW : m.baseH);
      }
      yield { w, h, gap: count > 1 ? SPREAD_GAP : 0 };
    }
  }

  private applyPagesWidth(): void {
    // CSS keeps the content at least as wide as the scrollport; this width
    // leaves enough room to pan when a row exceeds it.
    let maxW = 0;
    for (const row of this.rowSizes()) {
      maxW = Math.max(maxW, row.w * this.scale + row.gap);
    }
    this.pagesEl.style.width = `${Math.ceil(maxW + SIDE_PAD * 2)}px`;
  }

  private initialMode(): ZoomMode {
    switch (this.settings.defaultZoom) {
      case "actual":
        return "actual";
      case "fit-page":
        return "fit-page";
      default:
        return "fit-width";
    }
  }

  private initialScaleFromSettings(): number {
    const mode = this.initialMode();
    if (mode === "fit-page") return this.computeFit("fit-page");
    if (mode === "actual") return 4 / 3;
    return this.computeFit("fit-width");
  }

  private computeFit(mode: "fit-width" | "fit-page"): number {
    if (!this.metas.length) return 1;
    const availW = Math.max(200, this.scroller.clientWidth - SIDE_PAD * 2);
    const availH = Math.max(200, this.scroller.clientHeight - 40);
    // Keep one zoom level for all rows, including mixed page sizes.
    let s = MAX_SCALE;
    for (const row of this.rowSizes()) {
      s = Math.min(s, (availW - row.gap) / row.w);
      if (mode === "fit-page") s = Math.min(s, availH / row.h);
    }
    return clamp(s, MIN_SCALE, MAX_SCALE);
  }

  // ------------------------------------------------------------------ close

  close(): void {
    this.loadGen++;
    this.reset();
    this.events.onSelection(null);
    this.events.onAnnotationSelect(null, null);
  }

  private reset(): void {
    window.clearTimeout(this.readTimer);
    window.clearTimeout(this.scaleTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    for (const pv of this.pageViews.values()) {
      pv.renderTask?.cancel?.();
      pv.textLayer?.cancel?.();
    }
    this.pageViews.clear();
    this.pagesEl.innerHTML = "";
    this.pdf?.destroy?.();
    this.pdf = null;
    this.docInfo = null;
    this.numPages = 0;
    this.metas = [];
    this.annotations = [];
    this.readPages = new Set();
    this.selectedAnn = null;
    this.history.clear();
    this.visible.clear();
    this.queue = [];
    this.textCache.clear();
    this.searchQuery = "";
    this.searchHits = [];
    this.searchIndex = -1;
    this.searchRanges.clear();
    this.rotationDelta = 0;
    this.currentPage = 1;
    this.navigationTop = null;
    this.lastVisibleScrollRatio = 0;
    this.drag = null;
    this.pagesEl.style.width = "";
    this.scroller.scrollTop = 0;
    this.applySearchHighlightAll();
  }

  // ------------------------------------------------------------------ pages

  private displaySize(meta: PageMeta): { w: number; h: number } {
    // baseW/baseH come from getViewport({ scale: 1 }), which already includes
    // the page's intrinsic /Rotate. Only an extra user rotation swaps them.
    const swap = normRot(this.rotationDelta) % 180 !== 0;
    return swap
      ? { w: meta.baseH * this.scale, h: meta.baseW * this.scale }
      : { w: meta.baseW * this.scale, h: meta.baseH * this.scale };
  }

  private applyPageBox(pv: PageView): void {
    const { w, h } = this.displaySize(pv.meta);
    pv.el.style.width = `${w}px`;
    pv.el.style.height = `${h}px`;
    pv.el.style.setProperty("--scale-factor", String(this.scale));
    pv.el.style.setProperty("--total-scale-factor", String(this.scale));
    pv.svg.setAttribute("viewBox", `0 0 ${Math.max(1, w)} ${Math.max(1, h)}`);
  }

  private applyLayout(): void {
    for (const pv of this.pageViews.values()) this.applyPageBox(pv);
    this.applyPagesWidth();
    for (const n of this.visible) this.renderAnnotations(n);
  }

  private renderScale(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pv = this.pageViews.get(this.currentPage);
    const base = pv?.meta.baseW ?? 800;
    const maxBySize = 8192 / Math.max(1, base * dpr);
    return Math.min(this.scale, 3, Math.max(0.5, maxBySize));
  }

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const n = Number((entry.target as HTMLElement).dataset.page);
      if (!n) continue;
      if (entry.isIntersecting) {
        this.visible.add(n);
        const pv = this.pageViews.get(n);
        if (pv) this.prefetchText(pv);
        if (n === this.currentPage) this.armReadTimer();
      } else {
        this.visible.delete(n);
      }
    }
    this.scheduleRender();
  };

  private scheduleRender(): void {
    const list = [...this.visible]
      .map((n) => ({ n, d: Math.abs(n - this.currentPage) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.n);
    this.queue = list;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const n = this.queue.shift()!;
        if (!this.visible.has(n)) continue;
        await this.renderPage(n);
      }
    } finally {
      this.pumping = false;
      if (this.queue.length) void this.pump();
    }
  }

  private renderVisibleNow(): void {
    this.scheduleRender();
  }

  private async renderPage(n: number): Promise<void> {
    const pv = this.pageViews.get(n);
    if (!pv || !this.pdf) return;
    if (Math.abs(pv.renderedScale - Math.min(this.scale, 3)) < 0.001 && pv.page) {
      this.renderAnnotations(n);
      return;
    }

    pv.renderTask?.cancel?.();
    const page: PdfPage = await this.pdf.getPage(n);
    if (this.pageViews.get(n) !== pv) return;

    // Correct our size heuristic for very large documents.
    const vp1 = page.getViewport({ scale: 1 });
    if (Math.abs(vp1.width - pv.meta.baseW) > 0.5 || Math.abs(vp1.height - pv.meta.baseH) > 0.5) {
      const anchor = this.anchor();
      this.metas[n - 1] = pv.meta = { baseW: vp1.width, baseH: vp1.height, intrinsicRot: page.rotate };
      pv.renderedScale = 0;
      this.updateFitLayout();
      this.scrollToPage(anchor.page, anchor.ratio);
    }

    const target = Math.min(this.scale, 3);
    const totalRot = normRot(pv.meta.intrinsicRot + this.rotationDelta);
    const renderScale = this.renderScale();
    const vp = page.getViewport({ scale: renderScale, rotation: totalRot });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = pv.canvas;
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      this.diag(`canvas 2d context unavailable for page ${n}`);
      return;
    }

    try {
      pv.renderTask = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await pv.renderTask.promise;
      pv.renderedScale = target;
      pv.page = page;
    } catch (err: any) {
      if (err?.name !== "RenderingCancelledException") {
        console.warn("render failed", n, err);
        this.diag(`render page ${n} failed: ${String(err?.name)} ${String(err?.message ?? err)}`);
      }
      return;
    }

    await this.renderTextLayer(pv, page);
    this.renderAnnotations(n);
  }

  private async renderTextLayer(pv: PageView, page: PdfPage): Promise<void> {
    const totalRot = normRot(pv.meta.intrinsicRot + this.rotationDelta);
    const viewport = page.getViewport({ scale: this.scale, rotation: totalRot });
    if (
      Math.abs(pv.textScale - this.scale) < 0.001 &&
      pv.textRot === totalRot &&
      pv.textEl.childElementCount > 0
    ) {
      return;
    }

    pv.textLayer?.cancel?.();
    pv.textEl.innerHTML = "";
    let content: any;
    try {
      content = await page.getTextContent();
    } catch {
      return;
    }
    this.cacheText(pv.num, content.items);

    const layer = new pdfjsLib.TextLayer({
      textContentSource: content,
      container: pv.textEl,
      viewport,
    } as any);
    pv.textLayer = layer;
    pv.textScale = this.scale;
    pv.textRot = totalRot;
    try {
      await layer.render();
    } catch {
      // cancelled
    }
    this.applySearchHighlight(pv.num);
  }

  private async prefetchText(pv: PageView): Promise<void> {
    if (this.textCache.has(pv.num) || !this.pdf) return;
    try {
      const page = await this.pdf.getPage(pv.num);
      const content = await page.getTextContent();
      this.cacheText(pv.num, content.items);
    } catch {
      // ignore
    }
  }

  private cacheText(n: number, items: any[]): void {
    if (this.textCache.has(n)) return;
    const text = joinItems(items);
    this.textCache.set(n, { items, text });
  }

  private async pageText(n: number): Promise<string> {
    const cached = this.textCache.get(n);
    if (cached) return cached.text;
    if (!this.pdf) return "";
    try {
      const page = await this.pdf.getPage(n);
      const content = await page.getTextContent();
      this.cacheText(n, content.items);
      return this.textCache.get(n)?.text ?? "";
    } catch {
      return "";
    }
  }

  // Resolve the word under a point using PDF.js text items rather than the
  // browser's live DOM selection. PDF text layers split or merge words in
  // ways that make double-click selection return a fragment or a neighbour.
  wordAtPoint(pageNum: number, nx: number, ny: number): string | null {
    const pv = this.pageViews.get(pageNum);
    const cache = this.textCache.get(pageNum);
    if (!pv || !pv.page || !cache) return null;
    const totalRot = normRot(pv.meta.intrinsicRot + this.rotationDelta);
    const viewport = pv.page.getViewport({ scale: 1, rotation: totalRot });
    const x = nx * viewport.width;
    const y = ny * viewport.height;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const item of cache.items) {
      const str = typeof item.str === "string" ? item.str : "";
      if (!str.trim()) continue;
      const tr = pdfjsLib.Util.transform(viewport.transform, item.transform);
      // Rotated/skewed items are hard to hit-test; fall back to DOM selection.
      if (Math.abs(tr[1]) > 0.01 || Math.abs(tr[2]) > 0.01) continue;
      const left = tr[4];
      const baseline = tr[5];
      const width = Math.max(1, item.width || 0);
      const height = Math.max(1, item.height || 0);
      const top = baseline - height;
      const bottom = baseline + height * 0.25;
      if (x < left - 2 || x > left + width + 2 || y < top - 2 || y > bottom + 2) continue;
      const dist = Math.abs(x - (left + width / 2)) + Math.abs(y - (top + bottom) / 2);
      if (dist >= bestDist) continue;
      const rel = clamp((x - left) / width, 0, 0.9999);
      let idx = Math.floor(rel * str.length);
      const isSpace = (c: string | undefined): boolean => !c || /\s/.test(c);
      if (isSpace(str[idx])) {
        let l = idx;
        while (l > 0 && isSpace(str[l - 1])) l--;
        let r = idx;
        while (r < str.length && isSpace(str[r])) r++;
        idx = l > 0 ? l - 1 : r;
      }
      let a = idx;
      let b = idx + 1;
      while (a > 0 && !isSpace(str[a - 1])) a--;
      while (b < str.length && !isSpace(str[b])) b++;
      const word = str
        .slice(a, b)
        .replace(/^[^A-Za-z0-9'’\-]+|[^A-Za-z0-9'’\-]+$/g, "");
      if (!word) continue;
      best = word;
      bestDist = dist;
    }
    return best;
  }

  // ---------------------------------------------------------------- scaling

  setScale(scale: number, mode: ZoomMode = "custom"): void {
    const anchor = this.anchor();
    this.applyScaleInternal(clamp(scale, MIN_SCALE, MAX_SCALE), mode);
    this.restoreAnchor(anchor);
  }

  private applyScaleInternal(scale: number, mode: ZoomMode): void {
    this.scale = scale;
    this.zoomMode = mode;
    this.applyLayout();
    this.events.onZoomChange(this.scale, this.zoomMode);
    window.clearTimeout(this.scaleTimer);
    this.scaleTimer = window.setTimeout(() => {
      for (const pv of this.pageViews.values()) {
        if (this.visible.has(pv.num)) {
          pv.renderedScale = 0;
          this.renderAnnotations(pv.num);
        }
      }
      this.scheduleRender();
    }, 220);
  }

  zoomBy(factor: number): void {
    this.setScale(this.scale * factor, "custom");
  }

  fitWidth(): void {
    this.setScale(this.computeFit("fit-width"), "fit-width");
  }

  fitPage(): void {
    this.setScale(this.computeFit("fit-page"), "fit-page");
  }

  actualSize(): void {
    // pdf.js maps 1 PDF point to 1 CSS px at scale 1 (72 dpi); browsers use
    // 96 dpi for "actual size", hence the 4/3 factor.
    this.setScale(4 / 3, "actual");
  }

  getScale(): number {
    return this.scale;
  }

  getZoomMode(): ZoomMode {
    return this.zoomMode;
  }

  isTwoPageView(): boolean {
    return this.twoPageView;
  }

  setTwoPageView(enabled: boolean): void {
    if (enabled === this.twoPageView) return;
    const anchor = this.anchor();
    this.twoPageView = enabled;
    this.arrangePageRows();
    this.updateFitLayout();
    this.scrollToPage(anchor.page, anchor.ratio, true);
    this.scheduleRender();
  }

  private updateFitLayout(): void {
    if (
      (this.zoomMode === "fit-width" || this.zoomMode === "fit-page") &&
      this.scroller.clientWidth >= 2 && this.scroller.clientHeight >= 2
    ) {
      const scale = this.computeFit(this.zoomMode);
      if (Math.abs(scale - this.scale) > 0.0001) {
        this.applyScaleInternal(scale, this.zoomMode);
        return;
      }
    }
    this.applyLayout();
  }

  rotate(delta: number): void {
    const anchor = this.anchor();
    this.rotationDelta = normRot(this.rotationDelta + delta);
    for (const pv of this.pageViews.values()) {
      pv.renderedScale = 0;
      pv.textRot = -1;
    }
    this.updateFitLayout();
    this.restoreAnchor(anchor);
    this.scheduleRender();
  }

  private anchor(): { page: number; ratio: number } {
    return { page: this.currentPage, ratio: this.scrollRatio() };
  }

  private restoreAnchor(a: { page: number; ratio: number }): void {
    requestAnimationFrame(() => this.scrollToPage(a.page, a.ratio));
  }

  private onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0025);
    this.setScale(this.scale * factor, "custom");
  };

  private onResize(): void {
    // Inactive tabs are display:none; a zero-sized scrollport must not
    // overwrite the fit scale. Re-showing the tab fires this again with a
    // real size.
    if (!this.numPages) return;
    if (this.scroller.clientWidth < 2 || this.scroller.clientHeight < 2) return;
    if (this.zoomMode === "fit-width" || this.zoomMode === "fit-page") {
      const anchor = this.anchor();
      window.clearTimeout(this.scaleTimer);
      this.scaleTimer = window.setTimeout(() => {
        this.applyScaleInternal(this.computeFit(this.zoomMode as "fit-width" | "fit-page"), this.zoomMode);
        this.restoreAnchor(anchor);
      }, 120);
    } else {
      this.applyPagesWidth();
    }
  }

  // -------------------------------------------------------------- navigation

  goToPage(n: number): void {
    const page = clamp(Math.round(n), 1, this.numPages);
    this.scrollToPage(page, 0, true);
    this.setCurrentPage(page);
  }

  nextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  prevPage(): void {
    this.goToPage(this.currentPage - 1);
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getPages(): number {
    return this.numPages;
  }

  private scrollToPage(n: number, ratio: number, revealHorizontally = false): void {
    const pv = this.pageViews.get(n);
    if (!pv) return;
    const rect = pv.el.getBoundingClientRect();
    const host = this.scroller.getBoundingClientRect();
    const top = rect.top - host.top + this.scroller.scrollTop + rect.height * clamp(ratio, 0, 0.9) - 12;
    let left = this.scroller.scrollLeft;
    if (revealHorizontally) {
      const right = host.left + this.scroller.clientWidth;
      if (
        rect.left < host.left || rect.left >= right ||
        (rect.width > this.scroller.clientWidth && rect.right > right)
      ) {
        left += rect.left - host.left;
      } else if (rect.right > right) {
        left += rect.right - right;
      }
    }
    this.scroller.scrollTo({ top: Math.max(0, top), left, behavior: "auto" });
    // A requested page may share a row or be too close to the end to reach
    // the scrollport centre. Keep it selected until the reader scrolls.
    this.navigationTop = this.scroller.scrollTop;
  }

  scrollRatio(): number {
    const pv = this.pageViews.get(this.currentPage);
    if (!pv) return 0;
    const rect = pv.el.getBoundingClientRect();
    const host = this.scroller.getBoundingClientRect();
    if (rect.height > 0 && host.height > 0) {
      this.lastVisibleScrollRatio = clamp((host.top - rect.top) / rect.height, 0, 1);
    }
    return this.lastVisibleScrollRatio;
  }

  private onScroll = (): void => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (this.scroller.scrollTop !== this.navigationTop) {
        this.navigationTop = null;
        const page = this.pageAtCenter();
        if (page && page !== this.currentPage) this.setCurrentPage(page);
      }
      this.scheduleRender();
    });
  };

  private pageAtCenter(): number {
    if (!this.numPages) return 1;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    const step = this.pagesPerRow;
    let best = this.currentPage;
    let bestDist = Infinity;
    let first = 1;
    for (const el of this.pagesEl.children) {
      const row = el as HTMLElement;
      const page = this.currentPage >= first && this.currentPage < first + step ? this.currentPage : first;
      const top = row.offsetTop;
      const center = top + row.offsetHeight / 2;
      const dist = Math.abs(center - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = page;
      }
      if (mid >= top && mid <= top + row.offsetHeight) return page;
      first += step;
    }
    return best;
  }

  private setCurrentPage(page: number): void {
    if (page === this.currentPage) return;
    this.currentPage = page;
    this.events.onPageChange(page);
    this.scheduleRender();
    window.setTimeout(() => this.armReadTimer(), 180);
  }

  // ------------------------------------------------------------- read state

  private armReadTimer(): void {
    if (!this.settings.autoRead || this.readPages.has(this.currentPage)) return;
    if (!this.visible.has(this.currentPage)) return;
    if (this.readTimer && this.readTimerPage === this.currentPage) return;
    window.clearTimeout(this.readTimer);
    const page = this.currentPage;
    this.readTimerPage = page;
    this.readTimer = window.setTimeout(() => {
      this.readTimer = 0;
      if (this.currentPage === page) this.markRead(page, true);
    }, Math.max(1, this.settings.readDwellSec) * 1000);
  }

  setAutoRead(enabled: boolean, dwellSec: number): void {
    this.settings.autoRead = enabled;
    this.settings.readDwellSec = dwellSec;
    window.clearTimeout(this.readTimer);
    this.readTimer = 0;
    this.readTimerPage = 0;
    if (enabled) this.armReadTimer();
  }

  markRead(n: number, value: boolean): void {
    if (value === this.readPages.has(n)) return;
    if (value) this.readPages.add(n);
    else this.readPages.delete(n);
    const pv = this.pageViews.get(n);
    if (pv) this.updateBadge(pv);
    this.events.onReadChange();
  }

  toggleReadCurrent(): void {
    this.markRead(this.currentPage, !this.readPages.has(this.currentPage));
  }

  getReadPages(): number[] {
    return [...this.readPages].sort((a, b) => a - b);
  }

  getProgress(): number {
    return this.numPages ? this.readPages.size / this.numPages : 0;
  }

  private updateBadge(pv: PageView): void {
    pv.badge.classList.toggle("visible", this.readPages.has(pv.num));
  }

  // ------------------------------------------------------------- annotations

  getAnnotations(): Annotation[] {
    return this.annotations;
  }

  addAnnotations(anns: Annotation[]): void {
    if (!anns.length) return;
    const cmd = {
      do: () => this.insert(anns),
      undo: () => this.removeByIds(new Set(anns.map((a) => a.id))),
    };
    this.history.push(cmd);
  }

  private insert(anns: Annotation[]): void {
    const existing = new Set(this.annotations.map((a) => a.id));
    const fresh = anns.filter((a) => !existing.has(a.id));
    this.annotations.push(...fresh);
    for (const a of fresh) this.renderAnnotations(a.page);
    this.afterAnnotationsChange();
  }

  private removeByIds(ids: Set<string>): void {
    const pages = new Set<number>();
    this.annotations = this.annotations.filter((a) => {
      if (ids.has(a.id)) {
        pages.add(a.page);
        return false;
      }
      return true;
    });
    for (const p of pages) this.renderAnnotations(p);
    this.afterAnnotationsChange();
  }

  deleteAnnotations(ids: string[]): void {
    if (!ids.length) return;
    const set = new Set(ids);
    const removed = this.annotations.filter((a) => set.has(a.id));
    if (!removed.length) return;
    this.history.push({
      do: () => this.removeByIds(set),
      undo: () => this.insert(removed),
    });
  }

  updateAnnotation(id: string, patch: Partial<Annotation>): void {
    const ann = this.annotations.find((a) => a.id === id);
    if (!ann) return;
    const before = { ...ann };
    const after = { ...ann, ...patch, updatedAt: new Date().toISOString() };
    this.history.push({
      do: () => this.applyAnnotation(after),
      undo: () => this.applyAnnotation(before),
    });
  }

  private applyAnnotation(ann: Annotation): void {
    const idx = this.annotations.findIndex((a) => a.id === ann.id);
    if (idx < 0) return;
    const oldPage = this.annotations[idx]!.page;
    this.annotations[idx] = ann;
    this.renderAnnotations(oldPage);
    if (ann.page !== oldPage) this.renderAnnotations(ann.page);
    this.afterAnnotationsChange();
  }

  getAnnotation(id: string): Annotation | undefined {
    return this.annotations.find((a) => a.id === id);
  }

  private afterAnnotationsChange(): void {
    this.selectedAnn = this.selectedAnn && this.getAnnotation(this.selectedAnn) ? this.selectedAnn : null;
    this.events.onAnnotationsChange();
  }

  undo(): void {
    if (this.history.undo()) {
      this.events.onAnnotationsChange();
      this.events.onToast("已撤销");
    }
  }

  redo(): void {
    if (this.history.redo()) {
      this.events.onAnnotationsChange();
      this.events.onToast("已重做");
    }
  }

  setSelectedAnnotation(id: string | null): void {
    const prev = this.selectedAnn;
    this.selectedAnn = id;
    const pages = new Set<number>();
    for (const aid of [prev, id]) {
      if (!aid) continue;
      const a = this.getAnnotation(aid);
      if (a) pages.add(a.page);
    }
    for (const p of pages) this.renderAnnotations(p);
  }

  // -------------------------------------------------------------- annotation UI

  private renderAnnotations(n: number): void {
    const pv = this.pageViews.get(n);
    if (!pv) return;
    const w = Math.max(1, pv.el.clientWidth);
    const h = Math.max(1, pv.el.clientHeight);
    const svg = pv.svg;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const delta = this.rotationDelta;
    for (const ann of this.annotations) {
      if (ann.page !== n) continue;
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "ann" + (this.selectedAnn === ann.id ? " selected" : ""));
      g.dataset.id = ann.id;

      if (ann.quads?.length) {
        // One highlight annotation is painted as a single composited layer.
        // Line boxes from a wrapped selection often overlap by a pixel or two;
        // painting each quad with its own fill-opacity makes those seams
        // darker. With group opacity the quads union first, then fade once.
        const highlightLayer =
          ann.type === "highlight" ? document.createElementNS(NS, "g") : null;
        if (highlightLayer) {
          highlightLayer.setAttribute("class", "ann-highlight");
          highlightLayer.setAttribute("opacity", String(ann.opacity ?? 0.38));
        }
        for (const q of ann.quads) {
          const dq = rotateQuad(q, delta);
          const x = dq.x * w;
          const y = dq.y * h;
          const qw = Math.max(0.5, dq.w * w);
          const qh = Math.max(0.5, dq.h * h);

          if (ann.type === "highlight" || ann.type === "box") {
            const r = document.createElementNS(NS, "rect");
            r.setAttribute("x", String(x));
            r.setAttribute("y", String(y));
            r.setAttribute("width", String(qw));
            r.setAttribute("height", String(qh));
            r.setAttribute("rx", "2");
            r.setAttribute("fill", ann.color);
            if (ann.type === "highlight") {
              r.setAttribute("fill-opacity", "1");
            } else {
              r.setAttribute("fill-opacity", String(ann.opacity ?? 0.14));
              r.setAttribute("stroke", ann.color);
              r.setAttribute("stroke-width", "1.5");
              r.setAttribute("stroke-dasharray", "4 3");
            }
            (highlightLayer ?? g).append(r);
          } else if (ann.type === "redact") {
            const r = document.createElementNS(NS, "rect");
            r.setAttribute("x", String(x));
            r.setAttribute("y", String(y));
            r.setAttribute("width", String(qw));
            r.setAttribute("height", String(qh));
            r.setAttribute("fill", ann.color);
            g.append(r);
          } else if (ann.type === "underline" || ann.type === "strikeout") {
            const ratio = ann.type === "underline" ? 0.94 : 0.52;
            const thin: Quad = { x: q.x, y: q.y + q.h * ratio, w: q.w, h: Math.max(0.0015, 1.4 / Math.max(1, h)) };
            const dq2 = rotateQuad(thin, delta);
            const r = document.createElementNS(NS, "rect");
            r.setAttribute("x", String(dq2.x * w));
            r.setAttribute("y", String(dq2.y * h));
            r.setAttribute("width", String(Math.max(1, dq2.w * w)));
            r.setAttribute("height", String(Math.max(1, dq2.h * h)));
            r.setAttribute("fill", ann.color);
            g.append(r);
          }
        }
        if (highlightLayer) g.append(highlightLayer);
      }

      if (ann.type === "ink" || ann.type === "redact") {
        const width = Math.max(1, (ann.width ?? 0.004) * pv.meta.baseW * this.scale);
        for (const path of ann.paths ?? []) {
          if (path.length < 2) continue;
          const d = path
            .map((pt, i) => {
              const rp = rotatePoint(pt, delta);
              return `${i ? "L" : "M"}${(rp.x * w).toFixed(1)} ${(rp.y * h).toFixed(1)}`;
            })
            .join(" ");
          const p = document.createElementNS(NS, "path");
          p.setAttribute("d", d);
          p.setAttribute("fill", "none");
          p.setAttribute("stroke", ann.color);
          p.setAttribute("stroke-width", String(width));
          p.setAttribute("stroke-linecap", "round");
          p.setAttribute("stroke-linejoin", "round");
          p.setAttribute("opacity", String(ann.opacity ?? (ann.type === "redact" ? 1 : 0.55)));
          g.append(p);
        }
      }

      if (ann.type === "note" && ann.point) {
        const p = rotatePoint(ann.point, delta);
        const cx = p.x * w;
        const cy = p.y * h;
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(cx));
        c.setAttribute("cy", String(cy));
        c.setAttribute("r", "9");
        c.setAttribute("fill", ann.color);
        c.setAttribute("stroke", "#fff");
        c.setAttribute("stroke-width", "1.5");
        g.append(c);
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", String(cx));
        t.setAttribute("y", String(cy + 3.6));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-size", "10");
        t.setAttribute("font-family", "system-ui, sans-serif");
        t.setAttribute("fill", "#1f2328");
        t.setAttribute("pointer-events", "none");
        t.textContent = "i";
        g.append(t);
      }

      svg.append(g);
    }
  }

  private hitTest(page: PageView, displayPoint: { x: number; y: number }): Annotation | null {
    // Selection and pointer coordinates are display-space; annotations are
    // stored in the page's intrinsic orientation.
    const p = rotatePoint(displayPoint, -this.rotationDelta);

    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const ann = this.annotations[i]!;
      if (ann.page !== page.num) continue;
      if (ann.quads?.some((q) => pointInQuad(p, q))) return ann;
      if (ann.type === "note" && ann.point) {
        const dx = ann.point.x - p.x;
        const dy = ann.point.y - p.y;
        if (dx * dx + dy * dy < 0.0009) return ann;
      }
      if (ann.paths) {
        for (const path of ann.paths) {
          for (let k = 1; k < path.length; k++) {
            const a = path[k - 1]!;
            const b = path[k]!;
            if (distancePointSegment(p, a, b) < 0.006) return ann;
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ tools

  setSettings(next: Settings): void {
    this.settings = next;
    this.setNightMode(next.nightMode);
    this.setAutoRead(next.autoRead, next.readDwellSec);
  }

  setTool(tool: Tool, color?: string): void {
    this.tool = tool;
    if (color) this.toolColor = color;
    this.scroller.dataset.tool = tool;
    this.events.onSelection(null);
  }

  setToolColor(color: string): void {
    this.toolColor = color;
  }

  getTool(): Tool {
    return this.tool;
  }

  // ------------------------------------------------------------- selection

  private onMouseUp = (): void => {
    if (
      this.tool === "ink" ||
      this.tool === "box" ||
      this.tool === "redact" ||
      this.tool === "eraser" ||
      this.tool === "note"
    ) {
      return;
    }
    window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        this.events.onSelection(null);
        if (this.tool === "select") this.pickAnnotationAtPointer();
        return;
      }
      this.collectSelection();
    }, 0);
  };

  private pickAnnotationAtPointer(): void {
    const at = this.pointerDownAt;
    if (!at) return;
    const el = document.elementFromPoint(at.x, at.y)?.closest?.(".page") as HTMLElement | null;
    if (!el) return;
    const pv = this.pageViews.get(Number(el.dataset.page));
    if (!pv) return;
    const r = pv.el.getBoundingClientRect();
    const disp = {
      x: (at.x - r.left) / Math.max(1, r.width),
      y: (at.y - r.top) / Math.max(1, r.height),
    };
    const ann = this.hitTest(pv, disp);
    if (!ann) {
      this.setSelectedAnnotation(null);
      this.events.onAnnotationSelect(null, null);
      return;
    }
    this.setSelectedAnnotation(ann.id);
    let anchor = new DOMRect(at.x, at.y, 1, 1);
    const q = ann.quads?.[0];
    if (q) {
      const dq = rotateQuad(q, this.rotationDelta);
      anchor = new DOMRect(
        r.left + dq.x * r.width,
        r.top + dq.y * r.height,
        dq.w * r.width,
        dq.h * r.height,
      );
    }
    this.events.onAnnotationSelect(ann, anchor);
  }

  readSelection(): SelectionPayload | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      return null;
    }
    const range = sel.getRangeAt(0);
    const byPage = new Map<number, { horizontal: Quad[]; vertical: Quad[]; angled: Quad[] }>();
    const pageBoxes = new Map<number, DOMRect>();
    const spanBoxes = new Map<HTMLElement, { box: DOMRect; axis: TextAxis }>();
    const fragment = document.createRange();
    for (const node of selectedTextNodes(this.pagesEl, range)) {
      const span = node.parentElement;
      const pageEl = span?.closest<HTMLElement>(".page");
      const num = Number(pageEl?.dataset.page);
      const pv = this.pageViews.get(num);
      if (!span?.matches("span:not(.markedContent)") || !pageEl || !pv?.textEl.contains(span)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (start >= end) continue;
      fragment.setStart(node, start);
      fragment.setEnd(node, end);

      let pr = pageBoxes.get(num);
      if (!pr) {
        pr = pageEl.getBoundingClientRect();
        pageBoxes.set(num, pr);
      }
      if (!pr.width || !pr.height) continue;
      let metrics = spanBoxes.get(span);
      if (!metrics) {
        metrics = { box: span.getBoundingClientRect(), axis: textAxis(span, pv.textRot) };
        spanBoxes.set(span, metrics);
      }
      const { box, axis } = metrics;
      const entry = byPage.get(num) ?? { horizontal: [], vertical: [], angled: [] };
      for (const r of fragment.getClientRects()) {
        const left = axis === "vertical" ? Math.max(r.left, box.left) : r.left;
        const right = axis === "vertical" ? Math.min(r.right, box.right) : r.right;
        const top = axis === "horizontal" ? Math.max(r.top, box.top) : r.top;
        const bottom = axis === "horizontal" ? Math.min(r.bottom, box.bottom) : r.bottom;
        if (right <= left || bottom <= top) continue;
        entry[axis].push({
          x: (left - pr.left) / pr.width,
          y: (top - pr.top) / pr.height,
          w: (right - left) / pr.width,
          h: (bottom - top) / pr.height,
        });
        byPage.set(num, entry);
      }
    }
    if (!byPage.size) {
      return null;
    }

    const text = sel.toString().replace(/\s+\n/g, "\n").trim();
    if (!text) return null;
    const groups: SelectionGroup[] = [];
    for (const [page, entry] of byPage) {
      const merged = [
        ...mergeQuads(entry.horizontal),
        ...mergeQuads(entry.vertical.map(transposeQuad)).map(transposeQuad),
        ...entry.angled,
      ];
      const quads = merged.map((q) => unrotateQuad(q, this.rotationDelta));
      if (!quads.length) continue;
      groups.push({ page, quads, text: groups.length === 0 ? text : "" });
    }
    if (!groups.length) {
      return null;
    }

    return {
      text,
      page: groups[0]!.page,
      quads: groups[0]!.quads,
      groups,
      rect: range.getBoundingClientRect(),
    };
  }

  collectSelection(): void {
    const payload = this.readSelection();
    if (!payload) {
      this.events.onSelection(null);
      return;
    }

    if (this.tool === "highlight" || this.tool === "underline" || this.tool === "strikeout") {
      this.annotateSelection(payload, this.tool, this.toolColor);
      window.getSelection()?.removeAllRanges();
      this.events.onSelection(null);
      return;
    }
    this.events.onSelection(payload);
  }

  annotateSelection(sel: SelectionPayload, type: "highlight" | "underline" | "strikeout", color: string): void {
    const now = new Date().toISOString();
    const anns: Annotation[] = sel.groups.map((g) => ({
      id: uid(),
      type,
      page: g.page,
      color,
      opacity: type === "highlight" ? 0.38 : 1,
      quads: g.quads,
      text: g.text,
      createdAt: now,
      updatedAt: now,
    }));
    this.addAnnotations(anns);
    window.getSelection()?.removeAllRanges();
  }

  // ---------------------------------------------------------------- pointer

  private localPoint(e: PointerEvent, pv: PageView): { x: number; y: number } {
    const r = pv.el.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
      y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1),
    };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.pdf) return;
    const pageEl = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    if (!pageEl) return;
    const pv = this.pageViews.get(Number(pageEl.dataset.page));
    if (!pv) return;

    this.pointerDownAt = { x: e.clientX, y: e.clientY };
    const disp = this.localPoint(e, pv);
    const base = rotatePoint(disp, -this.rotationDelta);

    if (this.tool === "note") {
      e.preventDefault();
      this.events.onNoteRequest(pv.num, base, null);
      return;
    }

    if (this.tool === "ink" || this.tool === "redact" || this.tool === "box") {
      e.preventDefault();
      this.pagesEl.setPointerCapture(e.pointerId);
      const kind = this.tool;
      this.drag = {
        kind,
        page: pv,
        points: [{ x: disp.x, y: disp.y }],
        el: null,
        eraseIds: new Set(),
      };
      if (kind === "ink" || kind === "redact") {
        const p = document.createElementNS(NS, "polyline");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", this.toolColor);
        p.setAttribute("stroke-opacity", kind === "redact" ? "1" : "0.55");
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        p.setAttribute(
          "stroke-width",
          String(Math.max(1, (kind === "redact" ? 0.02 : 0.004) * pv.meta.baseW * this.scale)),
        );
        p.setAttribute("points", `${disp.x * pv.el.clientWidth},${disp.y * pv.el.clientHeight}`);
        pv.svg.append(p);
        this.drag.el = p;
      } else {
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("fill", this.toolColor);
        r.setAttribute("fill-opacity", "0.14");
        r.setAttribute("stroke", this.toolColor);
        r.setAttribute("stroke-dasharray", "4 3");
        r.setAttribute("stroke-width", "1.5");
        pv.svg.append(r);
        this.drag.el = r;
      }
      return;
    }

    if (this.tool === "eraser") {
      e.preventDefault();
      this.pagesEl.setPointerCapture(e.pointerId);
      this.drag = { kind: "erase", page: pv, points: [disp], el: null, eraseIds: new Set() };
      this.eraseAt(pv, base);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const pv = this.drag.page;
    const disp = this.localPoint(e, pv);
    const base = rotatePoint(disp, -this.rotationDelta);

    if (this.drag.kind === "erase") {
      this.eraseAt(pv, base);
      return;
    }

    if (this.drag.kind === "ink" || this.drag.kind === "redact") {
      const last = this.drag.points[this.drag.points.length - 1]!;
      if (Math.hypot(disp.x - last.x, disp.y - last.y) < 0.0015) return;
      this.drag.points.push({ x: disp.x, y: disp.y });
      if (this.drag.el) {
        const pts = this.drag.points
          .map((p) => `${(p.x * pv.el.clientWidth).toFixed(1)},${(p.y * pv.el.clientHeight).toFixed(1)}`)
          .join(" ");
        this.drag.el.setAttribute("points", pts);
      }
      return;
    }

    if (this.drag.kind === "box") {
      const start = this.drag.points[0]!;
      const q = bboxQuad(start, disp);
      if (this.drag.el) {
        this.drag.el.setAttribute("x", String(q.x * pv.el.clientWidth));
        this.drag.el.setAttribute("y", String(q.y * pv.el.clientHeight));
        this.drag.el.setAttribute("width", String(q.w * pv.el.clientWidth));
        this.drag.el.setAttribute("height", String(q.h * pv.el.clientHeight));
      }
    }
  };

  private onPointerUp = (): void => {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    drag.el?.remove();

    if (drag.kind === "erase") {
      if (drag.eraseIds.size) this.deleteAnnotations([...drag.eraseIds]);
      return;
    }

    const now = new Date().toISOString();
    if (drag.kind === "box") {
      const start = drag.points[0]!;
      const last = drag.points[drag.points.length - 1]!;
      const disp = bboxQuad(start, last);
      if (disp.w < 0.008 || disp.h < 0.003) return;
      const quad = unrotateQuad(disp, this.rotationDelta);
      this.addAnnotations([
        {
          id: uid(),
          type: "box",
          page: drag.page.num,
          color: this.toolColor,
          opacity: 0.14,
          quads: [quad],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      return;
    }

    if (drag.kind === "ink" || drag.kind === "redact") {
      if (drag.points.length < 2) return;
      const path = drag.points.map((p) => rotatePoint(p, -this.rotationDelta));
      this.addAnnotations([
        {
          id: uid(),
          type: drag.kind === "redact" ? "redact" : "ink",
          page: drag.page.num,
          color: this.toolColor,
          opacity: drag.kind === "redact" ? 1 : 0.55,
          width: drag.kind === "redact" ? 0.02 : 0.004,
          paths: [path],
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
  };

  private eraseAt(pv: PageView, base: { x: number; y: number }): void {
    if (!this.drag) return;
    const hit = this.hitTest(pv, rotatePoint(base, this.rotationDelta));
    if (hit && !this.drag.eraseIds.has(hit.id)) {
      this.drag.eraseIds.add(hit.id);
      this.setSelectedAnnotation(hit.id);
    }
  }

  private onDoubleClick = (e: MouseEvent): void => {
    if (!this.pdf) return;
    const pageEl = (e.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    if (!pageEl) return;
    const pv = this.pageViews.get(Number(pageEl.dataset.page));
    if (!pv) return;
    const disp = this.localPoint(e as unknown as PointerEvent, pv);
    const ann = this.hitTest(pv, disp);
    if (ann?.type === "note") {
      this.events.onNoteRequest(ann.page, ann.point ?? { x: 0, y: 0 }, ann);
    }
  };

  // ------------------------------------------------------------ search

  setSearch(query: string, caseSensitive: boolean): void {
    this.searchQuery = query;
    this.searchCase = caseSensitive;
    this.searchIndex = -1;
    this.searchRanges.clear();
    this.applySearchHighlightAll();
  }

  async runSearch(query: string, caseSensitive: boolean): Promise<SearchResult[]> {
    this.searchQuery = query;
    this.searchCase = caseSensitive;
    this.searchHits = [];
    this.searchIndex = -1;
    const gen = ++this.searchGen;
    if (!query) {
      this.setSearch("", caseSensitive);
      this.events.onSearchResults([], -1);
      return [];
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: SearchResult[] = [];
    for (let n = 1; n <= this.numPages; n++) {
      if (gen !== this.searchGen) return results;
      const text = await this.pageText(n);
      if (!text) continue;
      const hay = caseSensitive ? text : text.toLowerCase();
      let idx = 0;
      while (idx >= 0 && results.length < 400) {
        idx = hay.indexOf(needle, idx);
        if (idx < 0) break;
        const from = Math.max(0, idx - 32);
        const to = Math.min(text.length, idx + needle.length + 48);
        results.push({
          page: n,
          snippet: text.slice(from, to).replace(/\s+/g, " ").trim(),
        });
        idx += needle.length;
      }
      if (results.length >= 400) break;
      if (n % 12 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    if (gen !== this.searchGen) return results;
    this.searchHits = results;
    this.searchIndex = results.length ? 0 : -1;
    for (const pv of this.pageViews.values()) this.applySearchHighlight(pv.num);
    this.events.onSearchResults(results, this.searchIndex);
    if (results.length) this.gotoSearchResult(0);
    return results;
  }

  gotoSearchResult(index: number): void {
    if (!this.searchHits.length) return;
    this.searchIndex = ((index % this.searchHits.length) + this.searchHits.length) % this.searchHits.length;
    const hit = this.searchHits[this.searchIndex]!;
    this.goToPage(hit.page);
    this.paintCurrentHit();
    this.events.onSearchResults(this.searchHits, this.searchIndex);
  }

  nextSearchResult(): void {
    this.gotoSearchResult(this.searchIndex + 1);
  }

  prevSearchResult(): void {
    this.gotoSearchResult(this.searchIndex - 1);
  }

  clearSearch(): void {
    this.searchGen++;
    this.searchQuery = "";
    this.searchHits = [];
    this.searchIndex = -1;
    this.searchRanges.clear();
    this.applySearchHighlightAll();
    this.events.onSearchResults([], -1);
  }

  private applySearchHighlightAll(): void {
    for (const pv of this.pageViews.values()) this.applySearchHighlight(pv.num);
  }

  private applySearchHighlight(n: number): void {
    const pv = this.pageViews.get(n);
    if (!pv) return;
    const ranges: Range[] = [];
    const q = this.searchQuery;
    if (q) {
      const spans = pv.textEl.querySelectorAll("span");
      spans.forEach((span) => {
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        const text = span.textContent ?? "";
        const hay = this.searchCase ? text : text.toLowerCase();
        const needle = this.searchCase ? q : q.toLowerCase();
        let idx = 0;
        while (idx >= 0) {
          idx = hay.indexOf(needle, idx);
          if (idx < 0) break;
          const r = document.createRange();
          r.setStart(node, idx);
          r.setEnd(node, idx + q.length);
          ranges.push(r);
          idx += q.length;
          if (ranges.length > 300) break;
        }
      });
    }
    if (ranges.length) this.searchRanges.set(n, ranges);
    else this.searchRanges.delete(n);
    this.refreshCssHighlights();

    // Fallback for WebViews without the CSS Custom Highlight API.
    if (!("highlights" in CSS) || typeof (window as any).Highlight === "undefined") {
      pv.textEl.querySelectorAll(".search-fallback").forEach((el) => el.classList.remove("search-fallback"));
      if (q) {
        pv.textEl.querySelectorAll("span").forEach((span) => {
          const text = span.textContent ?? "";
          const hay = this.searchCase ? text : text.toLowerCase();
          const needle = this.searchCase ? q : q.toLowerCase();
          if (hay.includes(needle)) span.classList.add("search-fallback");
        });
      }
    }
  }

  private refreshCssHighlights(): void {
    const anyCss = CSS as any;
    if (!("highlights" in anyCss) || typeof (window as any).Highlight === "undefined") return;
    const all = [...this.searchRanges.values()].flat();
    if (all.length) anyCss.highlights.set("pv-search", new (window as any).Highlight(...all));
    else anyCss.highlights.delete("pv-search");
    const current = this.searchHits[this.searchIndex];
    if (current) {
      const rs = this.searchRanges.get(current.page) ?? [];
      if (rs.length) anyCss.highlights.set("pv-search-current", new (window as any).Highlight(rs[0]));
    }
  }

  private paintCurrentHit(): void {
    this.refreshCssHighlights();
  }

  // --------------------------------------------------------------- sidebar

  async renderThumbnails(container: HTMLElement): Promise<void> {
    if (!this.pdf) return;
    container.innerHTML = "";
    this.thumbObserver?.disconnect();
    const list = document.createElement("div");
    list.className = "thumbs";
    container.append(list);

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          io.unobserve(el);
          void this.drawThumb(el);
        }
      },
      { root: container, rootMargin: "300px 0px" },
    );
    this.thumbObserver = io;

    for (let n = 1; n <= this.numPages; n++) {
      const item = document.createElement("button");
      item.className = "thumb" + (n === this.currentPage ? " current" : "");
      item.dataset.page = String(n);
      item.innerHTML = `<canvas></canvas><span class="thumb-no">${n}</span><span class="thumb-read">✓</span>`;
      item.addEventListener("click", () => this.goToPage(n));
      list.append(item);
      io.observe(item);
    }
    this.syncThumbStates(container);
  }

  private async drawThumb(item: HTMLElement): Promise<void> {
    if (!this.pdf) return;
    const n = Number(item.dataset.page);
    const canvas = item.querySelector("canvas") as HTMLCanvasElement | null;
    const pv = this.pageViews.get(n);
    if (!canvas || !pv) return;
    const page = await this.pdf.getPage(n);
    const targetW = 150;
    const scale = targetW / pv.meta.baseW;
    const vp = page.getViewport({ scale, rotation: normRot(pv.meta.intrinsicRot + this.rotationDelta) });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      this.diag(`canvas 2d context unavailable for page ${n}`);
      return;
    }
    await page
      .render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      .promise.catch(() => undefined);
  }

  syncThumbStates(container?: HTMLElement): void {
    const root = container ?? this.scroller.ownerDocument;
    root.querySelectorAll<HTMLElement>(".thumb").forEach((item) => {
      const n = Number(item.dataset.page);
      item.classList.toggle("current", n === this.currentPage);
      item.classList.toggle("read", this.readPages.has(n));
    });
  }

  async renderOutline(container: HTMLElement): Promise<boolean> {
    if (!this.pdf) return false;
    container.innerHTML = "";
    let items: any[] | null = null;
    try {
      items = await this.pdf.getOutline();
    } catch {
      items = null;
    }
    if (!items?.length) return false;

    const list = document.createElement("div");
    list.className = "outline";
    const build = async (nodes: any[], parent: HTMLElement, depth: number): Promise<void> => {
      for (const node of nodes) {
        if (Array.isArray(node.items) && node.items.length) {
          const group = document.createElement("div");
          group.className = "outline-group";
          const label = document.createElement("div");
          label.className = "outline-label";
          label.textContent = node.title || "未命名";
          group.append(label);
          const sub = document.createElement("div");
          sub.className = "outline-sub";
          await build(node.items, sub, depth + 1);
          group.append(sub);
          parent.append(group);
        } else {
          const btn = document.createElement("button");
          btn.className = "outline-item";
          btn.style.paddingLeft = `${12 + depth * 14}px`;
          btn.textContent = node.title || "未命名";
          btn.addEventListener("click", async () => {
            const page = await this.resolveDest(node.dest);
            if (page) this.goToPage(page);
          });
          parent.append(btn);
        }
      }
    };
    await build(items, list, 0);
    container.append(list);
    return true;
  }

  private async resolveDest(dest: any): Promise<number | null> {
    if (!this.pdf) return null;
    try {
      let d = dest;
      if (typeof d === "string") d = await this.pdf.getDestination(d);
      if (!Array.isArray(d) || !d.length) return null;
      const ref = d[0];
      if (typeof ref === "number") return ref + 1;
      const idx = await this.pdf.getPageIndex(ref);
      return idx + 1;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ misc

  getDocInfo(): DocInfo | null {
    return this.docInfo;
  }

  private diag(message: string): void {
    this.events.onDiagnostic?.(message);
  }

  /** Pixel-level health check used to diagnose blank pages on a platform. */
  async diagnostics(): Promise<string> {
    const pv = this.pageViews.get(this.currentPage) ?? this.pageViews.get(1);
    if (!pv) return JSON.stringify({ error: "no pages" });
    const c = pv.canvas;
    let nonWhite = -1;
    let total = 0;
    let err = "";
    try {
      const ctx = c.getContext("2d");
      if (!ctx) {
        err = "no 2d context";
      } else {
        const h = Math.min(c.height, 400);
        const data = ctx.getImageData(0, 0, Math.max(1, c.width), Math.max(1, h)).data;
        total = data.length / 4;
        nonWhite = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) nonWhite++;
        }
      }
    } catch (e) {
      err = String(e);
    }
    return JSON.stringify({
      ua: navigator.userAgent,
      page: pv.num,
      scale: Number(this.scale.toFixed(3)),
      dpr: window.devicePixelRatio,
      canvas: [c.width, c.height],
      css: [pv.el.clientWidth, pv.el.clientHeight],
      renderedScale: pv.renderedScale,
      textSpans: pv.textEl.childElementCount,
      nonWhite,
      total,
      err,
      visible: [...this.visible],
    });
  }

  readingState(): ReadingState {
    return {
      lastPage: this.currentPage,
      scrollRatio: this.scrollRatio(),
      zoom: this.scale,
      viewMode: "continuous",
      readPages: this.getReadPages(),
    };
  }

  setNightMode(on: boolean): void {
    this.scroller.classList.toggle("night", on);
  }

  destroy(): void {
    this.loadGen++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.reset();
  }
}

function bboxQuad(a: { x: number; y: number }, b: { x: number; y: number }): Quad {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function* selectedTextNodes(pages: HTMLElement, range: Range): IterableIterator<Text> {
  if (!range.intersectsNode(pages)) return;
  const ancestor = range.commonAncestorContainer;
  const root = pages.contains(ancestor) ? ancestor : pages;
  if (root instanceof Text) {
    yield root;
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    yield node as Text;
  }
}

type TextAxis = "horizontal" | "vertical" | "angled";

function textAxis(span: HTMLElement, pageRotation: number): TextAxis {
  const transform = getComputedStyle(span).transform;
  const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
  const radians = Math.atan2(matrix?.b ?? 0, matrix?.a ?? 1) + pageRotation * Math.PI / 180;
  if (Math.abs(Math.sin(radians)) < 0.01) return "horizontal";
  if (Math.abs(Math.cos(radians)) < 0.01) return "vertical";
  return "angled";
}

function transposeQuad(q: Quad): Quad {
  return { x: q.y, y: q.x, w: q.h, h: q.w };
}

function mergeQuads(rects: Quad[]): Quad[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Quad[] = [];
  for (const r of sorted) {
    let merged = false;
    for (const q of out) {
      const overlap = Math.min(q.y + q.h, r.y + r.h) - Math.max(q.y, r.y);
      if (overlap < Math.min(q.h, r.h) * 0.5) continue;
      const near = r.x <= q.x + q.w + 0.012 && r.x + r.w >= q.x - 0.012;
      if (!near) continue;
      const x = Math.min(q.x, r.x);
      const y = Math.min(q.y, r.y);
      const right = Math.max(q.x + q.w, r.x + r.w);
      const bottom = Math.max(q.y + q.h, r.y + r.h);
      q.x = x;
      q.y = y;
      q.w = right - x;
      q.h = bottom - y;
      merged = true;
      break;
    }
    if (!merged) out.push({ ...r });
  }
  return out;
}

function distancePointSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

function joinItems(items: any[]): string {
  let out = "";
  for (const item of items) {
    const s = typeof item.str === "string" ? item.str : "";
    if (!s) continue;
    if (!out) {
      out = s;
      continue;
    }
    const prev = out[out.length - 1]!;
    const next = s[0]!;
    if (isCjk(prev) && isCjk(next)) out += s;
    else out += " " + s;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}
