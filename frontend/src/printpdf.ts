import fontkit from "@pdf-lib/fontkit";
import {
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  blendWithWhite,
  displayPointToPdf,
  displayRectToPdf,
  displaySize,
  type NotePlan,
  type PdfPageBox,
} from "./printcore";
import type { Annotation } from "./model";

export interface PrintPDFJob {
  url: string;
  fontUrl: string;
  pages: number[];
  annotations: Annotation[];
  notes: NotePlan[];
  includeAnnotations: boolean;
}

export type PrintPhase = "load" | "draw" | "appendix" | "save";

export interface PrintPDFHooks {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  onProgress: (done: number, total: number, phase: PrintPhase) => void;
}

/** Builds the print/export PDF. Runs in a worker in the app, in Node in tests. */
export async function generatePrintPDF(job: PrintPDFJob, hooks: PrintPDFHooks): Promise<Uint8Array> {
  let total = Math.max(1, job.pages.length);
  hooks.onProgress(0, total, "load");

  const response = await hooks.fetch(job.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取 PDF 失败（HTTP ${response.status}）`);
  const source = new Uint8Array(await response.arrayBuffer());

  const doc = await PDFDocument.load(source, { updateMetadata: false });
  doc.registerFontkit(fontkit);

  const noteNumbers = new Map(job.notes.map((n) => [n.id, n.number]));
  const annotsByPage = new Map<number, Annotation[]>();
  if (job.includeAnnotations) {
    for (const ann of job.annotations) {
      if (ann.page < 1 || ann.page > doc.getPageCount()) continue;
      const list = annotsByPage.get(ann.page) ?? [];
      list.push(ann);
      annotsByPage.set(ann.page, list);
    }
  }

  const firstPage = doc.getPage(0);
  const firstCrop = firstPage.getCropBox();
  const appendixSize = displaySize({
    x: firstCrop.x,
    y: firstCrop.y,
    width: firstCrop.width,
    height: firstCrop.height,
    rotation: firstPage.getRotation().angle,
  });

  const boxes = new Map<number, PdfPageBox>();
  for (const n of job.pages) {
    const page = doc.getPage(n - 1);
    const crop = page.getCropBox();
    boxes.set(n, {
      x: crop.x,
      y: crop.y,
      width: crop.width,
      height: crop.height,
      rotation: page.getRotation().angle,
    });
  }

  const hasNoteText = job.includeAnnotations && job.notes.some((n) => n.text);
  let cjk: PDFFont | null = null;
  let latin: PDFFont | null = null;
  if (hasNoteText) {
    const fontResponse = await hooks.fetch(job.fontUrl, { cache: "force-cache" });
    if (!fontResponse.ok) throw new Error(`读取中文字体失败（HTTP ${fontResponse.status}）`);
    const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
    cjk = await doc.embedFont(fontBytes, { subset: true });
  }
  const hasNoteMarks = job.includeAnnotations && job.notes.length > 0;
  if (hasNoteMarks) latin = await doc.embedFont(StandardFonts.HelveticaBold);

  // Draw onto the original pages before removing anything, so stored page
  // indexes and optional content stay intact.
  job.pages.forEach((n, index) => {
    const page = doc.getPage(n - 1);
    const box = boxes.get(n)!;
    const list = annotsByPage.get(n) ?? [];
    for (const ann of list) {
      drawAnnotation(page, ann, box, noteNumbers.get(ann.id), latin);
    }
    hooks.onProgress(index + 1, total, "draw");
  });

  // Printing a range is a temporary subset; export always passes every page.
  if (job.pages.length !== doc.getPageCount()) {
    const keep = new Set(job.pages);
    for (let i = doc.getPageCount() - 1; i >= 0; i--) {
      if (!keep.has(i + 1)) doc.removePage(i);
    }
  }

  if (hasNoteText && cjk) {
    appendNotes(doc, job.notes.filter((n) => n.text), appendixSize, cjk, () => {
      total += 1;
      hooks.onProgress(job.pages.length, total, "appendix");
    });
  }

  hooks.onProgress(total, total, "save");
  return doc.save();
}

export function friendlyPrintError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (/encrypt/i.test(raw)) return "暂不支持加密 PDF 的打印与导出";
  if (/password/i.test(raw)) return "暂不支持需要密码的 PDF";
  return raw || "生成打印文件失败";
}

function drawAnnotation(
  page: PDFPage,
  ann: Annotation,
  box: PdfPageBox,
  noteNumber: number | undefined,
  latin: PDFFont | null,
): void {
  if (ann.quads?.length) {
    for (const q of ann.quads) {
      const rect = displayRectToPdf(q, box);
      if (rect.width <= 0.01 || rect.height <= 0.01) continue;

      if (ann.type === "highlight") {
        const alpha = Math.max(0.55, Math.min(ann.opacity ?? 0.38, 0.85));
        page.drawRectangle({ ...rect, color: color(ann.color, alpha), borderWidth: 0 });
      } else if (ann.type === "box") {
        const alpha = Math.max(0.16, Math.min(ann.opacity ?? 0.14, 0.4));
        page.drawRectangle({
          ...rect,
          color: color(ann.color, alpha),
          borderColor: color(ann.color, 1),
          borderWidth: 0.9,
          borderDashArray: [4, 3],
          borderLineCap: LineCapStyle.Butt,
        });
      } else if (ann.type === "redact") {
        page.drawRectangle({ ...rect, color: color(ann.color, 1), borderWidth: 0 });
      } else if (ann.type === "underline" || ann.type === "strikeout") {
        const ratio = ann.type === "underline" ? 0.94 : 0.52;
        const thickness = 0.8;
        const disp = displaySize(box);
        const thin = displayRectToPdf(
          { x: q.x, y: q.y + q.h * ratio, w: q.w, h: thickness / Math.max(1, disp.height) },
          box,
        );
        page.drawRectangle({
          x: thin.x,
          y: thin.y,
          width: Math.max(0.1, thin.width),
          height: Math.max(0.1, thin.height),
          color: color(ann.color, 1),
        });
      }
    }
  }

  if (ann.type === "ink" || ann.type === "redact") {
    const thickness = Math.max(0.5, (ann.width ?? 0.004) * (box.width || 1));
    const alpha = ann.type === "redact" ? 1 : Math.max(0.55, Math.min(ann.opacity ?? 0.55, 0.9));
    const ink = color(ann.color, alpha);
    for (const path of ann.paths ?? []) {
      const pts = path.map((p) => displayPointToPdf(p.x, p.y, box));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) continue;
        page.drawLine({ start: a, end: b, thickness, color: ink, lineCap: LineCapStyle.Round });
      }
    }
  }

  if (ann.type === "note" && ann.point) {
    const center = displayPointToPdf(ann.point.x, ann.point.y, box);
    const radius = 9;
    page.drawCircle({
      x: center.x,
      y: center.y,
      size: radius,
      color: color(ann.color, 1),
      borderColor: rgb(1, 1, 1),
      borderWidth: 1.2,
    });
    if (latin) {
      const label = String(noteNumber ?? "");
      const size = label.length > 2 ? 7 : 8.5;
      const width = latin.widthOfTextAtSize(label, size);
      page.drawText(label, {
        x: center.x - width / 2,
        y: center.y - size * 0.34,
        size,
        font: latin,
        color: rgb(0.12, 0.14, 0.16),
      });
    }
  }
}

function color(hex: string, alpha: number) {
  const c = blendWithWhite(hex, alpha);
  return rgb(c.r, c.g, c.b);
}

function appendNotes(
  doc: PDFDocument,
  notes: NotePlan[],
  size: { width: number; height: number },
  font: PDFFont,
  onPage: () => void,
): void {
  const margin = 56;
  const width = Math.max(240, size.width);
  const height = Math.max(240, size.height);
  const maxWidth = width - margin * 2;
  const lead = 17;
  let page = doc.addPage([width, height]);
  let pageNo = 1;
  let y = height - margin;

  const header = () => {
    page.drawText(`便签 · 第 ${pageNo} 页`, {
      x: margin,
      y,
      size: 15,
      font,
      color: rgb(0.12, 0.14, 0.16),
    });
    y -= 28;
    page.drawLine({
      start: { x: margin, y },
      end: { x: width - margin, y },
      thickness: 0.6,
      color: rgb(0.78, 0.76, 0.72),
    });
    y -= 20;
  };
  header();
  onPage();

  for (const note of notes) {
    const lines = wrapText(note.text, font, 10.5, maxWidth);
    const block = 18 + lines.length * lead + 12;
    if (y - block < margin) {
      page = doc.addPage([width, height]);
      pageNo += 1;
      y = height - margin;
      header();
      onPage();
    }
    page.drawText(`${note.number} · 第 ${note.page} 页`, {
      x: margin,
      y,
      size: 10.5,
      font,
      color: rgb(0.35, 0.4, 0.36),
    });
    y -= 18;
    for (const line of lines) {
      page.drawText(line, { x: margin, y, size: 10.5, font, color: rgb(0.11, 0.13, 0.15) });
      y -= lead;
    }
    y -= 12;
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of Array.from(paragraph)) {
      const next = line + ch;
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}
