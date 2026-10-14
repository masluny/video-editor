import * as React from "react";
import { Loader2, Wand2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/controls";
import { SliderField } from "../ui/NumberField";
import { findClip, store, useStore } from "../../store/store";
import { backend } from "../../lib/backend";
import { speechRanges, speedOf } from "../../lib/timeline";
import { seconds } from "../../lib/format";
import { useLocal } from "../../lib/useLocal";
import type { Id } from "../../lib/types";
import { firstLine } from "./exportJob";

interface Params {
  threshold: number;
  minSilence: number;
  padding: number;
}
const DEFAULTS: Params = { threshold: -38, minSilence: 0.6, padding: 0.12 };

/**
 * "Remove silences": finds pauses in a clip's audio with ffmpeg's silencedetect and
 * cuts them out, butting the spoken parts together (jump cuts for talking-head video).
 */
export function SilenceDialog({ clipId }: { clipId: Id }) {
  const close = () => store().openDialog(null);
  const project = useStore((s) => s.project);
  const hit = findClip(project, clipId);
  const media = hit?.clip.mediaId ? project.media.find((m) => m.id === hit.clip.mediaId) : undefined;
  const wave = useStore((s) => (media ? s.runtime[media.id]?.waveform : undefined));
  const [params, setParams] = useLocal<Params>("revind.silenceParams", DEFAULTS);
  const p = { ...DEFAULTS, ...params };
  const [silences, setSilences] = React.useState<[number, number][] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const clip = hit?.clip;
  const from = clip?.in ?? 0;
  const to = clip?.out ?? 0;

  // Re-analyse (debounced) when detection parameters change.
  React.useEffect(() => {
    if (!media || !clip) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      backend
        .detectSilence(media.path, from, to, p.threshold, p.minSilence)
        .then((s) => live && (setSilences(s), setError(null)))
        .catch((e) => live && setError(firstLine(String(e))))
        .finally(() => live && setLoading(false));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.path, from, to, p.threshold, p.minSilence]);

  if (!clip || !media) {
    return (
      <Modal title="Remove silences" onClose={close}>
        <p className="text-sm text-ink-muted">That clip no longer exists.</p>
      </Modal>
    );
  }

  const keep = silences ? speechRanges(silences, from, to, p.padding) : null;
  const sp = speedOf(clip);
  const keptLen = keep ? keep.reduce((s, [a, b]) => s + (b - a), 0) : to - from;
  const saved = (to - from - keptLen) / sp;
  const cuts = keep ? gaps(keep, from, to).length : 0;
  const len = to - from || 1;

  const apply = () => {
    if (!keep?.length) return;
    const removed = store().replaceWithRanges(clipId, keep);
    close();
    store().toast(`Removed ${seconds(removed)} of silence in ${keep.length} piece${keep.length > 1 ? "s" : ""}.`, "success", { label: "Undo", run: () => store().undo() });
  };

  return (
    <Modal
      title="Remove silences"
      subtitle={clip.label || media.name}
      icon={<Wand2 className="h-4 w-4" />}
      onClose={close}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={loading || !keep?.length || saved < 0.01} onClick={apply}>
            Cut {cuts} pause{cuts === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-ink-muted">
          Finds the quiet parts of this clip and cuts them out, joining what's left. Great for talking-head videos and voice-overs. Later clips on the same track move left to close the
          gaps.
        </p>

        {/* Preview of what stays (green) and what goes (red). */}
        <div className="relative h-16 overflow-hidden rounded-md border border-line bg-bg">
          {wave && <WaveStrip peaks={wave.peaks} rate={wave.rate} from={from} to={to} />}
          {silences &&
            gaps(keep ?? [], from, to).map(([a, b], i) => (
              <div
                key={i}
                className="absolute inset-y-0 border-x border-danger/60 bg-danger/30"
                style={{ left: `${((a - from) / len) * 100}%`, width: `${((b - a) / len) * 100}%` }}
              />
            ))}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-ink">
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Listening…
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-xs">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : silences ? (
            <span className="text-ink-muted">
              <b className="text-ink">{cuts}</b> pause{cuts === 1 ? "" : "s"} found · saves <b className="text-ink">{seconds(Math.max(0, saved))}</b> of {seconds(len / sp)} (
              {Math.round((Math.max(0, saved) / (len / sp)) * 100)}%)
            </span>
          ) : (
            <span className="text-ink-dim">Analysing…</span>
          )}
        </div>

        <div className="space-y-1.5">
          <SliderField
            label="Threshold"
            value={p.threshold}
            min={-70}
            max={-10}
            step={1}
            suffix=" dB"
            defaultValue={DEFAULTS.threshold}
            onChange={(threshold) => setParams({ ...p, threshold })}
            title="Anything quieter than this counts as silence. Raise it for noisy recordings."
          />
          <SliderField
            label="Min. pause"
            value={p.minSilence}
            min={0.1}
            max={5}
            sliderMax={2.5}
            step={0.05}
            suffix="s"
            defaultValue={DEFAULTS.minSilence}
            onChange={(minSilence) => setParams({ ...p, minSilence })}
          />
          <SliderField
            label="Padding"
            value={p.padding}
            min={0}
            max={1}
            sliderMax={0.5}
            step={0.01}
            suffix="s"
            defaultValue={DEFAULTS.padding}
            onChange={(padding) => setParams({ ...p, padding })}
          />
        </div>
      </div>
    </Modal>
  );
}

/** Complement of `keep` inside [from, to]. */
function gaps(keep: [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let cur = from;
  for (const [a, b] of keep) {
    if (a > cur + 1e-4) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (to > cur + 1e-4) out.push([cur, to]);
  return out;
}

function WaveStrip({ peaks, rate, from, to }: { peaks: number[]; rate: number; from: number; to: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const cv = ref.current!;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgba(95,224,179,0.75)";
    for (let x = 0; x < w; x++) {
      const t0 = from + ((to - from) * x) / w;
      const t1 = from + ((to - from) * (x + 1)) / w;
      let peak = 0;
      for (let i = Math.floor(t0 * rate); i < Math.ceil(t1 * rate) && i < peaks.length; i++) if (i >= 0) peak = Math.max(peak, peaks[i]);
      const bh = Math.max(1, (peak / 255) * (h - 6));
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks, rate, from, to]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}
