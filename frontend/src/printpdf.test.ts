import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generatePrintPDF } from "./printpdf";
import type { Annotation } from "./model";

const fontBytes = readFileSync(new URL("../public/fonts/NotoSansSC-Regular.ttf", import.meta.url));

async function sourcePDF(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const a = doc.addPage([300, 400]);
  a.drawText("page one", { x: 20, y: 380, size: 12, font });
  const b = doc.addPage([300, 400]);
  b.setRotation(degrees(90));
  b.drawText("page two", { x: 20, y: 380, size: 12, font });
  const c = doc.addPage([600, 800]);
  c.drawText("page three", { x: 20, y: 780, size: 12, font });
  return doc.save();
}

function ann(partial: Partial<Annotation> & Pick<Annotation, "id" | "type" | "page">): Annotation {
  return {
    color: "#ffd84d",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  } as Annotation;
}

function hooks(doc: Uint8Array, font = fontBytes) {
  const phases: string[] = [];
  return {
    phases,
    fetch: async (input: RequestInfo | URL) => {
      if (String(input).includes("font")) {
        return new Response(font as unknown as BodyInit);
      }
      return new Response(doc as unknown as BodyInit);
    },
    onProgress: (_done: number, _total: number, phase: string) => {
      phases.push(phase);
    },
  };
}

const annotations: Annotation[] = [
  ann({ id: "h1", type: "highlight", page: 1, quads: [{ x: 0.1, y: 0.1, w: 0.4, h: 0.05 }] }),
  ann({ id: "u1", type: "underline", page: 1, quads: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.04 }] }),
  ann({ id: "s1", type: "strikeout", page: 1, quads: [{ x: 0.1, y: 0.3, w: 0.4, h: 0.04 }] }),
  ann({ id: "b1", type: "box", page: 1, quads: [{ x: 0.1, y: 0.4, w: 0.3, h: 0.2 }] }),
  ann({ id: "r1", type: "redact", page: 1, quads: [{ x: 0.5, y: 0.1, w: 0.2, h: 0.02 }] }),
  ann({
    id: "r2",
    type: "redact",
    page: 1,
    color: "#111111",
    width: 0.02,
    paths: [
      [
        { x: 0.5, y: 0.3 },
        { x: 0.7, y: 0.3 },
      ],
    ],
  }),
  ann({ id: "n1", type: "note", page: 1, point: { x: 0.5, y: 0.5 }, note: "第一条便签" }),
  ann({ id: "n3", type: "note", page: 3, point: { x: 0.2, y: 0.2 }, note: "第三页的便签" }),
  ann({
    id: "ink2",
    type: "ink",
    page: 2,
    width: 0.004,
    paths: [
      [
        { x: 0.2, y: 0.2 },
        { x: 0.4, y: 0.4 },
      ],
    ],
  }),
];

describe("generatePrintPDF", () => {
  it("draws annotations, subsets pages and appends the note appendix", async () => {
    const src = await sourcePDF();
    const h = hooks(src);
    const out = await generatePrintPDF(
      {
        url: "mem://doc",
        fontUrl: "/fonts/NotoSansSC-Regular.ttf",
        pages: [1, 2],
        annotations,
        notes: [
          { id: "n1", page: 1, number: 1, text: "第一条便签" },
          { id: "n3", page: 3, number: 2, text: "第三页的便签" },
        ].filter((n) => n.page <= 2),
        includeAnnotations: true,
      },
      h,
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3); // two selected pages + one appendix
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(doc.getPage(2).getSize()).toEqual({ width: 300, height: 400 });
    expect(h.phases).toContain("appendix");
    expect(h.phases.at(-1)).toBe("save");
  });

  it("exports every page and omits the appendix when annotations are off", async () => {
    const src = await sourcePDF();
    const out = await generatePrintPDF(
      {
        url: "mem://doc",
        fontUrl: "/fonts/NotoSansSC-Regular.ttf",
        pages: [1, 2, 3],
        annotations,
        notes: [],
        includeAnnotations: false,
      },
      hooks(src),
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(2).getSize()).toEqual({ width: 600, height: 800 });
  });

  it("keeps the appendix on the document's first-page size for a last-page range", async () => {
    const src = await sourcePDF();
    const out = await generatePrintPDF(
      {
        url: "mem://doc",
        fontUrl: "/fonts/NotoSansSC-Regular.ttf",
        pages: [3],
        annotations,
        notes: [{ id: "n3", page: 3, number: 1, text: "第三页的便签" }],
        includeAnnotations: true,
      },
      hooks(src),
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
  });

  it("reports a readable error when the font cannot be fetched", async () => {
    const src = await sourcePDF();
    await expect(
      generatePrintPDF(
        {
          url: "mem://doc",
          fontUrl: "/fonts/missing.ttf",
          pages: [1],
          annotations,
          notes: [{ id: "n1", page: 1, number: 1, text: "便签" }],
          includeAnnotations: true,
        },
        {
          fetch: async (input) => {
            if (String(input).includes("font")) return new Response("", { status: 404 });
            return new Response(src as unknown as BodyInit);
          },
          onProgress: () => undefined,
        },
      ),
    ).rejects.toThrow(/字体/);
  });
});
