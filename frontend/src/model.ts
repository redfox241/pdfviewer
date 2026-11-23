export type AnnType =
  | "highlight"
  | "underline"
  | "strikeout"
  | "ink"
  | "redact"
  | "box"
  | "note";

export type Tool =
  | "select"
  | "highlight"
  | "underline"
  | "strikeout"
  | "ink"
  | "redact"
  | "box"
  | "note"
  | "eraser";

export type ZoomMode = "custom" | "fit-width" | "fit-page" | "actual";

export type PluginKind = "translator" | "dictionary";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  description: string;
  author: string;
  homepage: string;
  source: string;
  license: string;
  provider: string;
  endpoint: string;
  model: string;
  targetLang: string;
  host: string;
  enabled: boolean;
  default: boolean;
  hasKey: boolean;
  requiresKey: boolean;
  hasAppId: boolean;
  requiresAppId: boolean;
  size: number;
}

export interface InstallCandidate {
  token: string;
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  existing: boolean;
  existingVersion: string;
}

export interface TranslationResult {
  text: string;
  pluginId: string;
  pluginName: string;
  model: string;
  targetLang: string;
  cached: boolean;
}

export interface DictEntry {
  pos: string;
  translation: string;
}

export interface DictResult {
  word: string;
  phonetic: string;
  lemma: string;
  entries: DictEntry[];
  found: boolean;
  pluginId: string;
  pluginName: string;
}

export interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Annotation {
  id: string;
  type: AnnType;
  page: number;
  color: string;
  opacity?: number;
  quads?: Quad[];
  paths?: Point[][];
  width?: number;
  point?: Point;
  text?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocInfo {
  token: string;
  path: string;
  name: string;
  size: number;
  fingerprint: string;
  url: string;
}

export interface SidecarLoad {
  data: string; // raw JSON
  path: string;
  portable: boolean;
  fingerprint: string;
  warning: string;
}

export interface ReadingState {
  lastPage: number;
  scrollRatio: number;
  zoom: number;
  viewMode: string;
  readPages: number[];
}

export interface Sidecar {
  schema: number;
  doc: {
    name: string;
    size: number;
    fingerprint: string;
    pages: number;
  };
  reading: ReadingState;
  annotations: Annotation[];
}

export interface Settings {
  theme: "system" | "light" | "dark";
  defaultZoom: "fit-width" | "fit-page" | "actual";
  autoRead: boolean;
  readDwellSec: number;
  highlightColor: string;
  nightMode: boolean;
  language: string;
  printIncludeAnnotations: boolean;
  printRangeMode: "all" | "current" | "custom";
  printOnlyAnnotated: boolean;
  printConfigured: boolean;
}

export interface PrintOutcome {
  mode: "dialog" | "viewer" | "exported" | "cancelled";
  path: string;
  message: string;
}

export interface RecentEntry {
  path: string;
  name: string;
  pages: number;
  progress: number;
  lastOpened: string;
}

export const COLORS = [
  { name: "黄", value: "#ffd84d" },
  { name: "绿", value: "#93d9a5" },
  { name: "蓝", value: "#93c5fd" },
  { name: "粉", value: "#f9a8c0" },
  { name: "橙", value: "#fbbf80" },
];

export function uid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function normRot(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Rotate a normalized point inside its own bounding box. */
export function rotatePoint(p: Point, deg: number): Point {
  switch (normRot(deg)) {
    case 90:
      return { x: 1 - p.y, y: p.x };
    case 180:
      return { x: 1 - p.x, y: 1 - p.y };
    case 270:
      return { x: p.y, y: 1 - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/** Axis-aligned bounding box after rotating a normalized quad. */
export function rotateQuad(q: Quad, deg: number): Quad {
  const r = normRot(deg);
  if (r === 0) return { ...q };
  const a = rotatePoint({ x: q.x, y: q.y }, r);
  const b = rotatePoint({ x: q.x + q.w, y: q.y + q.h }, r);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function unrotateQuad(q: Quad, deg: number): Quad {
  return rotateQuad(q, 360 - normRot(deg));
}

export function pointInQuad(p: Point, q: Quad): boolean {
  return p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer = 0;
  return ((...args: never[]) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

export function decodeSidecar(load: SidecarLoad): {
  reading: ReadingState | null;
  annotations: Annotation[];
  pages: number;
  fingerprint: string;
} {
  const empty = { reading: null, annotations: [], pages: 0, fingerprint: "" };
  if (!load.data) return empty;
  try {
    const doc = JSON.parse(load.data) as Sidecar;
    return {
      reading: doc.reading ?? null,
      annotations: Array.isArray(doc.annotations) ? doc.annotations : [],
      pages: doc.doc?.pages ?? 0,
      fingerprint: doc.doc?.fingerprint ?? "",
    };
  } catch {
    return empty;
  }
}
