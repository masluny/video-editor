import { backend, isTauri } from "./backend";

/** Forward uncaught webview errors to the terminal (the webview console isn't always reachable). */
export function installErrorReporting() {
  if (!isTauri()) return;
  window.addEventListener("error", (e) => backend.log("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => backend.log("error", `unhandled rejection: ${String(e.reason?.stack ?? e.reason)}`));
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    backend.log("console.error", args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : safeJson(a))).join(" "));
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
