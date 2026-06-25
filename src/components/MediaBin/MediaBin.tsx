import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import { cn } from "../../lib/cn";
import { Plus, FileVideo, FileAudio, Search, Scissors, Upload, Library } from "lucide-react";
import { importMedia, openMediaFiles, extractPathsFromDropEvent, assetUrl } from "../../lib/tauri";
import type { MediaAsset } from "../../lib/types";

export function MediaBin() {
  const { project, addMedia, startClipping, removeMedia, pushHistory, pushToast } = useProjectStore();
  const thumbs = useProjectStore((s) => s.thumbs);
  const [search, setSearch] = React.useState("");
  const [isHovering, setIsHovering] = React.useState(false);
  const [menu, setMenu] = React.useState<{ x: number; y: number; asset: MediaAsset } | null>(null);

  const filtered = project.media.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));

  const ingest = async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const assets = await importMedia(paths);
      if (assets && assets.length > 0) {
        addMedia(assets);
        pushHistory();
      } else {
        pushToast("Couldn't read that media file.", "error");
      }
    } catch (err: any) {
      console.error("[MediaBin] import failed:", err);
      pushToast("Import failed: " + (err?.message || String(err)), "error");
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the window-level drop handler import it twice
    setIsHovering(false);
    let paths = extractPathsFromDropEvent(e);
    if (paths.length === 0 && e.dataTransfer?.files?.length) {
      paths = Array.from(e.dataTransfer.files)
        .map((f: any) => f?.path)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
    }
    await ingest(paths);
  };

  const handleImportClick = async () => {
    const paths = await openMediaFiles();
    if (paths && paths.length) await ingest(paths);
  };

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  return (
    <div
      className={cn(
        "workspace-panel flex flex-col h-full relative",
        isHovering && "ring-2 ring-accent ring-inset"
      )}
      onDragOver={(e) => { e.preventDefault(); setIsHovering(true); }}
      onDragLeave={() => setIsHovering(false)}
      onDrop={handleDrop}
    >
      <div className="panel-header justify-between">
        <div className="flex items-center gap-2">
          <Library className="w-3.5 h-3.5 text-accent" />
          <span>Library</span>
        </div>
        <button className="btn-icon w-8 h-8 text-accent hover:bg-accent/10" onClick={handleImportClick} title="Import media">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim" />
          <input
            type="text"
            placeholder="Search media…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input w-full pl-9 text-xs h-9"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {filtered.length === 0 ? (
          <button
            onClick={handleImportClick}
            className="w-full mt-1 flex flex-col items-center justify-center gap-3 py-12 rounded-lg border border-dashed border-border-hover text-text-muted hover:border-accent/80 hover:text-text hover:bg-accent/5 transition-colors"
          >
            <div className="w-12 h-12 rounded-lg bg-accent/12 border border-accent/25 text-accent flex items-center justify-center">
              <Upload className="w-5 h-5" />
            </div>
            <span className="text-sm font-semibold text-text">Import media</span>
            <span className="text-xs max-w-[170px] leading-relaxed">Drop video or audio here, or click to browse.</span>
          </button>
        ) : (
          filtered.map((asset) => (
            <MediaItem
              key={asset.id}
              asset={asset}
              frames={thumbs[asset.id] || []}
              onClip={() => startClipping(asset.id)}
              onMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, asset });
              }}
            />
          ))
        )}
      </div>

      {menu && (
        <div
          className="fixed z-[80] min-w-44 rounded-lg border border-border bg-surface shadow-panel py-1 text-xs"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="w-full px-3 py-2 text-left hover:bg-surface-hover" onClick={() => { startClipping(menu.asset.id); setMenu(null); }}>
            Clip...
          </button>
          <button
            className="w-full px-3 py-2 text-left hover:bg-surface-hover"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(menu.asset.path);
                pushToast("Media path copied.", "info");
              } catch {
                pushToast("Couldn't copy path.", "error");
              }
              setMenu(null);
            }}
          >
            Copy path
          </button>
          <div className="h-px bg-border my-1" />
          <button
            className="w-full px-3 py-2 text-left text-danger hover:bg-danger/10"
            onClick={() => {
              removeMedia(menu.asset.id);
              pushHistory();
              setMenu(null);
            }}
          >
            Delete from project
          </button>
        </div>
      )}
    </div>
  );
}

function MediaItem({
  asset,
  frames,
  onClip,
  onMenu,
}: {
  asset: MediaAsset;
  frames: string[];
  onClip: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const isVideo = asset.hasVideo;
  const [skim, setSkim] = React.useState(0);
  // FCP-style skimming: hover across the thumbnail to scrub through its frames.
  const onMove = (e: React.MouseEvent) => {
    if (frames.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / rect.width));
    setSkim(Math.floor(frac * frames.length));
  };
  const poster = frames[Math.min(skim, frames.length - 1)];
  return (
    <div
      className="group relative rounded-lg overflow-hidden bg-bg-secondary/80 border border-border hover:border-border-hover hover:bg-bg-tertiary transition-colors cursor-pointer shadow-inset"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-revind-media", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onClip}
      onContextMenu={onMenu}
      onMouseMove={onMove}
      onMouseLeave={() => setSkim(0)}
      title="Hover to skim · click to clip · drag to a track"
    >
      <div className="relative aspect-video bg-black/40 flex items-center justify-center">
        {poster ? (
          <img src={assetUrl(poster)} alt={asset.name} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className={cn("flex items-center justify-center", isVideo ? "text-clip-video/70" : "text-clip-audio/70")}>
            {isVideo ? <FileVideo className="w-8 h-8" /> : <FileAudio className="w-8 h-8" />}
          </div>
        )}

        {/* duration badge */}
        <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/75 text-white text-[9px] font-mono">
          {fmt(asset.durationSec)}
        </span>

        {/* hover Clip CTA */}
        <div className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-white text-xs font-semibold shadow">
            <Scissors className="w-3.5 h-3.5" /> Clip
          </span>
        </div>
      </div>

      <div className="px-2.5 py-2 flex items-center gap-2">
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", isVideo ? "bg-clip-video" : "bg-clip-audio")} />
        <span className="text-xs font-medium text-text truncate" title={asset.name}>{asset.name}</span>
      </div>
    </div>
  );
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}
