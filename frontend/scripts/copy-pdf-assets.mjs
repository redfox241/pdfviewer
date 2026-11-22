import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "pdfjs-dist");
const target = join(root, "public");

mkdirSync(target, { recursive: true });

for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs", "image_decoders"]) {
  const from = join(source, dir);
  const to = join(target, dir);
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) continue;
  cpSync(from, to, { recursive: true });
}

// pdf.js is loaded as a module worker. Older WKWebView builds lack
// Promise.withResolvers, so the shim must run inside the worker before the
// pdf.js worker script initialises.
const workerPolyfill = `(() => {
  const P = Promise;
  if (typeof P.withResolvers !== "function") {
    P.withResolvers = function () {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
  const install = (Ctor) => {
    if (!Ctor || !Ctor.prototype) return;
    const proto = Ctor.prototype;
    if (typeof proto.getOrInsertComputed !== "function") {
      Object.defineProperty(proto, "getOrInsertComputed", {
        configurable: true,
        writable: true,
        value(key, callback) {
          if (this.has(key)) return this.get(key);
          const value = callback(key);
          this.set(key, value);
          return value;
        },
      });
    }
    if (typeof proto.getOrInsert !== "function") {
      Object.defineProperty(proto, "getOrInsert", {
        configurable: true,
        writable: true,
        value(key, value) {
          if (!this.has(key)) this.set(key, value);
          return this.get(key);
        },
      });
    }
  };
  install(Map);
  install(WeakMap);
})();
`;

const workerSource = join(source, "build", "pdf.worker.min.mjs");
if (existsSync(workerSource)) {
  const body = readFileSync(workerSource, "utf8");
  writeFileSync(join(target, "pdf.worker.min.mjs"), workerPolyfill + body, "utf8");
}
