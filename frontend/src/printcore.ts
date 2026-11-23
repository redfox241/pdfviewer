import { clamp, normRot, type Annotation, type Quad } from "./model";

export type PrintRangeMode = "all" | "current" | "custom";

export interface PrintOptions {
  rangeMode: PrintRangeMode;
  rangeText: string;
  includeAnnotations: boolean;
  onlyAnnotated: boolean;
}

export interface NotePlan {
  /** Annotation id, used to look up the number while drawing. */
  id: string;
  page: number;
  /** 1-based number printed on the page and in the appendix. */
  number: number;
  text: string;
}

export interface PrintPlan {
  /** 1-based page numbers in output order. */
  pages: number[];
  notes: NotePlan[];
  /** Selected pages that have at least one annotation. */
  annotatedPages: number;
}

export interface PlanError {
  error: string;
}

/** Full scan of the PDF page box, in the page's own (unrotated) space. */
export interface PdfPageBox {
  /** CropBox origin (PDF points). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Intrinsic /Rotate, degrees. */
  rotation: number;
}

export function bodyText(ann: Annotation): string {
  return (ann.note ?? "").trim();
}

/**
 * Accepts "1-3,5,8-10" with ASCII or Chinese punctuation, full-width digits,
 * en/em dashes and stray spaces. Returns a sorted, de-duplicated list.
 */
export function parsePageSpec(input: string, total: number): { pages: number[]; error: string } {
  const fail = (error: string) => ({ pages: [] as number[], error });
  if (!Number.isFinite(total) || total < 1) return fail("文档没有可打印的页面");

  const normalized = normalizeSpec(input);
  if (!normalized) return fail("请输入页码范围，例如 1-3,5,8-10");

  const pages = new Set<number>();
  for (const token of normalized.split(",")) {
    if (!token) return fail("页码范围里有空项");
    const range = token.split("-");
    if (range.length > 2) return fail(`无法识别“${token}”`);
    if (range.some((part) => !/^\d+$/.test(part))) return fail(`无法识别“${token}”`);

    const start = Number(range[0]);
    const end = range.length === 2 ? Number(range[1]) : start;
    if (start < 1 || end < 1) return fail("页码从 1 开始");
    if (start > end) return fail(`范围起点大于终点：${token}`);
    if (end > total) return fail(`页码超出文档总页数（${total}）`);
    for (let p = start; p <= end; p++) pages.add(p);
  }

  return { pages: [...pages].sort((a, b) => a - b), error: "" };
}

function normalizeSpec(input: string): string {
  return input
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[，、；;]/g, ",")
    .replace(/[～~–—]/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^,|,$/g, "");
}

export function buildPrintPlan(
  total: number,
  currentPage: number,
  annotations: Annotation[],
  opts: PrintOptions,
): { plan: PrintPlan; error: string } {
  const empty: PrintPlan = { pages: [], notes: [], annotatedPages: 0 };
  let pages: number[];

  if (opts.rangeMode === "all") {
    pages = Array.from({ length: total }, (_, i) => i + 1);
  } else if (opts.rangeMode === "current") {
    pages = [clamp(Math.round(currentPage), 1, total)];
  } else {
    const parsed = parsePageSpec(opts.rangeText, total);
    if (parsed.error) return { plan: empty, error: parsed.error };
    pages = parsed.pages;
  }

  const byPage = new Set<number>();
  for (const ann of annotations) {
    if (ann.page >= 1 && ann.page <= total) byPage.add(ann.page);
  }

  if (opts.onlyAnnotated) pages = pages.filter((p) => byPage.has(p));
  if (!pages.length) return { plan: empty, error: "所选范围里没有可打印的页面" };

  const selected = new Set(pages);
  const notes: NotePlan[] = [];
  if (opts.includeAnnotations) {
    const noteAnns = annotations
      .filter((a) => a.type === "note" && a.point && selected.has(a.page))
      .sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        const ay = a.point?.y ?? 0;
        const by = b.point?.y ?? 0;
        if (ay !== by) return ay - by;
        const ax = a.point?.x ?? 0;
        const bx = b.point?.x ?? 0;
        if (ax !== bx) return ax - bx;
        return a.id.localeCompare(b.id);
      });
    for (const ann of noteAnns) {
      notes.push({ id: ann.id, page: ann.page, number: notes.length + 1, text: bodyText(ann) });
    }
  }

  const annotatedPages = pages.filter((p) => byPage.has(p)).length;
  return { plan: { pages, notes, annotatedPages }, error: "" };
}

export function planSummary(plan: PrintPlan, includeAnnotations: boolean): string {
  const pages = plan.pages.length;
  const parts = [`将打印 ${pages} 页`, `其中 ${plan.annotatedPages} 页含标注`];
  if (includeAnnotations && plan.notes.length) {
    const withText = plan.notes.filter((n) => n.text).length;
    parts.push(withText ? `含 ${withText} 条便签附录` : "含便签标记");
  }
  return `${parts[0]}（${parts.slice(1).join("，")}）`;
}

export function exportSummary(total: number, annotations: Annotation[], includeAnnotations: boolean): string {
  if (!includeAnnotations) return `将导出全部 ${total} 页（不含标注）`;
  const notes = annotations.filter((a) => a.type === "note" && bodyText(a)).length;
  return notes ? `将导出全部 ${total} 页，含 ${notes} 条便签附录` : `将导出全部 ${total} 页`;
}

export function exportFileName(name: string, includeAnnotations: boolean): string {
  const base = name.replace(/\.pdf$/i, "") || "文档";
  return `${base} (${includeAnnotations ? "标注" : "副本"}).pdf`;
}

export interface PdfPoint {
  x: number;
  y: number;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function displaySize(box: PdfPageBox): { width: number; height: number } {
  const swap = normRot(box.rotation) % 180 !== 0;
  return swap ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/**
 * Maps a normalized top-left point from the page's displayed (intrinsic
 * /Rotate applied) frame into PDF user space (bottom-left origin).
 */
export function displayPointToPdf(nx: number, ny: number, box: PdfPageBox): PdfPoint {
  const r = normRot(box.rotation);
  const x = clamp(nx, 0, 1);
  const y = clamp(ny, 0, 1);
  const { x: ox, y: oy, width: W, height: H } = box;
  switch (r) {
    case 90:
      return { x: ox + y * W, y: oy + x * H };
    case 180:
      return { x: ox + (1 - x) * W, y: oy + y * H };
    case 270:
      return { x: ox + (1 - y) * W, y: oy + (1 - x) * H };
    default:
      return { x: ox + x * W, y: oy + (1 - y) * H };
  }
}

/** Maps a normalized display-space rectangle into a PDF-space rectangle. */
export function displayRectToPdf(q: Quad, box: PdfPageBox): PdfRect {
  const a = displayPointToPdf(q.x, q.y, box);
  const b = displayPointToPdf(q.x + q.w, q.y + q.h, box);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Mixes an sRGB colour with white so print output does not rely on alpha. */
export function blendWithWhite(hex: string, alpha: number): { r: number; g: number; b: number } {
  const { r, g, b } = hexToRgb(hex);
  const a = clamp(alpha, 0, 1);
  return {
    r: clamp(r * a + (1 - a), 0, 1),
    g: clamp(g * a + (1 - a), 0, 1),
    b: clamp(b * a + (1 - a), 0, 1),
  };
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let s = hex.trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}
