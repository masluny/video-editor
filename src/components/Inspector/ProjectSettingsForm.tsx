import { commitSoon, store, useStore } from "../../store/store";
import { FieldRow, Select, ColorInput } from "../ui/controls";
import { NumberField } from "../ui/NumberField";
import { FORMAT_PRESETS, FPS_OPTIONS } from "../../lib/defaults";
import { fpsLabel } from "../../lib/format";

/** After a change of frame shape, offer to crop letterboxed clips to fill the new frame. */
function offerFill() {
  const s = store();
  const { media, tracks } = s.project;
  const picture = new Set(media.filter((m) => m.hasVideo).map((m) => m.id));
  const boxed = tracks.some((t) => t.kind === "video" && t.clips.some((c) => c.type === "media" && picture.has(c.mediaId!) && c.transform.fit === "contain"));
  if (!boxed) return;
  s.toast("Clips keep their shape and may show bars in the new frame.", "info", { label: "Fill frame", run: () => store().fitClips("cover") });
}

/** Frame size, frame rate and background colour of the project. */
export function ProjectSettingsForm() {
  const settings = useStore((s) => s.project.settings);
  const preset = FORMAT_PRESETS.find((p) => p.width === settings.width && p.height === settings.height)?.id ?? "custom";
  const set = (patch: Parameters<ReturnType<typeof store>["updateSettings"]>[0]) => store().updateSettings(patch);
  const even = (v: number) => Math.max(16, Math.round(v / 2) * 2);
  const fpsOptions = FPS_OPTIONS.includes(settings.fps) ? FPS_OPTIONS : [...FPS_OPTIONS, settings.fps].sort((a, b) => a - b);
  return (
    <div className="space-y-1.5">
      <FieldRow label="Format">
        <Select
          className="flex-1"
          value={preset}
          options={[...FORMAT_PRESETS.map((p) => ({ value: p.id, label: p.name })), ...(preset === "custom" ? [{ value: "custom", label: "Custom" }] : [])]}
          onChange={(id) => {
            const p = FORMAT_PRESETS.find((x) => x.id === id);
            if (!p) return;
            const reshaped = Math.abs(p.width / p.height - settings.width / settings.height) > 0.01;
            set({ width: p.width, height: p.height });
            if (reshaped) offerFill();
          }}
        />
      </FieldRow>
      <FieldRow label="Size">
        <NumberField label="W" value={settings.width} min={16} max={8192} step={2} onChange={(v) => set({ width: even(v) })} className="flex-1" />
        <span className="text-ink-dim">×</span>
        <NumberField label="H" value={settings.height} min={16} max={8192} step={2} onChange={(v) => set({ height: even(v) })} className="flex-1" />
      </FieldRow>
      <FieldRow label="Frame rate">
        <Select className="flex-1" value={settings.fps} options={fpsOptions.map((f) => ({ value: f, label: `${fpsLabel(f)} fps` }))} onChange={(fps) => set({ fps })} />
      </FieldRow>
      <FieldRow label="Background" hint="Colour shown where no clip covers the frame">
        <ColorInput
          value={settings.background}
          onChange={(background) => {
            store().apply((p) => void (p.settings.background = background), { live: true });
            commitSoon();
          }}
        />
      </FieldRow>
    </div>
  );
}
