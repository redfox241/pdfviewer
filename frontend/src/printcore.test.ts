import { describe, expect, it } from "vitest";
import {
  blendWithWhite,
  buildPrintPlan,
  displayPointToPdf,
  displayRectToPdf,
  exportFileName,
  exportSummary,
  parsePageSpec,
  planSummary,
  type PdfPageBox,
} from "./printcore";
import type { Annotation } from "./model";

function ann(partial: Partial<Annotation> & Pick<Annotation, "id" | "type" | "page">): Annotation {
  return {
    color: "#ffd84d",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  } as Annotation;
}

describe("parsePageSpec", () => {
  it("parses ranges, single pages and Chinese punctuation", () => {
    expect(parsePageSpec("1-3，5、8–10", 20)).toEqual({
      pages: [1, 2, 3, 5, 8, 9, 10],
      error: "",
    });
  });

  it("normalizes full-width digits and whitespace", () => {
    expect(parsePageSpec(" １ ～ ３ , ５ ", 10).pages).toEqual([1, 2, 3, 5]);
  });

  it("deduplicates and sorts", () => {
    expect(parsePageSpec("4,2-3,1,3", 5).pages).toEqual([1, 2, 3, 4]);
  });

  it("rejects empty, malformed and out-of-range input", () => {
    expect(parsePageSpec("", 5).error).not.toBe("");
    expect(parsePageSpec("1,,2", 5).error).not.toBe("");
    expect(parsePageSpec("3-1", 5).error).not.toBe("");
    expect(parsePageSpec("0", 5).error).not.toBe("");
    expect(parsePageSpec("6", 5).error).not.toBe("");
    expect(parsePageSpec("a", 5).error).not.toBe("");
    expect(parsePageSpec("1-2-3", 5).error).not.toBe("");
  });
});

describe("buildPrintPlan", () => {
  const annotations: Annotation[] = [
    ann({ id: "b", type: "note", page: 2, point: { x: 0.5, y: 0.4 }, note: "第二条" }),
    ann({ id: "a", type: "note", page: 1, point: { x: 0.3, y: 0.6 }, note: "第一条" }),
    ann({ id: "c", type: "note", page: 1, point: { x: 0.2, y: 0.2 }, note: "" }),
    ann({ id: "h", type: "highlight", page: 2, quads: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] }),
  ];

  it("uses all pages and numbers notes by page then vertical position", () => {
    const { plan, error } = buildPrintPlan(4, 1, annotations, {
      rangeMode: "all",
      rangeText: "",
      includeAnnotations: true,
      onlyAnnotated: false,
    });
    expect(error).toBe("");
    expect(plan.pages).toEqual([1, 2, 3, 4]);
    expect(plan.annotatedPages).toBe(2);
    expect(plan.notes.map((n) => [n.number, n.id, n.text])).toEqual([
      [1, "c", ""],
      [2, "a", "第一条"],
      [3, "b", "第二条"],
    ]);
  });

  it("drops notes outside the printed range", () => {
    const { plan } = buildPrintPlan(5, 1, annotations, {
      rangeMode: "custom",
      rangeText: "1",
      includeAnnotations: true,
      onlyAnnotated: false,
    });
    expect(plan.pages).toEqual([1]);
    expect(plan.notes.map((n) => n.id)).toEqual(["c", "a"]);
  });

  it("can keep only annotated pages", () => {
    const { plan } = buildPrintPlan(5, 1, annotations, {
      rangeMode: "all",
      rangeText: "",
      includeAnnotations: true,
      onlyAnnotated: true,
    });
    expect(plan.pages).toEqual([1, 2]);
  });

  it("omits notes when annotations are excluded", () => {
    const { plan } = buildPrintPlan(3, 1, annotations, {
      rangeMode: "all",
      rangeText: "",
      includeAnnotations: false,
      onlyAnnotated: false,
    });
    expect(plan.notes).toEqual([]);
    expect(plan.annotatedPages).toBe(2);
  });

  it("surfaces range errors", () => {
    const { error } = buildPrintPlan(3, 1, annotations, {
      rangeMode: "custom",
      rangeText: "9",
      includeAnnotations: true,
      onlyAnnotated: false,
    });
    expect(error).not.toBe("");
  });

  it("rejects a range that contains no annotated pages", () => {
    const { error } = buildPrintPlan(5, 1, annotations, {
      rangeMode: "custom",
      rangeText: "3-5",
      includeAnnotations: true,
      onlyAnnotated: true,
    });
    expect(error).not.toBe("");
  });
});

describe("summaries and file names", () => {
  it("summarizes the print plan", () => {
    expect(
      planSummary({ pages: [1, 2, 3], notes: [{ id: "a", page: 1, number: 1, text: "x" }], annotatedPages: 1 }, true),
    ).toContain("将打印 3 页");
  });

  it("summarizes export", () => {
    expect(
      exportSummary(10, [ann({ id: "n", type: "note", page: 1, note: "x", point: { x: 0, y: 0 } })], true),
    ).toContain("含 1 条便签附录");
  });

  it("builds names without stacking suffixes", () => {
    expect(exportFileName("报告.pdf", true)).toBe("报告 (标注).pdf");
    expect(exportFileName("report.PDF", false)).toBe("report (副本).pdf");
  });
});

describe("PDF coordinate mapping", () => {
  const base: PdfPageBox = { x: 10, y: 20, width: 600, height: 800, rotation: 0 };

  it("maps identity pages from top-left to PDF bottom-left", () => {
    expect(displayPointToPdf(0, 0, base)).toEqual({ x: 10, y: 820 });
    expect(displayPointToPdf(1, 1, base)).toEqual({ x: 610, y: 20 });
    expect(displayPointToPdf(0.5, 0.25, base)).toEqual({ x: 310, y: 620 });
  });

  it("maps 90° pages with swapped axes", () => {
    expect(displayPointToPdf(0, 0, { ...base, rotation: 90 })).toEqual({ x: 10, y: 20 });
    expect(displayPointToPdf(1, 1, { ...base, rotation: 90 })).toEqual({ x: 610, y: 820 });
    expect(displayPointToPdf(1, 0, { ...base, rotation: 90 })).toEqual({ x: 10, y: 820 });
  });

  it("maps 180° and 270° pages", () => {
    expect(displayPointToPdf(0, 0, { ...base, rotation: 180 })).toEqual({ x: 610, y: 20 });
    expect(displayPointToPdf(0, 0, { ...base, rotation: 270 })).toEqual({ x: 610, y: 820 });
    expect(displayPointToPdf(1, 1, { ...base, rotation: 270 })).toEqual({ x: 10, y: 20 });
  });

  it("converts rects into positive PDF rectangles", () => {
    const r = displayRectToPdf({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { ...base, rotation: 90 });
    expect(r.x).toBeCloseTo(130);
    expect(r.y).toBeCloseTo(100);
    expect(r.width).toBeCloseTo(240);
    expect(r.height).toBeCloseTo(240);
  });
});

describe("paper colour blending", () => {
  it("blends toward white and clamps", () => {
    expect(blendWithWhite("#000000", 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(blendWithWhite("#ff0000", 1)).toEqual({ r: 1, g: 0, b: 0 });
    expect(blendWithWhite("nope", 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });
});
