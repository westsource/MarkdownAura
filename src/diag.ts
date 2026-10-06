/* Runtime diagnostics — the front end's half of the crash log (IMPL.md §13).
 *
 * Rust owns the file, the rotation and the panic hook. This module owns what only the WebView can
 * see: the user agent and GPU, the screen geometry, uncaught exceptions, rejected promises, and
 * every command failure the IPC boundary hands it. It writes nothing else: one `log_event` per line.
 *
 * Three rules shape it:
 *  - It must never take the app down. Every path swallows its own errors, and a failed `log_event`
 *    is not itself reported — that would be a loop that outlives the failure.
 *  - It must never leak a document. Messages are `Error.message` or a stringified console line,
 *    truncated to 200 characters, and `data` carries paths, numbers and enum names only (§13.9).
 *  - It must not flood. Lines are batched for 250 ms and capped at 200 per module per minute.
 *
 * `ipc.ts` cannot import this file (`diag` imports `ipc`); the reporter it installs here is the one
 * arrow from the boundary back into the log (§13.7).
 */
import {
  logEvent,
  setErrorReporter,
  setLogLevel,
  type LogEvent,
  type LogLevel,
} from "./ipc";

/** Lower ships lower: a line is written only when its level ranks at or above the current one. */
const RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

const FLUSH_MS = 250;
const WINDOW_MS = 60_000;
const LIMIT = 200;
/** The front end truncates before Rust does, so the 4 KB line cap is never approached from here. */
const MESSAGE_MAX = 200;
const MODULE_MAX = 32;

interface Queued {
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

/** The fixed window one module gets: it opens at `start`, accepts `count` lines, and remembers how
 *  many it turned away. `timer` fires at the end so the summary is emitted even if the module
 *  never logs again. */
interface Rate {
  start: number;
  count: number;
  suppressed: number;
  timer: number | undefined;
}

let installed = false;
let currentLevel: LogLevel = "info";
let queue: Queued[] = [];
let flushTimer: number | undefined;
/** One serial chain keeps lines in the order they happened, across flushes as well as within one. */
let sending: Promise<unknown> = Promise.resolve();
let forwardingConsole = false;
const rates = new Map<string, Rate>();

function enqueue(event: Queued): void {
  queue.push(event);
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, FLUSH_MS);
  }
}

/** Emits the one `suppressed=<n>` line a window is allowed, then opens a fresh window. Written when
 *  the window closes rather than when suppression starts, so the count it carries is final. */
function summarise(module: string, rate: Rate): void {
  if (rate.timer !== undefined) {
    window.clearTimeout(rate.timer);
    rate.timer = undefined;
  }
  if (rate.suppressed > 0) {
    enqueue({
      level: "warn",
      module: "diag",
      message: `suppressed=${rate.suppressed}`,
      data: { module },
    });
  }
  rate.start = Date.now();
  rate.count = 0;
  rate.suppressed = 0;
}

/** `false` means the line is dropped: the window is full and already has a pending summary. */
function allow(module: string): boolean {
  const now = Date.now();
  let rate = rates.get(module);
  if (!rate) {
    rate = { start: now, count: 0, suppressed: 0, timer: undefined };
    rates.set(module, rate);
  } else if (now - rate.start >= WINDOW_MS) {
    summarise(module, rate);
  }
  if (rate.count < LIMIT) {
    rate.count++;
    return true;
  }
  rate.suppressed++;
  if (rate.timer === undefined) {
    rate.timer = window.setTimeout(
      () => {
        const current = rates.get(module);
        if (current) summarise(module, current);
      },
      Math.max(0, rate.start + WINDOW_MS - now),
    );
  }
  return false;
}

/** The module's one entry point. A level below the current one, or `off`, is dropped here — Rust
 *  enforces the same rule again, because the level can change between queueing and delivery. */
export function log(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (currentLevel === "off" || RANK[level] > RANK[currentLevel]) return;
  const name = module.length > MODULE_MAX ? module.slice(0, MODULE_MAX) : module;
  if (!allow(name)) return;
  enqueue({
    level,
    module: name,
    message: message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message,
    data,
  });
}

/** Sends what is queued. Best-effort by design: `beforeunload` and the relaunch path cannot wait. */
export function flush(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  for (const event of batch) {
    sending = sending
      .then(() => logEvent(event.level, event.module, event.message, event.data))
      .catch(() => {
        // `call` already declined to report a failed `log_event`, so there is nothing to do but
        // move on — dropping a diagnostic line is always better than looping on it.
      });
  }
}

/** Moves both halves of the level: the front end's filter now, Rust's in-process level over IPC so
 *  the file follows without a relaunch. Failure is reported by the IPC layer, not handled here. */
export function setLevel(level: LogLevel): void {
  currentLevel = level;
  void setLogLevel(level).catch(() => {});
}

/** Never inspect an object: a console call can be handed a document or a buffer, and none of that
 *  may reach the log. Primitives and `Error.message` are the whole surface. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === null || typeof value !== "object") return String(value);
  return Object.prototype.toString.call(value);
}

/** Best-effort: a WebGL context can throw in a locked-down or software-rendered WebView, and a
 *  missing renderer is simply absent from the entry rather than a failure. */
function gpuRenderer(): string | undefined {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return undefined;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return undefined;
    const renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === "string" && renderer ? renderer : undefined;
  } catch {
    return undefined;
  }
}

/** The environment block the report scans out of the log (§13.7): the facts Rust cannot see. */
function logEnvironment(): void {
  const data: Record<string, unknown> = {
    ua: navigator.userAgent,
    tz: new Date().getTimezoneOffset(),
    screen: [window.screen.width, window.screen.height],
    dpr: window.devicePixelRatio,
    lang: navigator.language,
  };
  const gpu = gpuRenderer();
  if (gpu !== undefined) data.gpu = gpu;
  log("info", "env", "environment", data);
}

/** Idempotent; `main.ts` calls it once at module scope, before anything else can throw. */
export function install(): void {
  if (installed) return;
  installed = true;

  setErrorReporter((event: LogEvent) => log(event.level, event.module, event.message, event.data));

  window.addEventListener("error", (event) => {
    // A missing image reports an empty message; there is nothing to say about it.
    if (!event.message) return;
    log("error", "ui", event.message, {
      source: event.filename,
      line: event.lineno,
      col: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    log("error", "ui", reason instanceof Error ? reason.message : String(reason));
  });

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // A re-entrant call (our own code console.error'ing while forwarding) would duplicate lines,
      // so the guard suppresses forwarding but still lets the original write.
      if (!forwardingConsole) {
        forwardingConsole = true;
        try {
          log(level, "ui", args.map(stringify).join(" "));
        } finally {
          forwardingConsole = false;
        }
      }
      original(...args);
    };
  }

  window.addEventListener("beforeunload", () => {
    // Close every rate window first, so a module that was suppressed still gets its one summary
    // before the process goes; then send whatever is queued.
    for (const [module, rate] of rates) summarise(module, rate);
    flush();
  });

  logEnvironment();
}
