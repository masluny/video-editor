import * as React from "react";
import { FileDown } from "lucide-react";
import { TopBar } from "./components/TopBar";
import { Library } from "./components/Library/Library";
import { Viewer } from "./components/Viewer/Viewer";
import { Inspector } from "./components/Inspector/Inspector";
import { Timeline } from "./components/Timeline/Timeline";
import { DialogHost } from "./components/dialogs/Dialogs";
import { MenuHost } from "./components/ui/Menu";
import { Toaster } from "./components/ui/Toaster";
import { useMediaPipeline } from "./hooks/useMediaPipeline";
import { useShortcuts } from "./hooks/useShortcuts";
import { isDirty, store, useStore } from "./store/store";
import { useDrag } from "./store/drag";
import { backend, confirmDialog, isTauri, setWindowTitle } from "./lib/backend";
import { checkRecovery, importFiles } from "./lib/actions";
import { laneAt, overViewer, snap } from "./components/Timeline/geometry";
import { useLocal } from "./lib/useLocal";
import { firstLine } from "./components/dialogs/exportJob";

export default function App() {
  useMediaPipeline();
  useShortcuts();
  useStartup();
  useAutosave();
  useWindowTitle();
  useCloseGuard();
  useFileDrop();

  const [timelineH, setTimelineH] = useLocal("revind.timelineHeight", 0.42);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const main = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = (main.bottom - ev.clientY) / main.height;
      setTimelineH(Math.max(0.2, Math.min(0.75, frac)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col gap-0 p-1.5 pt-1.5">
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,300px)_minmax(0,1fr)_minmax(270px,310px)] gap-1.5">
          <Library />
          <div data-viewer className="min-w-0">
            <Viewer />
          </div>
          <Inspector />
        </div>
        <div onPointerDown={startResize} className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center" title="Drag to resize">
          <div className="h-0.5 w-10 rounded-full bg-line transition-colors group-hover:bg-accent" />
        </div>
        <div className="min-h-[160px] shrink-0" style={{ height: `${timelineH * 100}%` }}>
          <Timeline />
        </div>
      </main>
      <DragOverlay />
      <DialogHost />
      <MenuHost />
      <Toaster />
    </div>
  );
}

/** Label that follows the pointer during library drags, plus a hint for OS file drops. */
function DragOverlay() {
  const payload = useDrag((s) => s.payload);
  const x = useDrag((s) => s.x);
  const y = useDrag((s) => s.y);
  const label = useDrag((s) => s.label);
  const insert = useDrag((s) => s.insert);
  if (!payload) return null;
  if (payload.kind === "files") {
    const onTimeline = !!laneAt(x, y);
    return (
      <div className="pointer-events-none fixed inset-0 z-[80] flex items-start justify-center pt-20">
        <div className="flex items-center gap-2 rounded-full border border-accent/50 bg-panel-2/95 px-4 py-2 text-sm text-ink shadow-pop">
          <FileDown className="h-4 w-4 text-accent-ink" />
          {onTimeline ? `Drop to place ${label} here` : `Drop to import ${label}`}
        </div>
      </div>
    );
  }
  return (
    <div className="pointer-events-none fixed z-[80] max-w-[220px] truncate rounded-md border border-line-strong bg-panel-2/95 px-2 py-1 text-xs text-ink shadow-pop" style={{ left: x + 14, top: y + 10 }}>
      {label}
      {insert && <span className="ml-1.5 text-accent-ink">· insert</span>}
    </div>
  );
}

// ---------------------------------------------------------------- app hooks

function useStartup() {
  React.useEffect(() => {
    if (!isTauri()) return;
    backend
      .ffmpegStatus()
      .then((s) => {
        if (!s.ok) store().toast(`FFmpeg is unavailable, so importing and exporting won't work: ${firstLine(s.error)}`, "error");
      })
      .catch(() => {});
    checkRecovery();
  }, []);
}

function useAutosave() {
  React.useEffect(() => {
    if (!isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project === prev.project && s.savedProject === prev.savedProject) return;
      clearTimeout(timer);
      if (!isDirty(s)) return;
      timer = setTimeout(() => {
        const { project, filePath } = store();
        backend.autosaveWrite(JSON.stringify({ filePath, project })).catch(() => {});
      }, 2500);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);
}

function useWindowTitle() {
  const name = useStore((s) => s.project.name);
  const dirty = useStore(isDirty);
  React.useEffect(() => {
    setWindowTitle(`${dirty ? "• " : ""}${name} — Revind`);
  }, [name, dirty]);
}

function useCloseGuard() {
  React.useEffect(() => {
    if (!isTauri()) {
      const onBefore = (e: BeforeUnloadEvent) => {
        if (isDirty(store())) e.preventDefault();
      };
      window.addEventListener("beforeunload", onBefore);
      return () => window.removeEventListener("beforeunload", onBefore);
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win
        .onCloseRequested(async (event) => {
          const s = store();
          const hasContent = s.project.media.length > 0 || s.project.tracks.some((t) => t.clips.length);
          if (!isDirty(s) || !hasContent) {
            backend.autosaveClear().catch(() => {});
            return;
          }
          event.preventDefault();
          const ok = await confirmDialog(`“${s.project.name}” has unsaved changes. Quit without saving?`, "Unsaved changes", "Quit", "Cancel");
          if (ok) {
            await backend.autosaveClear().catch(() => {});
            await win.destroy();
          }
        })
        .then((fn) => (disposed ? fn() : (unlisten = fn)));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Files dragged in from the OS: import them, placing them where they're dropped. */
function useFileDrop() {
  React.useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          const dpr = window.devicePixelRatio || 1;
          const pos = "position" in p ? { x: p.position.x / dpr, y: p.position.y / dpr } : { x: 0, y: 0 };
          const drag = useDrag.getState();
          if (p.type === "enter") {
            const n = p.paths.length;
            drag.start({ kind: "files", count: n }, pos.x, pos.y, n === 1 ? "1 file" : `${n} files`);
          } else if (p.type === "over") {
            drag.move(pos.x, pos.y, false);
          } else if (p.type === "leave") {
            drag.end();
          } else if (p.type === "drop") {
            drag.end();
            const lane = laneAt(pos.x, pos.y);
            const place = lane
              ? { trackId: lane.trackId, at: snap(lane.time, new Set()).time }
              : overViewer(pos.x, pos.y)
                ? { at: store().playhead }
                : undefined;
            importFiles(p.paths, place);
          }
        })
        .then((fn) => (disposed ? fn() : (unlisten = fn))),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
