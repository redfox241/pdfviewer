import type { DocInfo, RecentEntry, Settings, SidecarLoad } from "./model";

type Binding = { [key: string]: (...args: unknown[]) => Promise<unknown> };

function bindings(): Binding {
  const w = window as unknown as { go?: { main?: { App?: Binding } } };
  const app = w.go?.main?.App;
  if (!app) throw new Error("Go 后端未就绪");
  return app;
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const fn = bindings()[method];
  if (!fn) throw new Error(`未知的接口: ${method}`);
  return (await fn(...args)) as T;
}

export const api = {
  ping: () => call<string>("Ping"),
  logError: (message: string) => call<void>("LogError", message),
  openDialog: () => call<DocInfo>("OpenDialog"),
  openDocument: (path: string) => call<DocInfo>("OpenDocument", path),
  loadSidecar: (token: string) => call<SidecarLoad>("LoadSidecar", token),
  saveSidecar: (token: string, data: string) => call<string>("SaveSidecar", token, data),
  readDocumentBase64: (token: string) => call<string>("ReadDocumentBase64", token),
  closeDocument: (token: string) => call<void>("CloseDocument", token),
  updateProgress: (token: string, pages: number, progress: number) =>
    call<void>("UpdateProgress", token, pages, progress),
  recent: () => call<RecentEntry[]>("RecentList"),
  removeRecent: (path: string) => call<void>("RemoveRecent", path),
  settings: () => call<Settings>("GetSettings"),
  saveSettings: (s: Settings) => call<void>("SaveSettings", s),
  startupDocument: () => call<string>("StartupDocument"),
  startupWarnings: () => call<string[]>("StartupWarnings"),
  platform: () => call<string>("Platform"),
  toggleMaximise: () => call<void>("ToggleMaximise"),
  configDir: () => call<string>("ConfigDir"),
  reveal: (path: string) => call<void>("RevealFile", path),
  version: () => call<string>("Version"),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e ?? "未知错误");
}
