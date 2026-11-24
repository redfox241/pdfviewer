import { describe, expect, it } from "vitest";
import { caretOffset, expandWord, nearestSegment, type CharSegment } from "./textselection";

function run(text: string, width = 10, top = 0, height = 10): CharSegment[] {
  return [...text].map((_, i) => ({
    start: i,
    end: i + 1,
    left: i * width,
    top,
    right: (i + 1) * width,
    bottom: top + height,
  }));
}

describe("caretOffset", () => {
  const segments = run("abcd");

  it("snaps to the nearest glyph boundary", () => {
    expect(caretOffset(segments, 4, 13, 5, true, false, "nearest")).toBe(1);
    expect(caretOffset(segments, 4, 17, 5, true, false, "nearest")).toBe(2);
  });

  it("includes the hovered glyph when biased", () => {
    expect(caretOffset(segments, 4, 12, 5, true, false, "end")).toBe(2);
    expect(caretOffset(segments, 4, 18, 5, true, false, "start")).toBe(1);
  });

  it("stops at the run edges instead of the neighbouring line", () => {
    expect(caretOffset(segments, 4, -40, 5, true, false, "nearest")).toBe(0);
    expect(caretOffset(segments, 4, 400, 5, true, false, "nearest")).toBe(4);
    expect(caretOffset(segments, 4, 400, 5, true, false, "start")).toBe(4);
  });

  it("handles right-to-left runs", () => {
    const rtl = [..."abcd"].map((_, i) => ({
      start: i,
      end: i + 1,
      left: 70 - i * 10,
      top: 0,
      right: 80 - i * 10,
      bottom: 10,
    }));
    expect(caretOffset(rtl, 4, 75, 5, true, true, "nearest")).toBe(0);
    expect(caretOffset(rtl, 4, 79, 5, true, true, "nearest")).toBe(0);
    expect(caretOffset(rtl, 4, 45, 5, true, true, "nearest")).toBe(3);
    expect(caretOffset(rtl, 4, 58, 5, true, true, "nearest")).toBe(2);
    expect(caretOffset(rtl, 4, -40, 5, true, true, "nearest")).toBe(4);
  });

  it("handles vertical runs", () => {
    const vertical = [..."ab"].map((_, i) => ({
      start: i,
      end: i + 1,
      left: 0,
      top: i * 12,
      right: 10,
      bottom: (i + 1) * 12,
    }));
    expect(caretOffset(vertical, 2, 5, 2, false, false, "nearest")).toBe(0);
    expect(caretOffset(vertical, 2, 5, 20, false, false, "nearest")).toBe(2);
    expect(caretOffset(vertical, 2, 5, 14, false, false, "nearest")).toBe(1);
    expect(caretOffset(vertical, 2, 5, 100, false, false, "end")).toBe(2);
  });
});

describe("nearestSegment", () => {
  it("prefers the closest box", () => {
    const segments = run("abc");
    expect(nearestSegment(segments, 25, 5)).toBe(2);
    expect(nearestSegment(segments, 5, -20)).toBe(0);
  });
});

describe("expandWord", () => {
  it("expands Latin words", () => {
    expect(expandWord("hello world", 7)).toEqual({ start: 6, end: 11 });
    expect(expandWord("hello world", 2)).toEqual({ start: 0, end: 5 });
  });

  it("takes the preceding word when the caret sits on a space", () => {
    expect(expandWord("hello world", 5)).toEqual({ start: 0, end: 5 });
  });

  it("keeps apostrophes and hyphens inside the word", () => {
    expect(expandWord("don't stop", 2)).toEqual({ start: 0, end: 5 });
    expect(expandWord("co-operate", 5)).toEqual({ start: 0, end: 10 });
  });

  it("selects a single CJK character", () => {
    expect(expandWord("你好世界", 1)).toEqual({ start: 1, end: 2 });
    expect(expandWord("你好世界", 3)).toEqual({ start: 3, end: 4 });
  });

  it("handles the end of the text", () => {
    expect(expandWord("hello", 5)).toEqual({ start: 0, end: 5 });
    expect(expandWord("", 0)).toEqual({ start: 0, end: 0 });
  });
});
