export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class DocumentSave<T> {
  private queue = new SerialQueue();
  private saved: string | undefined;

  constructor(private readonly write: (payload: string, value: T) => Promise<void>) {}

  seed(value: T): void {
    this.saved = JSON.stringify(value);
  }

  matches(value: T): boolean {
    return JSON.stringify(value) === this.saved;
  }

  flush(value: T): Promise<void> {
    const payload = JSON.stringify(value);
    return this.queue.run(async () => {
      if (payload === this.saved) return;
      await this.write(payload, value);
      this.saved = payload;
    });
  }
}

// Run synchronously after saving: neither the index nor the active tab can
// safely be captured before an await.
export function removeDocumentTab<T>(
  tabs: T[], tab: T, active: T | null, canActivate: (candidate: T) => boolean,
): T | null {
  const index = tabs.indexOf(tab);
  if (index < 0) return active;
  tabs.splice(index, 1);
  if (active !== tab) return active;
  return tabs.slice(index).find(canActivate) ??
    tabs.slice(0, index).reverse().find(canActivate) ?? null;
}
