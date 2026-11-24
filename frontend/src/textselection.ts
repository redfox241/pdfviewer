export interface CharSegment {
  /** Inclusive UTF-16 start offset in the text node. */
  start: number;
  /** Exclusive UTF-16 end offset. */
  end: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type CaretBias = "nearest" | "start" | "end";

interface CodePoint {
  ch: string;
  size: number;
  index: number;
}

function gap(value: number, from: number, to: number): number {
  if (value < from) return from - value;
  if (value > to) return value - to;
  return 0;
}

/** Index of the segment closest to a point (page-local coordinates). */
export function nearestSegment(segments: readonly CharSegment[], x: number, y: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const dx = gap(x, s.left, s.right);
    const dy = gap(y, s.top, s.bottom);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Resolve a page-local point to a text offset inside one text-layer span.
 *
 * `nearest` behaves like a normal caret (the closer half of a glyph wins),
 * while `start`/`end` include the hovered glyph, so a drag ends on the letter
 * under the pointer rather than one letter before it.
 */
export function caretOffset(
  segments: readonly CharSegment[],
  textLength: number,
  x: number,
  y: number,
  horizontal: boolean,
  rtl: boolean,
  bias: CaretBias,
): number {
  if (!segments.length) return bias === "end" ? textLength : 0;
  const axisStart = (s: CharSegment): number => (horizontal ? s.left : s.top);
  const axisEnd = (s: CharSegment): number => (horizontal ? s.right : s.bottom);
  let min = Infinity;
  let max = -Infinity;
  for (const s of segments) {
    const a = axisStart(s);
    const b = axisEnd(s);
    if (a < min) min = a;
    if (b > max) max = b;
  }
  const pos = horizontal ? x : y;
  // Beyond the run: snap to its edge. Dragging past the end of a line must not
  // reach into the neighbouring line.
  if (pos < min) return horizontal && rtl ? textLength : 0;
  if (pos > max) return horizontal && rtl ? 0 : textLength;

  const seg = segments[nearestSegment(segments, x, y)]!;
  if (bias === "start") return seg.start;
  if (bias === "end") return seg.end;
  const size = horizontal ? seg.right - seg.left : seg.bottom - seg.top;
  const frac = size > 0 ? (pos - axisStart(seg)) / size : 0.5;
  const beforeMiddle = frac < 0.5;
  if (horizontal && rtl) return beforeMiddle ? seg.end : seg.start;
  return beforeMiddle ? seg.start : seg.end;
}

const CJK = /[\u3005\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const WORD = /[\p{L}\p{N}_'’\-]/u;

function codePointAt(text: string, index: number): CodePoint | null {
  if (index < 0 || index >= text.length) return null;
  const cp = text.codePointAt(index);
  if (cp === undefined) return null;
  return { ch: String.fromCodePoint(cp), size: cp > 0xffff ? 2 : 1, index };
}

function codePointBefore(text: string, index: number): CodePoint | null {
  if (index <= 0) return null;
  const low = text.charCodeAt(index - 1);
  let start = index - 1;
  if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
    const high = text.charCodeAt(start - 1);
    if (high >= 0xd800 && high <= 0xdbff) start -= 1;
  }
  return codePointAt(text, start);
}

function isWordish(ch: string): boolean {
  return CJK.test(ch) || WORD.test(ch);
}

/** Expand a caret to the word around it, or to a single CJK character. */
export function expandWord(text: string, offset: number): { start: number; end: number } {
  const len = text.length;
  if (!len) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(offset, len));
  // A caret on a boundary belongs to the character on its left, matching the
  // usual double-click behaviour on the trailing half of a word.
  let point =
    clamped >= len ? codePointBefore(text, len) : codePointAt(text, clamped);
  if (!point) return { start: 0, end: 0 };
  if (clamped > 0 && !isWordish(point.ch)) {
    const left = codePointBefore(text, clamped);
    if (left && isWordish(left.ch)) point = left;
  }
  if (CJK.test(point.ch)) return { start: point.index, end: point.index + point.size };
  if (!WORD.test(point.ch)) return { start: point.index, end: point.index + point.size };

  let start = point.index;
  let end = point.index + point.size;
  for (;;) {
    const prev = codePointBefore(text, start);
    if (!prev || !WORD.test(prev.ch) || CJK.test(prev.ch)) break;
    start = prev.index;
  }
  for (;;) {
    const next = codePointAt(text, end);
    if (!next || !WORD.test(next.ch) || CJK.test(next.ch)) break;
    end = next.index + next.size;
  }
  return { start, end };
}
