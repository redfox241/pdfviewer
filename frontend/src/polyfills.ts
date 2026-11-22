/**
 * Compatibility shims for the WebViews shipped with older macOS releases.
 * pdf.js 4.x targets Safari 16.4+, which predates Promise.withResolvers and
 * the Map upsert proposal. Installing these is harmless on new engines.
 */

const promiseCtor = Promise as unknown as {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

if (typeof promiseCtor.withResolvers !== "function") {
  promiseCtor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

type UpsertMap = {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
  set(key: unknown, value: unknown): unknown;
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
  getOrInsert?: (key: unknown, value: unknown) => unknown;
};

function installMapUpsert(ctor: { prototype: object } | undefined): void {
  if (!ctor?.prototype) return;
  const proto = ctor.prototype as UpsertMap;
  if (typeof proto.getOrInsertComputed !== "function") {
    Object.defineProperty(proto, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value(key: unknown, callback: (key: unknown) => unknown) {
        if (proto.has.call(this, key)) return proto.get.call(this, key);
        const value = callback(key);
        proto.set.call(this, key, value);
        return value;
      },
    });
  }
  if (typeof proto.getOrInsert !== "function") {
    Object.defineProperty(proto, "getOrInsert", {
      configurable: true,
      writable: true,
      value(key: unknown, value: unknown) {
        if (!proto.has.call(this, key)) proto.set.call(this, key, value);
        return proto.get.call(this, key);
      },
    });
  }
}

installMapUpsert(Map);
installMapUpsert(WeakMap);

export {};
