import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Slider } from "../ui/Slider";
import { Checkbox } from "../ui/Checkbox";
import { Clock3, Info, Move, Music, PanelRight, SlidersHorizontal, Trash2, Type } from "lucide-react";
import { getClipDuration } from "../../lib/utils";

export function Inspector() {
  const { project, selectedClipId, selectedTrackId, selectedClipIds, updateClip, removeClipAndCleanupMedia, setTrackVolume, pushHistory } = useProjectStore();
  const multiCount = selectedClipIds.length;

  // Property edits (sliders, text, color) are continuous; we record a single undo
  // snapshot when the interaction ends (pointer up / focus leaves a field).
  const dirty = React.useRef(false);
  const commitIfDirty = React.useCallback(() => {
    if (dirty.current) {
      dirty.current = false;
      pushHistory();
    }
  }, [pushHistory]);

  const active = React.useMemo(() => {
    if (!selectedClipId || !selectedTrackId) return null;
    const track = project.tracks.find((t) => t.id === selectedTrackId);
    const clip = track?.clips.find((c) => c.id === selectedClipId);
    const asset = project.media.find((m) => m.id === clip?.media_id);
    return track && clip && asset ? { track, clip, asset } : null;
  }, [selectedClipId, selectedTrackId, project.tracks, project.media]);

  if (!active) {
    return (
      <div className="workspace-panel flex flex-col h-full select-none">
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <PanelRight className="w-3.5 h-3.5 text-accent" />
            <span>Inspector</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col justify-center items-center text-text-dim text-center p-6">
          <div className="w-14 h-14 rounded-xl bg-bg-secondary border border-border flex items-center justify-center mb-4">
            <Info className="w-5 h-5 opacity-60" />
          </div>
          <p className="text-sm font-semibold text-text-muted">No selection</p>
          <p className="text-xs mt-1.5 max-w-[220px] leading-relaxed">Select a clip to adjust trim, transform, color, audio, and titles.</p>
        </div>
      </div>
    );
  }

  const { track, clip, asset } = active;

  const handleUpdate = (patch: any) => {
    dirty.current = true;
    updateClip(track.id, clip.id, patch);
  };

  const handleTextUpdate = (textPatch: any) => {
    const currentText = clip.text || {
      text: "New Text Overlay",
      x: 35,
      y: 40,
      font_size: 48,
      color: "#ffffff",
      font_family: "sans-serif",
      bold: false,
      italic: false,
    };
    handleUpdate({ text: { ...currentText, ...textPatch } });
  };
  const color = normalizeColor(clip.color);
  const updateColor = (patch: Partial<typeof color>) => {
    handleUpdate({ color: { ...color, ...patch } });
  };

  return (
    <div
      className="workspace-panel flex flex-col h-full overflow-y-auto select-none"
      onPointerUp={commitIfDirty}
      onBlur={commitIfDirty}
    >
      <div className="panel-header">
        <div className="flex items-center gap-2 min-w-0">
          <PanelRight className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="truncate">
            Inspector
            {multiCount > 1 && <span className="ml-2 text-accent normal-case tracking-normal">· {multiCount} selected</span>}
          </span>
        </div>
      </div>

      <div className="p-3 space-y-3">
        <div className="soft-card p-3.5">
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-lg border flex items-center justify-center text-xs font-bold shrink-0 ${track.kind === "video" ? "bg-accent/15 border-accent/25 text-accent" : "bg-emerald-500/15 border-emerald-400/25 text-emerald-300"}`}>
              {track.kind === "video" ? "V" : "A"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text truncate leading-5" title={asset.name}>
                {asset.name}
              </p>
              <p className="text-[11px] text-text-dim truncate mt-0.5" title={asset.path}>
                {track.name} · {asset.path.split("/").pop()}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-border/70">
            <InspectorMetric label="Length" value={`${getClipDuration(clip).toFixed(2)}s`} />
            <InspectorMetric label="Start" value={`${clip.timeline_start.toFixed(2)}s`} />
            <InspectorMetric label="Speed" value={`${clip.speed.toFixed(2)}x`} />
          </div>
          <Button
            variant="danger"
            size="md"
            className="w-full h-9 mt-4"
            onClick={() => {
              removeClipAndCleanupMedia(track.id, clip.id);
              pushHistory();
            }}
            title="Remove selected clip"
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>Remove selected clip</span>
          </Button>
        </div>

        <InspectorSection title="Trim" icon={<Clock3 className="w-3.5 h-3.5" />}>
          <Slider
            label="In"
            min={0}
            max={Math.max((asset.durationSec || 0) || 10000, clip.source_out - 0.01)}
            step={0.01}
            value={clip.source_in}
            onChange={(v) => {
              const maxIn = clip.source_out - 0.02;
              handleUpdate({ source_in: Math.max(0, Math.min(v, maxIn)) });
            }}
          />
          <Slider
            label="Out"
            min={Math.min(clip.source_in + 0.02, asset.durationSec || 10000)}
            max={(asset.durationSec || 0) || 10000}
            step={0.01}
            value={clip.source_out}
            onChange={(v) => {
              const minOut = clip.source_in + 0.02;
              const maxOut = asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 10000;
              handleUpdate({ source_out: Math.max(minOut, Math.min(v, maxOut)) });
            }}
          />
          <div className="flex items-center justify-between text-[11px] text-text-dim pt-1">
            <span>Source range</span>
            <span className="font-mono text-text-muted">{clip.source_in.toFixed(2)}s - {clip.source_out.toFixed(2)}s</span>
          </div>
        </InspectorSection>

        {track.kind === "video" && (
          <InspectorSection title="Color" icon={<SlidersHorizontal className="w-3.5 h-3.5" />}>
            <Slider
              label="Bright"
              min={-1}
              max={1}
              step={0.05}
              value={color.brightness}
              onChange={(v) => updateColor({ brightness: v })}
            />
            <Slider
              label="Contrast"
              min={0}
              max={2}
              step={0.05}
              value={color.contrast}
              onChange={(v) => updateColor({ contrast: v })}
            />
            <Slider
              label="Saturate"
              min={0}
              max={2}
              step={0.05}
              value={color.saturation}
              onChange={(v) => updateColor({ saturation: v })}
            />
            <Slider
              label="Gamma"
              min={0.25}
              max={3}
              step={0.05}
              value={color.gamma}
              onChange={(v) => updateColor({ gamma: v })}
            />
            <Slider
              label="Hue"
              min={-180}
              max={180}
              step={1}
              value={color.hue}
              onChange={(v) => updateColor({ hue: v })}
            />
            <Slider
              label="Blur"
              min={0}
              max={12}
              step={0.25}
              value={color.blur}
              onChange={(v) => updateColor({ blur: v })}
            />
            <Slider
              label="Opacity"
              min={0}
              max={1}
              step={0.05}
              value={clip.opacity}
              onChange={(v) => handleUpdate({ opacity: v })}
            />
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-8 mt-1"
              onClick={() => {
                handleUpdate({
                  opacity: 1,
                  color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
                });
              }}
            >
              Reset color
            </Button>
          </InspectorSection>
        )}

        {track.kind === "video" && (
          <InspectorSection title="Transform" icon={<Move className="w-3.5 h-3.5" />}>
            <Slider
              label="X"
              min={-1000}
              max={1000}
              step={5}
              value={clip.transform.x}
              onChange={(v) => handleUpdate({ transform: { ...clip.transform, x: v } })}
            />
            <Slider
              label="Y"
              min={-1000}
              max={1000}
              step={5}
              value={clip.transform.y}
              onChange={(v) => handleUpdate({ transform: { ...clip.transform, y: v } })}
            />
            <Slider
              label="Scale"
              min={0.1}
              max={4}
              step={0.05}
              value={clip.transform.scale}
              onChange={(v) => handleUpdate({ transform: { ...clip.transform, scale: v } })}
            />
            <Slider
              label="Rotate"
              min={-180}
              max={180}
              step={1}
              value={clip.transform.rotation}
              onChange={(v) => handleUpdate({ transform: { ...clip.transform, rotation: v } })}
            />
          </InspectorSection>
        )}

        {track.kind === "video" && (
          <InspectorSection title="Title" icon={<Type className="w-3.5 h-3.5" />}>
            <div className="space-y-3">
              <Checkbox
                label="Text overlay"
                checked={!!clip.text}
                onChange={(e) => {
                  if (e.target.checked) {
                    handleUpdate({
                      text: {
                        text: "Title Text Overlay",
                        x: 35,
                        y: 40,
                        font_size: 48,
                        color: "#ffffff",
                        font_family: "sans-serif",
                        bold: false,
                        italic: false,
                      },
                    });
                  } else {
                    handleUpdate({ text: undefined });
                  }
                }}
              />
              {clip.text && (
                <div className="space-y-3 pt-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">Content</span>
                    <Input
                      value={clip.text.text}
                      onChange={(e) => handleTextUpdate({ text: e.target.value })}
                      placeholder="Title content"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-text-muted">Size</span>
                      <Input
                        type="number"
                        min="8"
                        max="200"
                        value={clip.text.font_size}
                        onChange={(e) => handleTextUpdate({ font_size: parseInt(e.target.value) || 24 })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-text-muted">Color</span>
                      <div className="flex gap-2 items-center min-w-0">
                        <input
                          type="color"
                          value={clip.text.color}
                          onChange={(e) => handleTextUpdate({ color: e.target.value })}
                          className="w-8 h-8 bg-bg-secondary border border-border p-0 cursor-pointer rounded-md shrink-0"
                        />
                        <span className="text-[11px] text-text font-mono uppercase truncate">{clip.text.color}</span>
                      </div>
                    </div>
                  </div>
                  <Slider
                    label="Text X"
                    min={0}
                    max={100}
                    step={1}
                    value={clip.text.x}
                    onChange={(v) => handleTextUpdate({ x: v })}
                  />
                  <Slider
                    label="Text Y"
                    min={0}
                    max={100}
                    step={1}
                    value={clip.text.y}
                    onChange={(v) => handleTextUpdate({ y: v })}
                  />
                </div>
              )}
            </div>
          </InspectorSection>
        )}

        <InspectorSection title="Playback" icon={<Music className="w-3.5 h-3.5" />}>
          <Slider
            label="Track"
            min={0}
            max={2}
            step={0.05}
            value={track.volume ?? 1}
            onChange={(v) => { dirty.current = true; setTrackVolume(track.id, v); }}
          />
          <Slider
            label="Clip"
            min={0}
            max={2}
            step={0.05}
            value={clip.volume}
            onChange={(v) => handleUpdate({ volume: v })}
          />
          <Slider
            label="Speed"
            min={0.25}
            max={4}
            step={0.05}
            value={clip.speed}
            onChange={(v) => handleUpdate({ speed: v })}
          />
        </InspectorSection>
      </div>
    </div>
  );
}

function InspectorSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="soft-card overflow-hidden">
      <div className="h-10 px-3.5 flex items-center gap-2 border-b border-border/70">
        <span className="text-accent shrink-0">{icon}</span>
        <h3 className="text-xs font-semibold text-text">{title}</h3>
      </div>
      <div className="p-3.5 space-y-2.5">{children}</div>
    </section>
  );
}

function InspectorMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.08em] text-text-dim truncate">{label}</p>
      <p className="text-[12px] font-mono text-text-muted truncate mt-0.5" title={value}>{value}</p>
    </div>
  );
}

function normalizeColor(color?: Partial<{ brightness: number; contrast: number; saturation: number; gamma: number; hue: number; blur: number }>) {
  return {
    brightness: color?.brightness ?? 0,
    contrast: color?.contrast ?? 1,
    saturation: color?.saturation ?? 1,
    gamma: color?.gamma ?? 1,
    hue: color?.hue ?? 0,
    blur: color?.blur ?? 0,
  };
}
