// Thin, typed wrappers around the Rust commands and Tauri plugins.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MediaAsset, Project } from "./types";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function fileUrl(path: string): string {
  if (!path) return "";
  if (/^(blob:|data:|https?:)/.test(path)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export interface ProbeOutcome {
  path: string;
  info?: Omit<MediaAsset, "id"> | null;
  error?: string | null;
}

export interface FfmpegStatus {
  ok: boolean;
  ffmpeg?: string;
  ffprobe?: string;
  encoders: string[];
  error?: string;
}

export interface Waveform {
  rate: number;
  peaks: number[];
}

export type ExportFormat = "mp4" | "mov" | "webm" | "gif" | "png" | "mp3" | "wav" | "m4a";
export type ExportCodec = "h264" | "hevc" | "prores" | "vp9";
export type ExportQuality = "high" | "medium" | "low";

export interface ExportSettings {
  format: ExportFormat;
  codec: ExportCodec;
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  hardware: boolean;
  audioBitrate: number;
  normalizeAudio: boolean;
}

export interface ExportProgressEvent {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  speed?: number;
  fps?: number;
  eta?: number;
  error?: string;
  output?: string;
  elapsed?: number;
}

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("This action needs the Revind desktop app."));
  return invoke<T>(cmd, args);
}

export const backend = {
  ffmpegStatus: () => call<FfmpegStatus>("ffmpeg_status"),
  probe: (paths: string[]) => call<ProbeOutcome[]>("probe_media", { paths }),
  thumbnails: (path: string, duration: number, count: number, height: number) =>
    call<string[]>("media_thumbnails", { path, duration, count, height }),
  waveform: (path: string, duration: number) => call<Waveform>("media_waveform", { path, duration }),
  proxy: (path: string, duration: number, hasVideo: boolean) => call<string>("media_proxy", { path, duration, hasVideo }),
  detectSilence: (path: string, from: number, to: number, noiseDb: number, minSilence: number) =>
    call<[number, number][]>("detect_silence", { path, from, to, noiseDb, minSilence }),
  exportStart: (request: {
    project: Project;
    output: string;
    settings: ExportSettings;
    range?: [number, number] | null;
    titles: Record<string, string>;
  }) => call<string>("export_start", { request }),
  exportCancel: (jobId: string) => call<void>("export_cancel", { jobId }),
  readText: (path: string) => call<string>("read_text_file", { path }),
  writeText: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
  pathsExist: (paths: string[]) => call<boolean[]>("paths_exist", { paths }),
  autosaveWrite: (contents: string) => call<void>("autosave_write", { contents }),
  autosaveRead: () => call<{ contents: string; modified: number } | null>("autosave_read"),
  autosaveClear: () => call<void>("autosave_clear"),
  log: (level: string, message: string) => call<void>("log_frontend", { level, message }).catch(() => {}),
};

export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  listen<T>(name, (e) => handler(e.payload))
    .then((fn) => (disposed ? fn() : (unlisten = fn)))
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// --- dialogs ---------------------------------------------------------------

export async function pickMedia(): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  // No extension filter: platform type filters reject perfectly good files
  // (e.g. upper-case extensions on macOS). Non-media files are reported by the probe.
  const res = await open({ multiple: true, title: "Import media" });
  if (!res) return [];
  return (Array.isArray(res) ? res : [res]).filter((p): p is string => typeof p === "string");
}

export async function pickProjectToOpen(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, title: "Open project", filters: [{ name: "Revind project", extensions: ["vproj", "json"] }] });
  return typeof res === "string" ? res : null;
}

export async function pickSavePath(title: string, defaultName: string, filterName: string, extensions: string[]): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const res = await save({ title, defaultPath: defaultName, filters: [{ name: filterName, extensions }] });
  return res ?? null;
}

export async function confirmDialog(message: string, title = "Revind", okLabel = "OK", cancelLabel = "Cancel"): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title, kind: "warning", okLabel, cancelLabel });
}

export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function openPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) {
    document.title = title;
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    document.title = title;
  }
}
