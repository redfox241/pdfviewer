import { friendlyPrintError, generatePrintPDF, type PrintPDFJob, type PrintPhase } from "./printpdf";

export type WorkerJob = PrintPDFJob & { type: "generate" };

export type WorkerMessage =
  | { type: "progress"; done: number; total: number; phase: PrintPhase }
  | { type: "done"; data: Uint8Array }
  | { type: "error"; message: string };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: WorkerMessage, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event) => {
  const job = event.data;
  if (job?.type !== "generate") return;
  void generate(job);
};

function post(message: WorkerMessage, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

async function generate(job: WorkerJob): Promise<void> {
  try {
    const bytes = await generatePrintPDF(job, {
      fetch: (input, init) => fetch(input, init),
      onProgress: (done, total, phase) => post({ type: "progress", done, total, phase }),
    });
    post({ type: "done", data: bytes }, [bytes.buffer]);
  } catch (e) {
    post({ type: "error", message: friendlyPrintError(e) });
  }
}
