import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  Image as ImageIcon,
  ArrowRightToLine,
  Italic,
  Music,
  Repeat,
  RotateCcw,
  SlidersHorizontal,
  Type,
  Unlink,
  Wand2,
} from "lucide-react";
import type { Clip, ColorAdjust, MediaAsset, TitleStyle, Track } from "../../lib/types";
import type { Draft } from "immer";
import { commitSoon, findClip, store, useStore } from "../../store/store";
import { clipDuration, clipEnd, EPS, isUnbounded, MIN_CLIP, speedOf, videoEnd } from "../../lib/timeline";
import { defaultColor, defaultCrop, defaultTransform, TITLE_FONTS } from "../../lib/defaults";
import { NumberField, SliderField } from "../ui/NumberField";
import { Button, ColorInput, FieldRow, IconButton, Segmented, Select, Switch } from "../ui/controls";
import { ProjectSettingsForm } from "./ProjectSettingsForm";
import { bytes, duration as fmtDuration, fpsLabel, seconds, timecode } from "../../lib/format";
import { projectDuration } from "../../lib/timeline";
import { clipBefore, dissolveInto } from "../../lib/transitions";
import { DEFAULT_MOTION_AMOUNT, MOTION_PRESETS, motionAmount, motionPreset, type MotionPreset } from "../../lib/motion";
import { cn } from "../../lib/cn";
import { useLocal } from "../../lib/useLocal";

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const hit = selection.length === 1 ? findClip(project, selection[0]) : null;
  const media = hit?.clip.mediaId ? project.media.find((m) => m.id === hit.clip.mediaId) : undefined;

  return (
    <div className="panel flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <SlidersHorizontal className="h-3.5 w-3.5 text-ink-dim" />
        <span className="panel-title">Inspector</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hit ? (
          <ClipInspector key={hit.clip.id} clip={hit.clip} track={hit.track} media={media} />
        ) : selection.length > 1 ? (
          <MultiInspector ids={selection} />
        ) : (
          <ProjectInspector />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sections

function Section({ id, title, children, actions }: { id: string; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  const [open, setOpen] = useLocal(`revind.section.${id}`, true);
  return (
    <section className="border-b border-line-soft">
      <div className="flex h-8 items-center gap-1 px-3">
        <button className="flex flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
          <ChevronDown className={cn("h-3 w-3 text-ink-dim transition-transform", !open && "-rotate-90")} />
          <span className="panel-title">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div className="space-y-1.5 px-3 pb-3">{children}</div>}
    </section>
  );
}

function ResetButton({ onClick, title = "Reset" }: { onClick: () => void; title?: string }) {
  return (
    <IconButton size="xs" title={title} onClick={onClick}>
      <RotateCcw className="h-3 w-3" />
    </IconButton>
  );
}

// ------------------------------------------------------------------- project

function ProjectInspector() {
  const project = useStore((s) => s.project);
  const selectedMedia = useStore((s) => (s.selectedMedia ? s.project.media.find((m) => m.id === s.selectedMedia) : undefined));
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <>
      <Section id="project" title="Project">
        <FieldRow label="Name">
          <input
            key={project.name}
            defaultValue={project.name}
            className="field"
            onBlur={(e) => e.target.value.trim() !== project.name && store().renameProject(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </FieldRow>
        <ProjectSettingsForm />
        <div className="grid grid-cols-3 gap-2 pt-2">
          <Stat label="Length" value={fmtDuration(projectDuration(project))} />
          <Stat label="Clips" value={String(clips)} />
          <Stat label="Media" value={String(project.media.length)} />
        </div>
      </Section>
      {selectedMedia && <MediaInfo media={selectedMedia} />}
      <p className="px-4 py-4 text-xs leading-relaxed text-ink-dim">Select a clip in the timeline to edit its position, colour, audio, speed and more.</p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-bg px-2 py-1.5">
      <div className="text-2xs text-ink-dim">{label}</div>
      <div className="font-mono text-sm text-ink tabular">{value}</div>
    </div>
  );
}

function MediaInfo({ media }: { media: MediaAsset }) {
  const rows: [string, string][] = [
    ["File", media.name],
    ["Type", media.kind],
    ...(media.kind !== "image" ? ([["Duration", seconds(media.duration)]] as [string, string][]) : []),
    ...(media.width ? ([["Size", `${media.width}×${media.height}`]] as [string, string][]) : []),
    ...(media.fps ? ([["Frame rate", `${fpsLabel(+media.fps.toFixed(3))} fps`]] as [string, string][]) : []),
    ...(media.videoCodec ? ([["Video", media.videoCodec]] as [string, string][]) : []),
    ...(media.audioCodec ? ([["Audio", media.audioCodec]] as [string, string][]) : []),
    ...(media.size ? ([["File size", bytes(media.size)]] as [string, string][]) : []),
  ];
  return (
    <Section id="media" title="Media">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 text-xs">
          <span className="w-[76px] shrink-0 text-ink-dim">{k}</span>
          <span className="min-w-0 flex-1 truncate text-ink-muted" title={v}>
            {v}
          </span>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={() => store().placeMedia(media.id)}>
          Add at playhead
        </Button>
        <Button size="sm" variant="ghost" onClick={() => store().openDialog({ kind: "source", mediaId: media.id })}>
          Preview…
        </Button>
      </div>
    </Section>
  );
}

// --------------------------------------------------------------- multi-clip

function MultiInspector({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const clips = ids.map((id) => findClip(project, id)?.clip).filter((c): c is Clip => !!c);
  if (!clips.length) return null;
  const first = clips[0];
  const upd = (fn: (c: Draft<Clip>) => void, live: boolean) => store().updateClips(ids, fn, { live });
  const commit = () => store().commit();
  return (
    <>
      <div className="px-3 py-3 text-sm text-ink">{clips.length} clips selected</div>
      <Section id="multi" title="Shared">
        <SliderField label="Opacity" value={first.opacity} min={0} max={1} step={0.01} displayScale={100} suffix="%" defaultValue={1} onChange={(v, o) => upd((c) => void (c.opacity = v), o.live)} onCommit={commit} />
        <SliderField label="Volume" value={first.volume} min={0} max={2} step={0.01} displayScale={100} suffix="%" defaultValue={1} onChange={(v, o) => upd((c) => void (c.volume = v), o.live)} onCommit={commit} />
        <SliderField label="Fade in" value={first.fadeIn} min={0} max={10} sliderMax={3} step={0.05} suffix="s" defaultValue={0} onChange={(v, o) => upd((c) => void (c.fadeIn = Math.min(v, clipDuration(c as Clip) - c.fadeOut)), o.live)} onCommit={commit} />
        <SliderField label="Fade out" value={first.fadeOut} min={0} max={10} sliderMax={3} step={0.05} suffix="s" defaultValue={0} onChange={(v, o) => upd((c) => void (c.fadeOut = Math.min(v, clipDuration(c as Clip) - c.fadeIn)), o.live)} onCommit={commit} />
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => upd((c) => void (c.muted = !first.muted), false)}>
            {first.muted ? "Unmute all" : "Mute all"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => store().deleteClips(ids, false)}>
            Delete
          </Button>
        </div>
      </Section>
    </>
  );
}

// --------------------------------------------------------------- single clip

function ClipInspector({ clip, track, media }: { clip: Clip; track: Track; media?: MediaAsset }) {
  const id = clip.id;
  const fps = useStore((s) => s.project.settings.fps);
  const locked = track.locked;
  const isTitle = clip.type === "title";
  const visual = track.kind === "video" && (isTitle || (!!media && media.hasVideo));
  const hasAudio = !isTitle && !!media?.hasAudio && media.kind !== "image";
  const upd = (fn: (c: Draft<Clip>) => void, live = false) => store().updateClip(id, fn, { live });
  const num = (get: (c: Clip) => number, set: (c: Draft<Clip>, v: number) => void) => ({
    value: get(clip),
    onChange: (v: number, o: { live: boolean }) => upd((c) => set(c, v), o.live),
    onCommit: () => store().commit(),
  });
  const Icon = isTitle ? Type : track.kind === "audio" ? Music : media?.kind === "image" ? ImageIcon : Film;
  const dur = clipDuration(clip);

  return (
    <div className={cn(locked && "pointer-events-none opacity-60")}>
      <div className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5">
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", isTitle ? "bg-title/15 text-title" : track.kind === "audio" ? "bg-audio/15 text-audio" : "bg-video/15 text-video")}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            key={clip.label ?? ""}
            defaultValue={clip.label ?? ""}
            placeholder={isTitle ? clip.title?.text.split("\n")[0] || "Title" : media?.name ?? "Clip"}
            className="w-full truncate bg-transparent text-sm font-medium text-ink outline-none placeholder:text-ink focus:placeholder:text-ink-faint"
            title="Rename clip"
            onBlur={(e) => {
              const v = e.target.value.trim() || undefined;
              if (v !== clip.label) upd((c) => void (c.label = v));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <div className="font-mono text-2xs text-ink-dim tabular">
            {timecode(clip.start, fps)} → {timecode(clipEnd(clip), fps)} · {seconds(dur)}
          </div>
        </div>
      </div>
      {locked && <div className="bg-danger/10 px-3 py-1.5 text-xs text-danger">Track {track.name} is locked.</div>}

      {isTitle && clip.title && <TitleSection clip={clip} />}

      {isUnbounded(clip, media) && (
        <Section id="timing" title="Timing">
          <FieldRow label="Duration">
            <NumberField
              value={dur}
              min={MIN_CLIP}
              max={3600}
              step={0.1}
              suffix="s"
              className="flex-1"
              // Always live: the commit settles overlaps with neighbours in one undo step.
              onChange={(v) => upd((c) => void (c.out = c.in + Math.max(MIN_CLIP, v) * speedOf(c as Clip)), true)}
              onCommit={() => store().settleClips([id])}
            />
          </FieldRow>
        </Section>
      )}

      {visual && (
        <Section
          id="transform"
          title="Transform"
          actions={<ResetButton title="Reset transform" onClick={() => upd((c) => void (c.transform = defaultTransform()))} />}
        >
          {!isTitle && (
            <FieldRow label="Fit">
              <Segmented
                className="flex-1"
                value={clip.transform.fit}
                onChange={(fit) => upd((c) => void (c.transform.fit = fit))}
                options={[
                  { value: "contain", label: "Fit", title: "Show the whole picture (letterbox)" },
                  { value: "cover", label: "Fill", title: "Fill the frame (crop overflow)" },
                  { value: "stretch", label: "Stretch", title: "Stretch to the frame" },
                ]}
              />
            </FieldRow>
          )}
          <FieldRow label="Position">
            <NumberField label="X" {...num((c) => c.transform.x, (c, v) => void (c.transform.x = v))} suffix="px" className="flex-1" />
            <NumberField label="Y" {...num((c) => c.transform.y, (c, v) => void (c.transform.y = v))} suffix="px" className="flex-1" />
          </FieldRow>
          <SliderField label="Scale" {...num((c) => c.transform.scale, (c, v) => void (c.transform.scale = v))} min={0.05} max={10} sliderMin={0.1} sliderMax={3} step={0.01} displayScale={100} suffix="%" defaultValue={1} />
          <SliderField label="Rotation" {...num((c) => c.transform.rotation, (c, v) => void (c.transform.rotation = v))} min={-3600} max={3600} sliderMin={-180} sliderMax={180} step={1} suffix="°" defaultValue={0} />
          <FieldRow label="Flip">
            <IconButton title="Flip horizontally" active={clip.transform.flipH} onClick={() => upd((c) => void (c.transform.flipH = !c.transform.flipH))}>
              <FlipHorizontal2 className="h-4 w-4" />
            </IconButton>
            <IconButton title="Flip vertically" active={clip.transform.flipV} onClick={() => upd((c) => void (c.transform.flipV = !c.transform.flipV))}>
              <FlipVertical2 className="h-4 w-4" />
            </IconButton>
          </FieldRow>
        </Section>
      )}

      {visual && <MotionSection clip={clip} />}

      {visual && !isTitle && (
        <Section id="crop" title="Crop" actions={<ResetButton title="Reset crop" onClick={() => upd((c) => void (c.crop = defaultCrop()))} />}>
          <div className="grid grid-cols-2 gap-1.5">
            {(["top", "bottom", "left", "right"] as const).map((side) => (
              <NumberField
                key={side}
                label={side[0].toUpperCase() + side.slice(1)}
                {...num((c) => c.crop[side], (c, v) => void (c.crop[side] = v))}
                min={0}
                max={0.95}
                step={0.005}
                displayScale={100}
                precision={1}
                suffix="%"
              />
            ))}
          </div>
        </Section>
      )}

      {visual && (
        <Section id="compositing" title="Opacity & fades">
          <SliderField label="Opacity" {...num((c) => c.opacity, (c, v) => void (c.opacity = v))} min={0} max={1} step={0.01} displayScale={100} suffix="%" defaultValue={1} />
          <FadeFields clip={clip} upd={upd} />
        </Section>
      )}

      {clipBefore(track, clip) && <TransitionSection clip={clip} track={track} />}

      {visual && !isTitle && <ColorSection clip={clip} upd={upd} />}

      {hasAudio && (
        <Section id="audio" title="Audio">
          <SliderField label="Volume" {...num((c) => c.volume, (c, v) => void (c.volume = v))} min={0} max={2} step={0.01} displayScale={100} suffix="%" defaultValue={1} />
          {!visual && <FadeFields clip={clip} upd={upd} />}
          <FieldRow label="Mute">
            <Switch checked={clip.muted} onChange={(m) => upd((c) => void (c.muted = m))} />
          </FieldRow>
          {track.kind === "audio" && <VideoLength clip={clip} />}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={() => store().openDialog({ kind: "silence", clipId: id })} title="Find pauses in the audio and cut them out">
              <Wand2 className="h-3.5 w-3.5 text-accent-ink" /> Remove silences…
            </Button>
            {track.kind === "video" && (
              <Button size="sm" variant="ghost" disabled={clip.muted} onClick={() => store().detachAudio(id)} title="Move this clip's sound to its own audio track">
                <Unlink className="h-3.5 w-3.5" /> Detach
              </Button>
            )}
          </div>
        </Section>
      )}

      {!isTitle && media && media.kind !== "image" && <SpeedSection clip={clip} />}

      {media && <MediaInfo media={media} />}
    </div>
  );
}

/** Fit a music clip to the picture: trim it to end with the video, or loop it until it does. */
function VideoLength({ clip }: { clip: Clip }) {
  const end = useStore((s) => videoEnd(s.project.tracks));
  if (end <= 0 || clip.start >= end - MIN_CLIP) return null;
  const over = clipEnd(clip) - end;
  return (
    <FieldRow label="Video">
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {over > EPS ? (
          <Button size="sm" onClick={() => store().matchVideoLength([clip.id])} title={`Trim to end with the video (${seconds(over)} shorter)`}>
            <ArrowRightToLine className="h-3.5 w-3.5" /> Match length
          </Button>
        ) : over < -MIN_CLIP ? (
          <Button size="sm" onClick={() => store().loopToVideoLength(clip.id)} title={`Repeat until the video ends (${seconds(-over)} to fill)`}>
            <Repeat className="h-3.5 w-3.5" /> Loop to fill
          </Button>
        ) : (
          <span className="text-xs text-success">Ends with the video</span>
        )}
      </div>
    </FieldRow>
  );
}

const chip = (active: boolean) =>
  cn(
    "h-6 rounded-md border px-2 text-2xs font-medium transition-colors",
    active ? "border-accent bg-accent/15 text-accent-ink" : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
  );

/** Ken Burns presets: the clip glides from one framing to another over its length. */
function MotionSection({ clip }: { clip: Clip }) {
  const settings = useStore((s) => s.project.settings);
  const m = clip.motion;
  const amount = m ? motionAmount(m) : DEFAULT_MOTION_AMOUNT;
  const set = (preset: MotionPreset | null, a = amount, live = false) =>
    store().updateClip(clip.id, (c) => void (preset ? (c.motion = motionPreset(preset, a, settings.width, settings.height)) : delete c.motion), { live });
  return (
    <Section id="motion" title="Motion" actions={m && <ResetButton title="Remove motion" onClick={() => set(null)} />}>
      <div className="flex flex-wrap gap-1">
        <button className={chip(!m)} onClick={() => set(null)}>
          None
        </button>
        {MOTION_PRESETS.map((p) => (
          <button key={p.id} className={chip(m?.preset === p.id)} onClick={() => set(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {m?.preset && (
        <SliderField label="Amount" value={amount} min={0.02} max={1} sliderMax={0.5} step={0.01} displayScale={100} suffix="%" defaultValue={DEFAULT_MOTION_AMOUNT} onChange={(v, o) => set(m.preset!, v, o.live)} onCommit={() => store().commit()} />
      )}
      {m && <p className="text-2xs text-ink-dim">Moves across the whole clip. Use Fill so pans never reveal the background.</p>}
    </Section>
  );
}

function TransitionSection({ clip, track }: { clip: Clip; track: Track }) {
  const d = dissolveInto(track, clip);
  const len = clip.transitionIn ?? 0;
  return (
    <Section id="transition" title="Transition in">
      <SliderField
        label="Dissolve"
        value={len}
        min={0}
        max={10}
        sliderMax={3}
        step={0.05}
        suffix="s"
        defaultValue={0}
        onChange={(v, o) => store().updateClip(clip.id, (c) => void (v > 0 ? (c.transitionIn = v) : delete c.transitionIn), { live: o.live })}
        onCommit={() => store().commit()}
      />
      {d && Math.abs(2 * d.half - len) > 0.01 && (
        <p className="text-2xs text-ink-dim">Limited to {seconds(2 * d.half)}: a dissolve takes at most half of each clip.</p>
      )}
      {len === 0 && (
        <Button size="sm" variant="ghost" onClick={() => store().dipToBlack(clip.id, 1)} title="Fade the previous clip out and this one in">
          Dip to black
        </Button>
      )}
    </Section>
  );
}

function FadeFields({ clip, upd }: { clip: Clip; upd: (fn: (c: Draft<Clip>) => void, live?: boolean) => void }) {
  const d = clipDuration(clip);
  return (
    <>
      <SliderField
        label="Fade in"
        value={clip.fadeIn}
        min={0}
        max={Math.max(0, d - clip.fadeOut)}
        sliderMax={Math.min(3, Math.max(0.1, d - clip.fadeOut))}
        step={0.05}
        suffix="s"
        defaultValue={0}
        onChange={(v, o) => upd((c) => void (c.fadeIn = v), o.live)}
        onCommit={() => store().commit()}
      />
      <SliderField
        label="Fade out"
        value={clip.fadeOut}
        min={0}
        max={Math.max(0, d - clip.fadeIn)}
        sliderMax={Math.min(3, Math.max(0.1, d - clip.fadeIn))}
        step={0.05}
        suffix="s"
        defaultValue={0}
        onChange={(v, o) => upd((c) => void (c.fadeOut = v), o.live)}
        onCommit={() => store().commit()}
      />
    </>
  );
}

const LOOKS: { name: string; color: Partial<ColorAdjust> }[] = [
  { name: "None", color: {} },
  { name: "Vivid", color: { contrast: 1.12, saturation: 1.35 } },
  { name: "Warm", color: { sepia: 0.22, saturation: 1.15, hue: -6 } },
  { name: "Cool", color: { hue: 12, saturation: 0.9, brightness: 1.03 } },
  { name: "Mono", color: { saturation: 0, contrast: 1.15 } },
  { name: "Faded", color: { contrast: 0.82, saturation: 0.75, brightness: 1.08 } },
  { name: "Vintage", color: { sepia: 0.45, contrast: 0.92, saturation: 0.85 } },
  { name: "Punch", color: { contrast: 1.3, brightness: 0.96, saturation: 1.1 } },
];

function ColorSection({ clip, upd }: { clip: Clip; upd: (fn: (c: Draft<Clip>) => void, live?: boolean) => void }) {
  const c = clip.color;
  const field = (key: keyof ColorAdjust, label: string, min: number, max: number, step: number, def: number, scale = 1, suffix = "") => (
    <SliderField
      label={label}
      value={c[key]}
      min={min}
      max={max}
      step={step}
      displayScale={scale}
      suffix={suffix}
      defaultValue={def}
      onChange={(v, o) => upd((x) => void (x.color[key] = v), o.live)}
      onCommit={() => store().commit()}
    />
  );
  return (
    <Section id="color" title="Colour" actions={<ResetButton title="Reset colour" onClick={() => upd((x) => void (x.color = defaultColor()))} />}>
      <div className="mb-1 flex flex-wrap gap-1">
        {LOOKS.map((l) => {
          const target = { ...defaultColor(), ...l.color };
          const active = (Object.keys(target) as (keyof ColorAdjust)[]).every((k) => Math.abs(target[k] - c[k]) < 1e-3);
          return (
            <button key={l.name} onClick={() => upd((x) => void (x.color = { ...target }))} className={chip(active)}>
              {l.name}
            </button>
          );
        })}
      </div>
      {field("brightness", "Brightness", 0, 3, 0.01, 1, 100, "%")}
      {field("contrast", "Contrast", 0, 3, 0.01, 1, 100, "%")}
      {field("saturation", "Saturation", 0, 3, 0.01, 1, 100, "%")}
      {field("hue", "Hue", -180, 180, 1, 0, 1, "°")}
      {field("sepia", "Warmth", 0, 1, 0.01, 0, 100, "%")}
      {field("blur", "Blur", 0, 50, 0.5, 0, 1, "px")}
    </Section>
  );
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

function SpeedSection({ clip }: { clip: Clip }) {
  const sp = speedOf(clip);
  const setSpeed = (v: number, commit: boolean) => {
    const next = Math.max(0.1, Math.min(16, v));
    store().updateClip(clip.id, (c) => {
      c.speed = next;
      const d = clipDuration(c as Clip);
      c.fadeIn = Math.min(c.fadeIn, d);
      c.fadeOut = Math.min(c.fadeOut, d - c.fadeIn);
    }, { live: true });
    // Faster/slower clips change length; settle overlaps with neighbours on commit.
    if (commit) store().settleClips([clip.id]);
  };
  return (
    <Section id="speed" title="Speed">
      <div className="flex flex-wrap gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s, true)}
            className={cn(
              "h-6 min-w-[38px] rounded-md border px-1.5 font-mono text-2xs transition-colors",
              Math.abs(sp - s) < EPS ? "border-accent bg-accent/15 text-accent-ink" : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {s}×
          </button>
        ))}
      </div>
      <SliderField label="Custom" value={sp} min={0.1} max={16} sliderMin={0.1} sliderMax={4} step={0.05} suffix="×" defaultValue={1} onChange={(v) => setSpeed(v, false)} onCommit={() => store().settleClips([clip.id])} />
      <p className="text-2xs text-ink-dim">Audio keeps its pitch. Speeding up shortens the clip; slowing down may cover the next clip.</p>
    </Section>
  );
}

// -------------------------------------------------------------------- titles

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

function TitleSection({ clip }: { clip: Clip }) {
  const t = clip.title!;
  const id = clip.id;
  const set = (patch: Partial<TitleStyle>, live = false) => store().updateClip(id, (c) => void Object.assign(c.title!, patch), { live });
  const n = (key: keyof TitleStyle) => ({
    value: t[key] as number,
    onChange: (v: number, o: { live: boolean }) => set({ [key]: v } as Partial<TitleStyle>, o.live),
    onCommit: () => store().commit(),
  });
  const color = (key: keyof TitleStyle) => (v: string) => {
    set({ [key]: v } as Partial<TitleStyle>, true);
    commitSoon();
  };
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const fonts = TITLE_FONTS.includes(t.fontFamily) ? TITLE_FONTS : [t.fontFamily, ...TITLE_FONTS];

  return (
    <>
      <Section id="title-text" title="Text">
        <textarea
          ref={textRef}
          defaultValue={t.text}
          key={id}
          rows={3}
          className="field h-auto resize-y py-1.5 leading-snug"
          placeholder="Type your title"
          onChange={(e) => {
            set({ text: e.target.value }, true);
            commitSoon(800);
          }}
          onBlur={() => store().commit()}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <FieldRow label="Font">
          <Select className="flex-1" value={t.fontFamily} options={fonts.map((f) => ({ value: f, label: f.replace(" Variable", "") }))} onChange={(fontFamily) => set({ fontFamily })} />
        </FieldRow>
        <FieldRow label="Style">
          <Select className="w-[88px]" value={t.fontWeight} options={WEIGHTS.map((w) => ({ value: w, label: String(w) }))} onChange={(fontWeight) => set({ fontWeight })} />
          <IconButton title="Italic" active={t.italic} onClick={() => set({ italic: !t.italic })}>
            <Italic className="h-4 w-4" />
          </IconButton>
          <Segmented
            value={t.align}
            onChange={(align) => set({ align })}
            options={[
              { value: "left", label: <AlignLeft className="h-3.5 w-3.5" />, title: "Align left" },
              { value: "center", label: <AlignCenter className="h-3.5 w-3.5" />, title: "Centre" },
              { value: "right", label: <AlignRight className="h-3.5 w-3.5" />, title: "Align right" },
            ]}
          />
        </FieldRow>
        <SliderField label="Size" {...n("fontSize")} min={6} max={1000} sliderMin={12} sliderMax={300} step={1} suffix="px" />
        <FieldRow label="Colour">
          <ColorInput value={t.color} onChange={color("color")} />
        </FieldRow>
        <SliderField label="Line height" {...n("lineHeight")} min={0.6} max={3} step={0.05} defaultValue={1.15} />
        <SliderField label="Spacing" {...n("letterSpacing")} min={-20} max={100} sliderMin={-10} sliderMax={40} step={0.5} suffix="px" defaultValue={0} />
      </Section>

      <Section id="title-layout" title="Layout">
        <FieldRow label="Position">
          <NumberField label="X" {...n("x")} min={-50} max={150} step={0.5} suffix="%" className="flex-1" />
          <NumberField label="Y" {...n("y")} min={-50} max={150} step={0.5} suffix="%" className="flex-1" />
        </FieldRow>
        <FieldRow label="Snap">
          <div className="grid flex-1 grid-cols-3 gap-1">
            {[
              ["Top", 50, 12],
              ["Centre", 50, 50],
              ["Bottom", 50, 86],
            ].map(([label, x, y]) => (
              <button
                key={label as string}
                className="h-6 rounded-md border border-line text-2xs text-ink-muted hover:border-line-strong hover:text-ink"
                onClick={() => set({ x: x as number, y: y as number })}
              >
                {label}
              </button>
            ))}
          </div>
        </FieldRow>
        <SliderField label="Wrap width" {...n("maxWidth")} min={10} max={100} step={1} suffix="%" defaultValue={80} />
      </Section>

      <Section id="title-effects" title="Outline, shadow & box">
        <FieldRow label="Outline">
          <NumberField {...n("strokeWidth")} min={0} max={60} step={0.5} suffix="px" className="w-[80px]" />
          <ColorInput value={t.strokeColor} onChange={color("strokeColor")} />
        </FieldRow>
        <FieldRow label="Shadow">
          <NumberField {...n("shadow")} min={0} max={100} step={1} suffix="px" className="w-[80px]" />
          <ColorInput value={t.shadowColor} onChange={color("shadowColor")} />
        </FieldRow>
        <FieldRow label="Background">
          <Switch checked={t.box} onChange={(box) => set({ box })} />
          {t.box && <ColorInput value={t.boxColor} onChange={color("boxColor")} />}
        </FieldRow>
        {t.box && (
          <>
            <SliderField label="Box opacity" {...n("boxOpacity")} min={0} max={1} step={0.01} displayScale={100} suffix="%" />
            <SliderField label="Padding" {...n("boxPadding")} min={0} max={200} sliderMax={80} step={1} suffix="px" />
            <SliderField label="Radius" {...n("boxRadius")} min={0} max={200} sliderMax={60} step={1} suffix="px" />
          </>
        )}
      </Section>
    </>
  );
}
