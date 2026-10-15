import * as React from "react";
import {
  AlertTriangle,
  Film,
  FolderSearch,
  Image as ImageIcon,
  Loader2,
  Music,
  Plus,
  Search,
  Trash2,
  Type,
  Upload,
  Link2,
  PlayCircle,
} from "lucide-react";
import type { MediaAsset } from "../../lib/types";
import { store, useStore, type MediaRuntime } from "../../store/store";
import { beginPointerDrag } from "../../store/drag";
import { dropPayload } from "../Timeline/drop";
import { backend, fileUrl, pickMedia, revealInFolder } from "../../lib/backend";
import { importViaDialog } from "../../lib/actions";
import { reanalyze } from "../../hooks/useMediaPipeline";
import { duration as fmtDuration, stripExtension, bytes } from "../../lib/format";
import { TITLE_PRESETS, defaultTitleStyle, type TitlePreset } from "../../lib/defaults";
import { titleImageUrl } from "../../lib/title";
import { openMenu } from "../ui/Menu";
import { Button, IconButton, Segmented } from "../ui/controls";
import { cn } from "../../lib/cn";
import { useLocal } from "../../lib/useLocal";

type Tab = "media" | "titles";

export function Library() {
  const [tab, setTab] = useLocal<Tab>("revind.libraryTab", "media");
  const count = useStore((s) => s.project.media.length);
  return (
    <div className="panel flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
        <Segmented
          value={tab}
          onChange={setTab}
          className="flex-1"
          options={[
            { value: "media", label: <><Film className="h-3 w-3" /> Media{count ? <span className="text-ink-dim">{count}</span> : null}</> },
            { value: "titles", label: <><Type className="h-3 w-3" /> Titles</> },
          ]}
        />
        {tab === "media" && (
          <IconButton size="sm" title="Import media (⌘I)" onClick={importViaDialog}>
            <Plus className="h-4 w-4" />
          </IconButton>
        )}
      </div>
      {tab === "media" ? <MediaTab /> : <TitlesTab />}
    </div>
  );
}

// --------------------------------------------------------------------- media

function MediaTab() {
  const media = useStore((s) => s.project.media);
  const runtime = useStore((s) => s.runtime);
  const selected = useStore((s) => s.selectedMedia);
  const used = useStore((s) => {
    const ids = new Set<string>();
    for (const t of s.project.tracks) for (const c of t.clips) if (c.mediaId) ids.add(c.mediaId);
    return [...ids].sort().join("|");
  });
  const usedSet = React.useMemo(() => new Set(used.split("|")), [used]);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = useLocal<"all" | "video" | "audio" | "image">("revind.libraryFilter", "all");

  const shown = media.filter(
    (m) => (filter === "all" || m.kind === filter) && (!query || m.name.toLowerCase().includes(query.toLowerCase())),
  );

  if (!media.length)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] text-ink-dim">
          <Upload className="h-5 w-5" />
        </div>
        <p className="text-sm text-ink-muted">Your media appears here.</p>
        <Button variant="primary" onClick={importViaDialog}>
          Import media…
        </Button>
        <p className="text-2xs text-ink-dim">or drop files anywhere in the window</p>
      </div>
    );

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setQuery(""), (e.target as HTMLInputElement).blur())}
            placeholder="Search"
            className="field h-6 pl-6 text-xs"
          />
        </div>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "video", label: <Film className="h-3 w-3" />, title: "Video" },
            { value: "audio", label: <Music className="h-3 w-3" />, title: "Audio" },
            { value: "image", label: <ImageIcon className="h-3 w-3" />, title: "Images" },
          ]}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onPointerDown={(e) => e.target === e.currentTarget && store().setSelectedMedia(null)}
        onContextMenu={(e) => {
          const unused = media.filter((m) => !usedSet.has(m.id)).length;
          openMenu(e, [
            { label: "Import media…", onSelect: () => void importViaDialog() },
            { separator: true },
            {
              label: unused ? `Remove unused media (${unused})` : "Remove unused media",
              disabled: !unused,
              onSelect: () => {
                const n = store().removeUnusedMedia();
                store().toast(`Removed ${n} unused item${n > 1 ? "s" : ""} from the project. Files on disk are untouched.`, "success");
              },
            },
          ]);
        }}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2">
          {shown.map((m) => (
            <MediaCard key={m.id} media={m} runtime={runtime[m.id]} selected={selected === m.id} used={usedSet.has(m.id)} />
          ))}
        </div>
        {!shown.length && <p className="mt-6 text-center text-xs text-ink-dim">Nothing matches.</p>}
      </div>
    </>
  );
}

async function relink(m: MediaAsset) {
  const [path] = await pickMedia();
  if (!path) return;
  const [res] = await backend.probe([path]).catch((e) => {
    store().toast(String(e), "error");
    return [];
  });
  if (!res?.info) {
    store().toast(`Couldn't use that file: ${res?.error ?? "unsupported"}`, "error");
    return;
  }
  if (res.info.kind !== m.kind) {
    store().toast(`That file is ${res.info.kind === "audio" ? "audio" : `a ${res.info.kind}`}; the original was ${m.kind}.`, "error");
    return;
  }
  reanalyze(m);
  store().relinkMedia(m.id, res.info);
  store().toast(`Relinked “${m.name}”.`, "success");
}

function mediaMenu(m: MediaAsset, used: boolean) {
  const s = store();
  return [
    { label: "Add at playhead", shortcut: "⏎", icon: <Plus className="h-3.5 w-3.5" />, onSelect: () => s.placeMedia(m.id) },
    { label: "Insert at playhead", shortcut: "⇧⏎", onSelect: () => s.placeMedia(m.id, { mode: "insert" }) },
    { label: "Open in source viewer", icon: <PlayCircle className="h-3.5 w-3.5" />, onSelect: () => s.openDialog({ kind: "source", mediaId: m.id }) },
    { separator: true as const },
    { label: "Reveal in folder", icon: <FolderSearch className="h-3.5 w-3.5" />, onSelect: () => revealInFolder(m.path).catch((e) => s.toast(String(e), "error")) },
    { label: "Relink…", icon: <Link2 className="h-3.5 w-3.5" />, onSelect: () => relink(m) },
    { separator: true as const },
    {
      label: used ? "Remove from project (and timeline)" : "Remove from project",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      onSelect: () => s.removeMedia(m.id),
    },
  ];
}

const KIND_ICON = { video: Film, audio: Music, image: ImageIcon };

const MediaCard = React.memo(function MediaCard({ media, runtime, selected, used }: { media: MediaAsset; runtime?: MediaRuntime; selected: boolean; used: boolean }) {
  const Icon = KIND_ICON[media.kind];
  const thumbs = runtime?.thumbs;
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);
  const thumb = thumbs?.length ? thumbs[hoverIdx ?? Math.floor(thumbs.length / 3)] ?? thumbs[0] : null;
  const busy = runtime?.needsProxy && !runtime.proxy && !runtime.proxyError;

  return (
    <div
      className={cn(
        "group cursor-grab overflow-hidden rounded-lg border bg-panel-2 transition-colors",
        selected ? "border-accent ring-1 ring-accent/50" : "border-line hover:border-line-strong",
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        store().setSelectedMedia(media.id);
        beginPointerDrag(e, { kind: "media", mediaId: media.id }, stripExtension(media.name), (x, y, insert) => dropPayload({ kind: "media", mediaId: media.id }, x, y, insert));
      }}
      onDoubleClick={() => store().openDialog({ kind: "source", mediaId: media.id })}
      onContextMenu={(e) => {
        store().setSelectedMedia(media.id);
        openMenu(e, mediaMenu(media, used));
      }}
      title={`${media.name}\n${media.kind}${media.width ? ` · ${media.width}×${media.height}` : ""}${media.fps ? ` · ${+media.fps.toFixed(2)} fps` : ""}${media.size ? ` · ${bytes(media.size)}` : ""}\nDrag to the timeline · double-click to preview`}
    >
      <div
        className="relative aspect-video overflow-hidden bg-bg-deep"
        onPointerMove={(e) => {
          if (!thumbs || thumbs.length < 2) return;
          const r = e.currentTarget.getBoundingClientRect();
          setHoverIdx(Math.max(0, Math.min(thumbs.length - 1, Math.floor(((e.clientX - r.left) / r.width) * thumbs.length))));
        }}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {thumb ? (
          <img src={fileUrl(thumb)} draggable={false} alt="" className="h-full w-full object-cover" />
        ) : media.kind === "audio" ? (
          <MiniWave runtime={runtime} />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-faint">
            <Icon className="h-6 w-6" />
          </div>
        )}
        {runtime?.missing && (
          <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/70 text-2xs font-medium text-danger">
            <AlertTriangle className="h-3.5 w-3.5" /> Offline
          </div>
        )}
        {busy && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/70 px-1.5 py-0.5 text-2xs text-ink-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Preview {Math.round(runtime?.proxyProgress ?? 0)}%
          </div>
        )}
        {media.kind !== "image" && media.duration > 0 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-2xs text-white tabular">{fmtDuration(media.duration)}</span>
        )}
        {used && <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-success shadow" title="Used in the timeline" />}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <Icon className="h-3 w-3 shrink-0 text-ink-dim" />
        <span className="truncate text-xs text-ink-muted group-hover:text-ink">{media.name}</span>
      </div>
    </div>
  );
});

function MiniWave({ runtime }: { runtime?: MediaRuntime }) {
  const peaks = runtime?.waveform?.peaks;
  const bars = React.useMemo(() => {
    if (!peaks?.length) return null;
    const n = 48;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i / n) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
      let m = 0;
      for (let j = a; j < b; j++) m = Math.max(m, peaks[j]);
      out.push(m / 255);
    }
    return out;
  }, [peaks]);
  return (
    <div className="flex h-full items-center gap-[1px] bg-audio/10 px-1.5">
      {bars
        ? bars.map((v, i) => <div key={i} className="flex-1 rounded-full bg-audio/80" style={{ height: `${Math.max(4, v * 80)}%` }} />)
        : <Music className="mx-auto h-6 w-6 text-audio/60" />}
    </div>
  );
}

// -------------------------------------------------------------------- titles

function TitlesTab() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="mb-2 px-0.5 text-2xs text-ink-dim">Drag a style onto the timeline, or click to add it at the playhead. Edit text in the inspector.</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2">
        {TITLE_PRESETS.map((p) => (
          <TitleCard key={p.id} preset={p} />
        ))}
      </div>
    </div>
  );
}

function TitleCard({ preset }: { preset: TitlePreset }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const dragged = React.useRef(false);
  React.useEffect(() => {
    let live = true;
    // Preview at 1080p (the presets' reference size) on a small canvas.
    const style = { ...defaultTitleStyle(), ...preset.style };
    titleImageUrl(style, 1920, 1080).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [preset]);
  return (
    <div
      className="group cursor-grab overflow-hidden rounded-lg border border-line bg-panel-2 hover:border-line-strong"
      onPointerDown={(e) => {
        dragged.current = false;
        beginPointerDrag(e, { kind: "title", presetId: preset.id }, preset.name, (x, y, insert) => {
          dragged.current = true;
          dropPayload({ kind: "title", presetId: preset.id }, x, y, insert);
        });
      }}
      onClick={() => {
        // A plain click (no drag) adds the title at the playhead.
        if (!dragged.current) store().placeTitle(preset.style);
        dragged.current = false;
      }}
      title={`${preset.name} — click to add at the playhead, or drag to the timeline`}
    >
      <div className="relative aspect-video bg-[linear-gradient(135deg,#2b2f45,#1a1c27_60%,#2a2233)]">
        {url && <img src={url} alt="" draggable={false} className="absolute inset-0 h-full w-full" />}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <Type className="h-3 w-3 shrink-0 text-title" />
        <span className="truncate text-xs text-ink-muted group-hover:text-ink">{preset.name}</span>
      </div>
    </div>
  );
}
