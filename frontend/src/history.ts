export interface Command {
  do: () => void;
  undo: () => void;
}

/** Linear undo/redo stack. Commands are executed when pushed. */
export class History {
  private past: Command[] = [];
  private future: Command[] = [];
  private limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  push(cmd: Command): void {
    cmd.do();
    this.past.push(cmd);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(): boolean {
    const cmd = this.past.pop();
    if (!cmd) return false;
    cmd.undo();
    this.future.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.future.pop();
    if (!cmd) return false;
    cmd.do();
    this.past.push(cmd);
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
