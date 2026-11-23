import { api, errorText } from "./bridge";
import {
  buildPrintPlan,
  exportFileName,
  type PrintOptions,
} from "./printcore";
import type { Annotation, DocInfo } from "./model";
import type { WorkerJob, WorkerMessage } from "./print.worker";

const LARGE_FILE = 100 * 1024 * 1024;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type PrintToast = (message: string, kind?: "info" | "error", action?: ToastAction) => void;

export interface PrintContext {
  doc: DocInfo;
  annotations: Annotation[];
  totalPages: number;
  currentPage: number;
  options: PrintOptions;
  toast: PrintToast;
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Progress {
  set(text: string, ratio: number): void;
  lock(): void;
  close(): void;
  onCancel(fn: () => void): void;
}

/** Entry point for the toolbar/shortcut print action. */
export async function runPrint(ctx: PrintContext): Promise<void> {
  await run("print", ctx);
}

/** Export always contains the complete document, regardless of print range. */
export async function runExport(ctx: PrintContext): Promise<void> {
  await run("export", ctx);
}

async function run(kind: "print" | "export", ctx: PrintContext): Promise<void> {
  const { doc, annotations, totalPages, currentPage, options, toast } = ctx;
  const planOptions: PrintOptions =
    kind === "print"
      ? options
      : { ...options, rangeMode: "all", rangeText: "", onlyAnnotated: false };

  const built = buildPrintPlan(totalPages, currentPage, annotations, planOptions);
  if (built.error) {
    toast(built.error, "error");
    return;
  }
  const plan = built.plan;

  if (doc.size > LARGE_FILE) {
    const ok = await confirmLarge(doc, kind);
    if (!ok) return;
  }

  let worker: Worker | null = null;
  let controller: AbortController | null = null;
  let stageId = "";
  let cancelled = false;
  let handedOff = false;
  let cancelGenerate: (() => void) | null = null;

  const ui = showProgress(kind === "print" ? "正在准备打印…" : "正在准备导出…");
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancelGenerate?.();
    worker?.terminate();
    controller?.abort();
    if (stageId) {
      void api.discardStagedPDF(stageId).catch(() => undefined);
      stageId = "";
    }
    ui.close();
  };
  ui.onCancel(cancel);

  const guard = () => {
    if (cancelled) throw new Cancelled();
  };

  try {
    ui.set("正在载入 PDF…", 0.02);
    const job: WorkerJob = {
      type: "generate",
      url: doc.url,
      fontUrl: `/fonts/NotoSansSC-Regular.ttf`,
      pages: plan.pages,
      annotations,
      notes: plan.notes,
      includeAnnotations: options.includeAnnotations,
    };
    const bytes = await generate(job, ui, (w, kill) => {
      worker = w;
      cancelGenerate = kill;
    });
    cancelGenerate = null;
    guard();

    ui.set("正在暂存打印文件…", 0.95);
    controller = new AbortController();
    stageId = await stagePDF(doc, options.includeAnnotations, bytes, controller.signal);
    controller = null;
    guard();

    if (kind === "print") {
      ui.set("正在交给系统打印…", 0.99);
      ui.lock();
      handedOff = true;
      const outcome = await api.printStagedPDF(stageId);
      const id = stageId;
      stageId = "";
      if (outcome.mode === "cancelled") {
        await api.discardStagedPDF(id).catch(() => undefined);
        return;
      }
      if (outcome.message) {
        const action: ToastAction | undefined =
          outcome.mode === "exported" && outcome.path
            ? { label: "显示文件", onClick: () => void api.reveal(outcome.path) }
            : undefined;
        toast(outcome.message, "info", action);
      }
      return;
    }

    ui.set("正在等待保存位置…", 0.99);
    ui.lock();
    handedOff = true;
    const saved = await api.saveStagedPDF(stageId, exportFileName(doc.name, options.includeAnnotations));
    const id = stageId;
    stageId = "";
    if (!saved) {
      await api.discardStagedPDF(id).catch(() => undefined);
      return;
    }
    toast(`已导出 ${saved}`, "info", { label: "显示文件", onClick: () => void api.reveal(saved) });
  } catch (e) {
    if (e instanceof Cancelled || cancelled) {
      toast("已取消");
      return;
    }
    if (stageId && !handedOff) {
      void api.discardStagedPDF(stageId).catch(() => undefined);
      stageId = "";
    }
    const detail = errorText(e);
    void api.logError(`print ${kind} failed: ${detail}`);
    toast(`${kind === "print" ? "打印" : "导出"}失败：${detail}`, "error");
  } finally {
    controller?.abort();
    (worker as Worker | null)?.terminate();
    ui.close();
  }
}

function generate(
  job: WorkerJob,
  ui: Progress,
  ready: (worker: Worker, cancel: () => void) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./print.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn();
    };
    ready(worker, () => finish(() => reject(new Cancelled())));
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        ui.set(progressText(msg), msg.total > 0 ? Math.min(0.94, msg.done / msg.total) : 0.1);
        return;
      }
      if (msg.type === "done") finish(() => resolve(msg.data));
      else finish(() => reject(new Error(msg.message)));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "打印模块启动失败")));
    };
    worker.postMessage(job);
  });
}

function progressText(msg: Extract<WorkerMessage, { type: "progress" }>): string {
  switch (msg.phase) {
    case "load":
      return "正在载入 PDF…";
    case "draw":
      return `正在叠加标注 ${Math.min(msg.done, msg.total)}/${msg.total} 页…`;
    case "appendix":
      return "正在生成便签附录…";
    case "save":
      return "正在写出 PDF…";
    default:
      return "正在准备…";
  }
}

async function stagePDF(
  doc: DocInfo,
  includeAnnotations: boolean,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch("/print/stage", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Doc-Token": doc.token,
      "X-Print-Annotations": includeAnnotations ? "1" : "0",
    },
    body: bytes as unknown as BodyInit,
    signal,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim();
    throw new Error(text.slice(0, 300) || `暂存打印文件失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("暂存打印文件失败：响应缺少 id");
  return data.id;
}

function showProgress(title: string): Progress {
  const host = document.createElement("div");
  host.className = "print-progress";
  host.innerHTML = `
    <div class="print-progress-card" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <h2>${escapeHtml(title)}</h2>
      <div class="print-progress-track"><i></i></div>
      <p class="print-progress-detail">正在准备…</p>
      <div class="print-progress-actions"><button class="modal-btn ghost" type="button">取消</button></div>
    </div>`;
  document.body.append(host);
  const bar = host.querySelector<HTMLElement>(".print-progress-track i")!;
  const detail = host.querySelector<HTMLElement>(".print-progress-detail")!;
  const button = host.querySelector<HTMLButtonElement>(".print-progress-actions button")!;
  const close = () => {
    host.remove();
  };  button.addEventListener("click", () => {
    button.disabled = true;
    detail.textContent = "正在取消…";
  });
  return {
    set(text, ratio) {
      detail.textContent = text;
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    },
    lock() {
      button.disabled = true;
      button.textContent = "已交给系统";
      detail.textContent = "等待系统对话框…";
      bar.style.width = "100%";
    },
    close() {
      close();
    },
    onCancel(fn) {
      button.addEventListener("click", fn);
    },
  };
}

function confirmLarge(doc: DocInfo, kind: "print" | "export"): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "print-progress";
    const mb = Math.round(doc.size / 1024 / 1024);
    host.innerHTML = `
      <div class="print-progress-card print-confirm" role="dialog" aria-modal="true">
        <h2>文件较大</h2>
        <p class="print-progress-detail">《${escapeHtml(doc.name)}》约 ${mb} MB。${
          kind === "print" ? "打印前" : "导出前"
        }需要把整份 PDF 载入内存，可能较慢，但不会修改原文件。</p>
        <div class="print-progress-actions">
          <button class="modal-btn ghost" data-act="cancel" type="button">取消</button>
          <button class="modal-btn primary" data-act="ok" type="button">继续${kind === "print" ? "打印" : "导出"}</button>
        </div>
      </div>`;
    document.body.append(host);
    const done = (ok: boolean) => {
      host.remove();
      resolve(ok);
    };
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')?.addEventListener("click", () => done(false));
    host.querySelector<HTMLButtonElement>('[data-act="ok"]')?.addEventListener("click", () => done(true));
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
