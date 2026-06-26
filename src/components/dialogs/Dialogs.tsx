import * as React from "react";
import { Keyboard, Pause, Play, Settings2, Film } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button, Kbd } from "../ui/controls";
import { store, useStore } from "../../store/store";
import { ExportDialog } from "./ExportDialog";
import { SilenceDialog } from "./SilenceDialog";
import { ProjectSettingsForm } from "../Inspector/ProjectSettingsForm";
import { fileUrl } from "../../lib/backend";
import { timecode, seconds } from "../../lib/format";
import { MIN_CLIP } from "../../lib/timeline";
import type { Id } from "../../lib/types";

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "export":
      return <ExportDialog />;
    case "settings":
      return <SettingsDialog />;
    case "shortcuts":
      return <ShortcutsDialog />;
    case "silence":
      return <SilenceDialog clipId={dialog.clipId} />;
    case "source":
      return <SourceDialog mediaId={dialog.mediaId} />;
  }
}

const close = () => store().openDialog(null);

function SettingsDialog() {
  return (
    <Modal title="Project settings" icon={<Settings2 className="h-4 w-4" />} onClose={close} width={460} footer={<Button onClick={close}>Done</Button>}>
      <ProjectSettingsForm />
      <p className="mt-3 text-2xs leading-relaxed text-ink-dim">
        Clips keep their framing relative to the frame when you change its size. Export can still scale the result to any resolution.
      </p>
    </Modal>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Playback",
    [
      ["Space", "Play / pause"],
      ["J / K / L", "Reverse · stop · forward (press again for faster)"],
      ["← / →", "Step one frame (Shift: one second)"],
      ["↑ / ↓", "Previous / next edit point"],
      ["Home / End", "Go to start / end"],
    ],
  ],
  [
    "Editing",
    [
      ["S  or  ⌘B", "Split at playhead"],
      ["⌫ / Del", "Delete selection"],
      ["⇧⌫", "Ripple delete (close the gap)"],
      ["⌘C / ⌘X / ⌘V", "Copy / cut / paste at playhead"],
      ["⌘D", "Duplicate"],
      ["⌘A", "Select all"],
      ["⏎ / ⇧⏎", "Add / insert selected library item at playhead"],
      ["Alt-drag", "Duplicate while dragging"],
      ["Shift-drag", "Move without snapping"],
    ],
  ],
  [
    "Tools & view",
    [
      ["V / B", "Select / blade tool"],
      ["N", "Toggle snapping"],
      ["M", "Add marker"],
      ["I / O", "Set range in / out"],
      ["⌥X", "Clear range"],
      ["+ / −", "Zoom timeline"],
      ["⇧Z", "Zoom to fit"],
      ["⌘ + scroll", "Zoom around the pointer"],
    ],
  ],
  [
    "Project",
    [
      ["⌘N / ⌘O", "New / open project"],
      ["⌘S / ⇧⌘S", "Save / save as"],
      ["⌘I", "Import media"],
      ["⌘E", "Export"],
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
      ["?", "This list"],
    ],
  ],
];

function ShortcutsDialog() {
  const isMac = /Mac/i.test(navigator.platform);
  const fix = (k: string) => (isMac ? k : k.replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+"));
  return (
    <Modal title="Keyboard shortcuts" icon={<Keyboard className="h-4 w-4" />} onClose={close} width={720}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {SHORTCUTS.map(([group, items]) => (
          <div key={group}>
            <h3 className="panel-title mb-2">{group}</h3>
            <div className="space-y-1">
              {items.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink-muted">{d}</span>
                  <Kbd>{fix(k)}</Kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Preview a library item and choose the part to put on the timeline. */
function SourceDialog({ mediaId }: { mediaId: Id }) {
  const media = useStore((s) => s.project.media.find((m) => m.id === mediaId));
  const rt = useStore((s) => s.runtime[mediaId]);
  const fps = useStore((s) => s.project.settings.fps);
  const el = React.useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [time, setTime] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [mark, setMark] = React.useState<{ in: number; out: number } | null>(null);

  const dur = media?.duration ?? 0;
  const range = mark ?? { in: 0, out: dur };
  const src = !media ? null : rt?.missing ? null : rt?.needsProxy ? (rt.proxy ? fileUrl(rt.proxy) : null) : fileUrl(media.path);

  React.useEffect(() => {
    const v = el.current;
    if (!v) return;
    let raf = 0;
    const loop = () => {
      setTime(v.currentTime);
      if (mark && !v.paused && v.currentTime >= mark.out) {
        v.pause();
        v.currentTime = mark.out;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [mark, src]);

  const toggle = () => {
    const v = el.current;
    if (!v) return;
    if (v.paused) {
      if (mark && (v.currentTime >= mark.out - 0.02 || v.currentTime < mark.in)) v.currentTime = mark.in;
      v.play().catch(() => {});
    } else v.pause();
  };
  const seek = (t: number) => {
    const v = el.current;
    if (v) v.currentTime = Math.max(0, Math.min(dur, t));
  };
  const setIn = () => setMark({ in: Math.min(time, range.out - MIN_CLIP), out: range.out });
  const setOut = () => setMark({ in: range.in, out: Math.max(time, range.in + MIN_CLIP) });
  const place = (mode: "overwrite" | "insert") => {
    store().placeMedia(mediaId, { mode, range: mark && media?.kind !== "image" ? mark : undefined });
    close();
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      const handled = [" ", "i", "o", "arrowleft", "arrowright", "enter"].includes(k);
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === " ") toggle();
      if (k === "i") setIn();
      if (k === "o") setOut();
      if (k === "arrowleft") seek(time - (e.shiftKey ? 1 : 1 / fps));
      if (k === "arrowright") seek(time + (e.shiftKey ? 1 : 1 / fps));
      if (k === "enter") place(e.shiftKey ? "insert" : "overwrite");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!media) return null;
  const isImage = media.kind === "image";
  const pct = (t: number) => `${(t / (dur || 1)) * 100}%`;

  return (
    <Modal
      title={media.name}
      subtitle="Source preview — mark a range with I and O, then add it to the timeline"
      icon={<Film className="h-4 w-4" />}
      onClose={close}
      width={760}
      footer={
        <>
          {!isImage && <span className="mr-auto font-mono text-xs text-ink-dim tabular">Selection {seconds(range.out - range.in)}</span>}
          <Button variant="ghost" onClick={() => place("insert")} title="Insert (shifts later clips right) · ⇧⏎">
            Insert
          </Button>
          <Button variant="primary" onClick={() => place("overwrite")} title="Overwrite at playhead · ⏎">
            Add to timeline
          </Button>
        </>
      }
    >
      <div className="overflow-hidden rounded-lg bg-black">
        {isImage ? (
          <img src={fileUrl(media.path)} alt="" className="mx-auto max-h-[56vh] object-contain" />
        ) : src ? (
          media.hasVideo ? (
            <video ref={el} src={src} className="mx-auto max-h-[56vh] w-full" onClick={toggle} />
          ) : (
            <div className="flex h-40 items-center justify-center text-ink-dim">
              <audio ref={el} src={src} />
              <span className="text-sm">Audio preview</span>
            </div>
          )
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-ink-dim">{rt?.missing ? "File is offline." : "Preparing preview…"}</div>
        )}
      </div>
      {!isImage && (
        <div className="mt-3 flex items-center gap-3">
          <button onClick={toggle} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-bg">
            {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}
          </button>
          <div
            className="relative h-8 flex-1 cursor-pointer"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const go = (x: number) => seek(((x - r.left) / r.width) * dur);
              go(e.clientX);
              const move = (ev: PointerEvent) => go(ev.clientX);
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          >
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-bg" />
            <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/70" style={{ left: pct(range.in), width: pct(range.out - range.in) }} />
            <div className="absolute top-1 h-6 w-0.5 -translate-x-1/2 bg-playhead" style={{ left: pct(time) }} />
          </div>
          <span className="w-[86px] shrink-0 text-right font-mono text-xs text-ink tabular">{timecode(time, fps)}</span>
          <Button size="sm" onClick={setIn} title="Mark in (I)">
            In
          </Button>
          <Button size="sm" onClick={setOut} title="Mark out (O)">
            Out
          </Button>
        </div>
      )}
    </Modal>
  );
}
