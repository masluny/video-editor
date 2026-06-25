import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { MediaAsset, Project } from "./types";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

/**
 * Convert a filesystem path to a webview-loadable asset URL. Wrapped so a
 * missing Tauri runtime (e.g. browser preview) can never crash a render.
 */
export function assetUrl(path: string): string {
  if (!path) return "";
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export type FileDropPayload = {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
};

function normalizePath(p: string): string {
  if (!p) return p;
  let s = p.trim();

  // Remove surrounding quotes (some drag sources add them)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  // Handle file:// URLs (from uri-list or some drops)
  if (/^file:/i.test(s)) {
    try {
      const url = new URL(s);
      s = decodeURIComponent(url.pathname);
    } catch {
      s = s.replace(/^file:\/\//i, "");
    }
  }

  // On Windows, file URLs or uri-list often produce "/C:/foo/bar.mp4"
  if (/^\/[A-Za-z]:/.test(s)) {
    s = s.slice(1);
  }

  // Normalize slashes
  s = s.replace(/\\/g, "/");

  return s;
}

/**
 * Extract real filesystem paths from a browser DragEvent or React DragEvent.
 * Tauri webview drag-drop is preferred, but this is a solid fallback.
 */
export function extractPathsFromDropEvent(e: DragEvent | React.DragEvent): string[] {
  const out = new Set<string>();
  const dt = (e as any).dataTransfer as DataTransfer | null | undefined;

  if (!dt) return [];

  // 1. File objects (some sources put .path)
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      const p = (f as any)?.path;
      if (p && typeof p === "string") out.add(normalizePath(p));
    }
  }

  // 2. text/uri-list (Finder, Explorer, most file managers)
  try {
    const uriList = dt.getData("text/uri-list");
    if (uriList) {
      uriList
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .forEach((u) => out.add(normalizePath(u)));
    }
  } catch {}

  // 3. text/plain as last resort
  try {
    const plain = dt.getData("text/plain");
    if (plain) {
      plain
        .split(/\r?\n/)
        .map((l) => l.trim())
        .forEach((l) => {
          if (/^file:|^\/|^[A-Za-z]:\\/i.test(l)) out.add(normalizePath(l));
        });
    }
  } catch {}

  return Array.from(out).filter(Boolean);
}

export async function importMedia(rawPaths: string[]): Promise<MediaAsset[]> {
  const paths = (rawPaths || []).map(normalizePath).filter(Boolean);
  console.log('[tauri] importMedia called with raw:', rawPaths, 'normalized:', paths);
  if (paths.length === 0) return [];
  try {
    const res = await invoke<MediaAsset[]>("import_media", { paths });
    console.log('[tauri] importMedia result:', res);
    return res || [];
  } catch (err) {
    console.error('[tauri] importMedia INVOKE FAILED:', err, 'paths:', paths);
    // Re-throw so caller can show alert
    throw err;
  }
}

export async function getProject(): Promise<Project> {
  return invoke<Project>("get_project");
}

export async function updateProject(project: Project): Promise<void> {
  return invoke<void>("update_project", { project });
}

export async function saveProject(path: string): Promise<void> {
  return invoke<void>("save_project", { path });
}

export async function loadProject(path: string): Promise<Project> {
  return invoke<Project>("load_project", { path });
}

export async function startExport(
  outputPath: string,
  rangeIn?: number | null,
  rangeOut?: number | null
): Promise<string> {
  return invoke<string>("start_export", {
    outputPath,
    rangeIn: rangeIn ?? null,
    rangeOut: rangeOut ?? null,
  });
}

export async function startClipExport(
  mediaPath: string,
  outputPath: string,
  sourceIn: number,
  sourceOut: number
): Promise<string> {
  return invoke<string>("start_clip_export", {
    mediaPath,
    outputPath,
    sourceIn,
    sourceOut,
  });
}

/** Filmstrip thumbnails for a media file (absolute PNG paths). Best-effort. */
export async function getThumbnails(path: string, count: number, duration?: number): Promise<string[]> {
  try {
    return (await invoke<string[]>("get_media_thumbnails", { path, count, duration })) || [];
  } catch (e) {
    console.warn("[tauri] thumbnails failed:", e);
    return [];
  }
}

export async function openMediaFiles(): Promise<string[] | null> {
  // NO FILTERS AT ALL. This fixes "+ button can select mp4".
  const selected = await open({ multiple: true });
  console.log('[tauri] openMediaFiles raw result:', selected);
  if (!selected) return null;
  const list = Array.isArray(selected) ? selected : [selected as string];
  const cleaned = list.filter((x): x is string => typeof x === 'string' && x.length > 0).map(normalizePath);
  console.log('[tauri] openMediaFiles cleaned:', cleaned);
  return cleaned.length ? cleaned : null;
}

export async function openProjectFile(): Promise<string | null> {
  // NO FILTERS AT ALL. This fixes "click Open cannot select mp4 file".
  const selected = await open({ multiple: false });
  console.log('[tauri] openProjectFile raw result:', selected);
  if (!selected) return null;
  if (typeof selected === 'string') return normalizePath(selected);
  return null;
}

export async function saveProjectFile(): Promise<string | null> {
  const selected = await save({
    filters: [{ name: "Revind Project", extensions: ["vproj"] }],
    defaultPath: "project.vproj",
  });
  return selected;
}

export async function saveExportFile(): Promise<string | null> {
  const selected = await save({
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    defaultPath: "export.mp4",
  });
  return selected;
}
