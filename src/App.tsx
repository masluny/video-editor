import * as React from "react";
import { useProjectStore } from "./stores/projectStore";
import { MediaBin } from "./components/MediaBin/MediaBin";
import { Preview } from "./components/Preview/Preview";
import { Inspector } from "./components/Inspector/Inspector";
import { Timeline } from "./components/Timeline/Timeline";
import { ClipTrimmer } from "./components/Clip/ClipTrimmer";
import { ShortcutsHelp } from "./components/Timeline/ShortcutsHelp";
import { Toaster } from "./components/ui/Toaster";
import { Button } from "./components/ui/Button";
import { clipEnd, nextEditPoint, prevEditPoint } from "./lib/utils";
import {
  FolderOpen,
  Save,
  Share2,
  Undo2,
  Redo2,
  Film,
  Loader2,
  HelpCircle,
} from "lucide-react";
import {
  getProject,
  updateProject,
  saveProject,
  loadProject,
  startExport,
  openProjectFile,
  saveProjectFile,
  saveExportFile,
  importMedia,
  extractPathsFromDropEvent,
  getThumbnails,
  isTauriRuntime,
} from "./lib/tauri";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export default function App() {
  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    (window as any).__revindStore = useProjectStore;
  }

  const {
    project,
    setProject,
    selectClip,
    undo,
    redo,
    pushHistory,
    pushToast,
    exportRange,
  } = useProjectStore();

  const [showHelp, setShowHelp] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [exportProgress, setExportProgress] = React.useState(0);
  const [exportStatus, setExportStatus] = React.useState("");

  // Sync project state with the Tauri backend. Debounced so rapid edits
  // (e.g. dragging a clip) don't hammer the backend every frame. Save/export
  // flush the latest state explicitly before they run.
  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    const t = setTimeout(() => {
      updateProject(project).catch((err) => console.error("Sync error:", err));
    }, 250);
    return () => clearTimeout(t);
  }, [project]);

  // Read backend state on initial load
  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    getProject()
      .then((p) => {
        if (p) setProject(p);
      })
      .catch((err) => console.error("Fetch project error:", err));
  }, []);

  // Lazily fetch filmstrip thumbnails for any video media we haven't cached yet.
  React.useEffect(() => {
    const st = useProjectStore.getState();
    for (const m of project.media) {
      if (m.hasVideo && !st.thumbs[m.id]) {
        getThumbnails(m.path, 10, m.durationSec || undefined)
          .then((paths) => { if (paths.length) useProjectStore.getState().setThumbs(m.id, paths); })
          .catch(() => {});
      }
    }
  }, [project.media]);

  // Listen for background export progress updates
  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    try {
      listen<{ status: string; progress?: number; error?: string }>(
        "export-progress",
        (event) => {
          const { status, progress, error } = event.payload;
          if (status === "running") {
            setExportProgress(Math.min(100, Math.round(progress || 0)));
            setExportStatus("Processing and encoding video streams...");
          } else if (status === "completed") {
            setExportProgress(100);
            setExportStatus("Export completed successfully!");
            setTimeout(() => setIsExporting(false), 2000);
          } else if (status === "failed") {
            setExportStatus(`Export failed: ${error || "Unknown error"}`);
            setTimeout(() => setIsExporting(false), 5000);
          }
        }
      ).then((fn) => {
        if (cancelled) fn();
        else cleanup = fn;
      }).catch(() => {});
    } catch {
      // Browser preview has no Tauri event bridge.
    }
    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []);

  // Global handler for dragging real media files from OS onto the app.
  // 1. We MUST use getCurrentWebview().onDragDropEvent in Tauri 2 (gives real FS paths).
  // 2. We also need to preventDefault on dragover/dragenter at the document level,
  //    otherwise the browser/OS may reject the drop before Tauri sees the payload.
  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // Critical for external file drops: tell the platform "this webview accepts drops".
    const allow = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        try { e.dataTransfer.dropEffect = "copy"; } catch {}
      }
    };
    document.addEventListener("dragover", allow, true);
    document.addEventListener("dragenter", allow, true);

    (async () => {
      try {
        const webview = getCurrentWebview();
        const listener = await webview.onDragDropEvent(async (event) => {
          const payload = event.payload as any;

          if (payload?.type === "drop") {
            const paths: string[] = (payload?.paths || []).filter(
              (p: any): p is string => typeof p === "string" && p.length > 0
            );
            if (paths.length > 0) {
              try {
                const assets = await importMedia(paths);
                if (assets && assets.length > 0) {
                  useProjectStore.getState().addMedia(assets);
                  useProjectStore.getState().pushHistory();
                } else {
                  console.warn("[Revind] drop import produced no assets for:", paths);
                }
              } catch (e) {
                console.error("[Revind] drop import threw:", e);
              }
            }
          }
        });

        if (!cancelled) {
          unlisten = listener;
        } else {
          listener();
        }
      } catch (e) {
        console.warn("[Revind] Tauri webview drag-drop listener unavailable:", e);
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("dragover", allow, true);
      document.removeEventListener("dragenter", allow, true);
      if (unlisten) {
        try { unlisten(); } catch {}
      }
    };
  }, []);

  // Global keyboard shortcuts (Premiere-style). Reads fresh store state on each
  // keypress so the handler can be bound once.
  React.useEffect(() => {
    const bladeAtPlayhead = (st: ReturnType<typeof useProjectStore.getState>) => {
      const trackId =
        st.targetTrackId ?? st.project.tracks.find((t) => t.kind === "video")?.id ?? st.project.tracks[0]?.id;
      const track = st.project.tracks.find((t) => t.id === trackId);
      const clip = track?.clips.find((c) => st.playhead > c.timeline_start + 1e-4 && st.playhead < clipEnd(c) - 1e-4);
      if (track && clip) {
        st.splitClip(track.id, clip.id, st.playhead);
        st.pushHistory();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const st = useProjectStore.getState();
      if (st.clipping) return; // trimmer owns the keyboard

      if (e.key === "?") { e.preventDefault(); setShowHelp((v) => !v); return; }

      const meta = e.metaKey || e.ctrlKey;
      if (meta) {
        if (e.code === "KeyZ") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); }
        else if (e.code === "KeyY") { e.preventDefault(); st.redo(); }
        else if (e.code === "KeyK") { e.preventDefault(); bladeAtPlayhead(st); }
        return;
      }

      const fps = st.project.fps || 30;
      const total = () => st.project.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, clipEnd(c)), m), 0);

      switch (e.code) {
        case "Space": e.preventDefault(); st.setPlayRate(1); st.togglePlay(); break;
        case "KeyK": e.preventDefault(); st.setPlayRate(1); st.setIsPlaying(false); break;
        case "KeyL": { e.preventDefault(); st.setPlayRate(st.playRate >= 1 ? Math.min(4, st.playRate * 2) : 1); st.setIsPlaying(true); break; }
        case "KeyJ": { e.preventDefault(); st.setPlayRate(st.playRate <= -1 ? Math.max(-4, st.playRate * 2) : -1); st.setIsPlaying(true); break; }
        case "KeyV": st.setTool("select"); break;
        case "KeyB": st.setTool("razor"); break;
        case "KeyS": st.toggleSnap(); break;
        case "KeyI": e.preventDefault(); st.setExportIn(st.playhead); break;
        case "KeyO": e.preventDefault(); st.setExportOut(st.playhead); break;
        case "KeyC": {
          const tr = st.project.tracks.find((t) => t.id === st.selectedTrackId);
          const c = tr?.clips.find((cc) => cc.id === st.selectedClipId);
          if (c) st.startClipping(c.media_id);
          break;
        }
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (st.selectedClipIds.length || st.selectedClipId) { st.deleteSelected(e.shiftKey); st.pushHistory(); }
          break;
        case "ArrowLeft": e.preventDefault(); st.setPlayhead(st.playhead - (e.shiftKey ? 1 : 1 / fps)); break;
        case "ArrowRight": e.preventDefault(); st.setPlayhead(st.playhead + (e.shiftKey ? 1 : 1 / fps)); break;
        case "ArrowUp": e.preventDefault(); st.setPlayhead(prevEditPoint(st.project.tracks, st.playhead, st.targetTrackId ?? undefined)); break;
        case "ArrowDown": e.preventDefault(); st.setPlayhead(nextEditPoint(st.project.tracks, st.playhead, st.targetTrackId ?? undefined)); break;
        case "Home": e.preventDefault(); st.setPlayhead(0); break;
        case "End": e.preventDefault(); st.setPlayhead(total()); break;
        case "Escape": setShowHelp(false); st.selectClip(null, null); break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleOpenProject = async () => {
    const file = await openProjectFile();
    if (!file) return;

    // A .vproj file is a saved project; anything else is treated as a media file
    // to import, so "Open" works whether the user picks a project or a video/audio clip.
    if (/\.vproj$/i.test(file)) {
      try {
        const loaded = await loadProject(file);
        if (loaded) {
          setProject(loaded);
          selectClip(null, null);
        }
      } catch (e: any) {
        console.error("[App] failed to open project:", e);
        pushToast(`Could not open project: ${e?.message || e}`, "error");
      }
      return;
    }

    // Treat as media import.
    try {
      const assets = await importMedia([file]);
      if (assets && assets.length > 0) {
        useProjectStore.getState().addMedia(assets);
        pushHistory();
      } else {
        pushToast("Couldn't read that media file.", "error");
      }
    } catch (e: any) {
      console.error("[App] failed to import media via Open:", e);
      pushToast(`Import failed: ${e?.message || e}`, "error");
    }
  };

  const handleSaveProject = async () => {
    const file = await saveProjectFile();
    if (!file) return;
    try {
      // Flush the latest in-memory project to the backend before it writes the file.
      await updateProject(project);
      await saveProject(file);
      pushToast("Project saved.", "info");
    } catch (e: any) {
      console.error("[App] save failed:", e);
      pushToast("Save failed: " + (e?.message || e), "error");
    }
  };

  const handleExport = async () => {
    const out = await saveExportFile();
    if (!out) return;

    setIsExporting(true);
    setExportProgress(0);

    const range = useProjectStore.getState().exportRange;
    setExportStatus(
      range
        ? `Preparing export of ${(range.outPoint - range.inPoint).toFixed(1)}s selection...`
        : "Preparing render pipeline..."
    );

    try {
      // Make sure the backend has the current timeline before rendering.
      await updateProject(project);
      await startExport(
        out,
        range?.inPoint ?? null,
        range?.outPoint ?? null
      );
    } catch (e: any) {
      setExportStatus(`Failed to initiate export: ${e.message || e}`);
      setTimeout(() => setIsExporting(false), 4000);
    }
  };

  return (
    <div
      className="flex flex-col h-screen bg-bg text-text select-none overflow-hidden p-2 gap-2"
      // Accept OS file drags anywhere so Tauri's native drag-drop delivers the real paths.
      onDragOver={(e) => {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "copy"; } catch {}
      }}
      onDrop={async (e) => {
        e.preventDefault();
        // Last-chance DOM fallback using the same robust extractor
        let domPaths = extractPathsFromDropEvent(e as any);
        if (domPaths.length === 0 && e.dataTransfer?.files?.length) {
          domPaths = Array.from(e.dataTransfer.files)
            .map((f: any) => f?.path)
            .filter((p): p is string => typeof p === "string" && p.length > 0);
        }
        if (domPaths.length > 0) {
          try {
            const assets = await importMedia(domPaths);
            if (assets && assets.length > 0) {
              useProjectStore.getState().addMedia(assets);
              pushHistory();
            }
          } catch (err) {
            console.error("DOM drop import failed:", err);
          }
        }
      }}
      // Also accept drops on the window frame for maximum hit area
      onDragEnter={(e) => { try { e.preventDefault(); } catch {} }}
      onDragLeave={(e) => { try { e.preventDefault(); } catch {} }}
    >
      {/* Top bar */}
      <div className="h-14 workspace-panel px-3 flex items-center gap-2 z-10 shrink-0">
        <div className="flex items-center gap-2 pr-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent text-white shadow-glow">
            <Film className="w-4 h-4" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight text-sm text-text">Revind</div>
            <div className="text-[10px] text-text-dim">Professional editor</div>
          </div>
        </div>

        <div className="w-px h-6 bg-border/80" />

        <Button variant="ghost" size="sm" onClick={handleOpenProject} title="Open a .vproj project, or import a video/audio file">
          <FolderOpen className="w-3.5 h-3.5" /> Open
        </Button>
        <Button variant="ghost" size="sm" onClick={handleSaveProject} title="Save project (.vproj)">
          <Save className="w-3.5 h-3.5" /> Save
        </Button>

        <div className="w-px h-6 bg-border/80" />

        <Button variant="ghost" size="sm" onClick={undo} title="Undo (⌘Z)">
          <Undo2 className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={redo} title="Redo (⌘⇧Z)">
          <Redo2 className="w-3.5 h-3.5" />
        </Button>

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-secondary/70 border border-border/70 text-xs text-text-muted">
          <span>{project.media.length} media</span>
          <span className="w-1 h-1 rounded-full bg-border-hover" />
          <span>{project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips</span>
          {exportRange && (
            <>
              <span className="w-1 h-1 rounded-full bg-border-hover" />
              <span className="text-accent">{(exportRange.outPoint - exportRange.inPoint).toFixed(1)}s range</span>
            </>
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">
          <HelpCircle className="w-3.5 h-3.5" /> Help
        </Button>
        <Button variant="primary" size="sm" onClick={handleExport} title={exportRange ? "Export selection to MP4" : "Export to MP4"}>
          <Share2 className="w-3.5 h-3.5" /> {exportRange ? "Export Selection" : "Export"}
        </Button>
      </div>

      {/* Main 3-Pane Work Area */}
      <div className="flex-1 flex overflow-hidden min-h-0 gap-2">
        {/* Media Assets Bin Panel */}
        <div className="w-[280px] shrink-0 h-full">
          <MediaBin />
        </div>

        {/* Central Display Monitor */}
        <div className="flex-1 h-full min-w-0">
          <Preview />
        </div>

        {/* Selected Track / Clip Inspector */}
        <div className="w-[340px] shrink-0 h-full">
          <Inspector />
        </div>
      </div>

      {/* Bottom Timeline Control panel */}
      <div className="h-[310px] shrink-0">
        <Timeline />
      </div>

      {/* Clip Trimmer modal */}
      <ClipTrimmer />

      {/* Keyboard shortcuts overlay */}
      <ShortcutsHelp open={showHelp} onClose={() => setShowHelp(false)} />

      {/* Non-blocking notifications */}
      <Toaster />

      {/* Background Rendering / Export Dialog Modal Overlay */}
      {isExporting && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-panel border border-border p-6 rounded-lg w-[420px] shadow-panel flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-accent/12 border border-accent/20 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-accent animate-spin" />
              </div>
              <div>
                <h3 className="font-semibold text-white text-base">Exporting movie</h3>
                <p className="text-xs text-text-dim">Rendering with ffmpeg</p>
              </div>
            </div>
            <p className="text-xs text-text-muted mb-4 min-h-8">
              {exportStatus}
            </p>

            <div className="w-full bg-bg rounded-full h-2 overflow-hidden mb-2 border border-border">
              <div
                className="bg-accent h-full transition-all duration-300 rounded-full"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
            <span className="font-mono text-xs text-text font-bold text-right">
              {exportProgress}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
