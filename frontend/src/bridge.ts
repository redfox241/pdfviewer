import type {
  DictResult,
  DocInfo,
  InstallCandidate,
  PluginInfo,
  PrintOutcome,
  RecentEntry,
  Settings,
  SidecarLoad,
  TranslationResult,
} from "./model";

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
  enableSaveOnQuit: () => call<void>("EnableSaveOnQuit"),
  quitAfterSave: () => call<void>("QuitAfterSave"),
  logError: (message: string) => call<void>("LogError", message),
  openDialog: () => call<DocInfo>("OpenDialog"),
  openDocument: (path: string) => call<DocInfo>("OpenDocument", path),
  loadSidecar: (token: string) => call<SidecarLoad>("LoadSidecar", token),
  saveReading: (token: string, reading: string, pages: number) =>
    call<void>("SaveReading", token, reading, pages),
  saveAnnotations: (token: string, annotations: string) =>
    call<void>("SaveAnnotations", token, annotations),
  saveSidecar: (token: string, data: string) => call<string>("SaveSidecar", token, data),
  exportSidecar: (token: string) => call<string>("ExportSidecar", token),
  importSidecar: (token: string) => call<string>("ImportSidecar", token),
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
  plugins: () => call<PluginInfo[]>("Plugins"),
  pickPlugin: () => call<InstallCandidate | null>("PickPlugin"),
  stagePlugin: (path: string) => call<InstallCandidate | null>("StagePlugin", path),
  installPlugin: (token: string) => call<PluginInfo[]>("InstallPlugin", token),
  cancelPluginInstall: (token: string) => call<void>("CancelPluginInstall", token),
  uninstallPlugin: (id: string) => call<PluginInfo[]>("UninstallPlugin", id),
  setPluginEnabled: (id: string, enabled: boolean) =>
    call<PluginInfo[]>("SetPluginEnabled", id, enabled),
  setPluginDefault: (id: string) => call<PluginInfo[]>("SetPluginDefault", id),
  setPluginKey: (id: string, key: string) => call<PluginInfo[]>("SetPluginKey", id, key),
  setPluginCredentials: (id: string, appID: string, key: string) =>
    call<PluginInfo[]>("SetPluginCredentials", id, appID, key),
  translate: (reqID: string, id: string, text: string) =>
    call<TranslationResult>("Translate", reqID, id, text),
  cancelTranslate: (reqID: string) => call<void>("CancelTranslate", reqID),
  lookupWord: (id: string, word: string) => call<DictResult>("LookupWord", id, word),
  lookupWords: (id: string, text: string) => call<DictResult[]>("LookupWords", id, text),
  openPluginsDir: () => call<void>("OpenPluginsDir"),
  saveStagedPDF: (id: string, defaultName: string) =>
    call<string>("SaveStagedPDF", id, defaultName),
  printStagedPDF: (id: string) => call<PrintOutcome>("PrintStagedPDF", id),
  discardStagedPDF: (id: string) => call<void>("DiscardStagedPDF", id),
  clearPrintCache: () => call<void>("ClearPrintCache"),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e ?? "未知错误");
}
