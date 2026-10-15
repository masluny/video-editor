/** HH:MM:SS:FF (drops the hour when zero unless `full`). */
export function timecode(sec: number, fps: number, full = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const rate = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.round(sec * (fps || 30));
  const f = totalFrames % rate;
  const s = Math.floor(totalFrames / rate);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return full || h > 0 ? `${p(h)}:${p(m)}:${p(ss)}:${p(f)}` : `${p(m)}:${p(ss)}:${p(f)}`;
}

/** Human duration: 0:42, 3:07, 1:02:03. */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

/** Precise seconds for readouts: 3.25s, 1:04.50 */
export function seconds(sec: number): string {
  if (!Number.isFinite(sec)) return "0.00s";
  if (Math.abs(sec) < 60) return `${sec.toFixed(2)}s`;
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function bytes(n?: number): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fpsLabel(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, "");
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** A shortcut written with Mac symbols, spelled out on other platforms (⌘ → Ctrl+). */
export function keyLabel(keys: string): string {
  return isMac ? keys : keys.replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+");
}
