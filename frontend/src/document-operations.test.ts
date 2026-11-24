import { describe, expect, it, vi } from "vitest";
import { DocumentSave, removeDocumentTab, SerialQueue } from "./document-operations";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("document tabs", () => {
  it("removes the correct tab when two closes finish after asynchronous work", async () => {
    const tabs = ["A", "B", "C"];
    let active: string | null = "C";
    const a = deferred();
    const b = deferred();
    const close = async (tab: string, release: Promise<void>) => {
      await release;
      active = removeDocumentTab(tabs, tab, active, () => true);
    };
    const closeA = close("A", a.promise);
    const closeB = close("B", b.promise);
    a.resolve();
    await closeA;
    b.resolve();
    await closeB;
    expect(tabs).toEqual(["C"]);
    expect(active).toBe("C");
  });

  it("preserves a different active tab and skips neighbours already closing", () => {
    const tabs = ["A", "B", "C", "D"];
    expect(removeDocumentTab(tabs, "A", "B", () => true)).toBe("B");
    expect(removeDocumentTab(tabs, "B", "B", (tab) => tab !== "C")).toBe("D");
  });
});

describe("document saves", () => {
  it("does not mark a failed save as committed, and supports retry", async () => {
    const write = vi.fn<(payload: string, value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const save = new DocumentSave(write);
    save.seed("original");
    await expect(save.flush("edited")).rejects.toThrow("database unavailable");
    expect(save.matches("original")).toBe(true);
    await save.flush("edited");
    await save.flush("edited");
    expect(save.matches("edited")).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("persists an undo that returns to the original snapshot during an in-flight save", async () => {
    const pending = deferred();
    const write = vi.fn<(payload: string, value: string) => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const save = new DocumentSave(write);
    save.seed("original");
    const edit = save.flush("edited");
    const undo = save.flush("original");
    pending.resolve();
    await Promise.all([edit, undo]);
    expect(write.mock.calls.map(([, value]) => value)).toEqual(["edited", "original"]);
    expect(save.matches("original")).toBe(true);
  });
});

it("queues new open requests while a document is loading and continues after an error", async () => {
  const queue = new SerialQueue();
  const pending = deferred();
  const opened: string[] = [];
  const first = queue.run(async () => {
    await pending.promise;
    opened.push("A");
    throw new Error("broken PDF");
  });
  const second = queue.run(async () => { opened.push("B"); });
  pending.resolve();
  await expect(first).rejects.toThrow("broken PDF");
  await second;
  expect(opened).toEqual(["A", "B"]);
});
