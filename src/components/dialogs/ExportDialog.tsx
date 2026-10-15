import * as React from "react";
import { AlertTriangle, CheckCircle2, Clapperboard, FolderOpen, Loader2, Play, XCircle } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button, FieldRow, Segmented, Select, Switch } from "../ui/controls";
import { store, useStore } from "../../store/store";
import { backend, openPath, pickSavePath, revealInFolder, type ExportCodec, type ExportFormat, type ExportQuality, type ExportSettings } from "../../lib/backend";
import { projectDuration, videoEnd } from "../../lib/timeline";
import { basename, duration as fmtDuration, fpsLabel, seconds } from "../../lib/format";
import { useLocal } from "../../lib/useLocal";
import { cancelExport, firstLine, startExport, useExportJob } from "./exportJob";
import { FPS_OPTIONS } from "../../lib/defaults";

const FORMATS: { value: ExportFormat; label: string; group: "video" | "audio" | "image" }[] = [
  { value: "mp4", label: "MP4 video", group: "video" },
  { value: "mov", label: "QuickTime MOV", group: "video" },
  { value: "webm", label: "WebM video", group: "video" },
  { value: "gif", label: "Animated GIF", group: "image" },
  { value: "mp3", label: "MP3 audio", group: "audio" },
  { value: "m4a", label: "M4A (AAC) audio", group: "audio" },
  { value: "wav", label: "WAV audio (lossless)", group: "audio" },
];

interface Prefs {
  format: ExportFormat;
  codec: ExportCodec;
  quality: ExportQuality;
  height: number;
  fps: number;
  hardware: boolean;
  normalizeAudio: boolean;
  audioBitrate: number;
}

const DEFAULT_PREFS: Prefs = { format: "mp4", codec: "h264", quality: "high", height: 0, fps: 0, hardware: false, normalizeAudio: false, audioBitrate: 192 };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function ExportDialog() {
  const close = () => store().openDialog(null);
  const job = useExportJob((s) => s.job);
  const showJob = job && !job.quiet;
  return (
    <Modal
      title="Export"
      subtitle={useStore.getState().project.name}
      icon={<Clapperboard className="h-4 w-4" />}
      onClose={close}
      width={520}
      dismissable
    >
      {showJob ? <Progress /> : <Setup />}
    </Modal>
  );
}

function Setup() {
  const project = useStore((s) => s.project);
  const range = useStore((s) => s.range);
  const [prefs, setPrefs] = useLocal<Prefs>("revind.exportPrefs", DEFAULT_PREFS);
  const p = { ...DEFAULT_PREFS, ...prefs };
  const set = (patch: Partial<Prefs>) => setPrefs({ ...p, ...patch });
  const total = projectDuration(project);
  // Where the picture ends: audio running past it would export as black with sound.
  const picture = videoEnd(project.tracks);
  const overhang = picture > 0 && total - picture > 0.5 ? total - picture : 0;
  const [mode, setMode] = React.useState<"all" | "picture" | "range">(range ? "range" : overhang ? "picture" : "all");
  const [hwAvailable, setHwAvailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    backend
      .ffmpegStatus()
      .then((s) => setHwAvailable(s.encoders.includes("h264_videotoolbox")))
      .catch(() => {});
  }, []);

  const { width: pw, height: ph, fps: pfps } = project.settings;
  const fmt = FORMATS.find((f) => f.value === p.format) ?? FORMATS[0];
  const isVideo = fmt.group !== "audio";
  const isAudio = fmt.group === "audio";
  const canCodec = p.format === "mp4" || p.format === "mov";
  const codec = canCodec ? (p.format === "mp4" && p.codec === "prores" ? "h264" : p.codec) : "h264";
  const used = mode === "range" && !range ? "all" : mode === "picture" && (!overhang || isAudio) ? "all" : mode;
  const span = used === "range" ? range!.out - range!.in : used === "picture" ? picture : total;

  const heights = [0, 2160, 1440, 1080, 720, 480, 360].filter((h) => h === 0 || h < Math.max(pw, ph) * 2);
  const outH = p.height > 0 ? p.height : ph;
  const outW = p.height > 0 ? even((pw * p.height) / ph) : pw;
  const gifH = p.format === "gif" && p.height === 0 ? Math.min(ph, 480) : outH;
  const gifW = p.format === "gif" && p.height === 0 ? even((pw * gifH) / ph) : outW;

  const trimAudio = () => {
    const ids = project.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips.map((c) => c.id));
    store().matchVideoLength(ids, 1);
    setMode("all");
  };

  const go = async () => {
    const ext = p.format;
    const path = await pickSavePath("Export", `${project.name || "Untitled"}.${ext}`, fmt.label, [ext]);
    if (!path) return;
    const output = new RegExp(`\\.${ext}$`, "i").test(path) ? path : `${path}.${ext}`;
    const settings: ExportSettings = {
      format: p.format,
      codec,
      width: p.format === "gif" ? gifW : p.height > 0 ? outW : 0,
      height: p.format === "gif" ? gifH : p.height > 0 ? outH : 0,
      fps: p.format === "gif" && p.fps === 0 ? Math.min(15, pfps) : p.fps,
      quality: p.quality,
      hardware: hwAvailable && p.hardware && codec !== "prores",
      audioBitrate: p.audioBitrate,
      normalizeAudio: p.normalizeAudio,
    };
    setBusy(true);
    await startExport(output, settings, used === "range" ? [range!.in, range!.out] : used === "picture" ? [0, picture] : null);
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldRow label="Format">
          <Select className="flex-1" value={p.format} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} onChange={(format) => set({ format })} />
        </FieldRow>
        {canCodec && (
          <FieldRow label="Codec">
            <Segmented
              className="flex-1"
              value={codec}
              onChange={(c) => set({ codec: c })}
              options={[
                { value: "h264", label: "H.264", title: "Plays everywhere" },
                { value: "hevc", label: "HEVC", title: "Smaller files, newer devices" },
                ...(p.format === "mov" ? [{ value: "prores" as const, label: "ProRes", title: "Editing-grade, very large files" }] : []),
              ]}
            />
          </FieldRow>
        )}
        {isVideo && (
          <>
            <FieldRow label="Resolution">
              <Select
                className="flex-1"
                value={p.height}
                options={heights.map((h) => ({
                  value: h,
                  label: h === 0 ? (p.format === "gif" ? `Auto (${gifW}×${gifH})` : `Project (${pw}×${ph})`) : `${even((pw * h) / ph)}×${h}`,
                }))}
                onChange={(height) => set({ height })}
              />
            </FieldRow>
            <FieldRow label="Frame rate">
              <Select
                className="flex-1"
                value={p.fps}
                options={[{ value: 0, label: `Project (${fpsLabel(pfps)} fps)` }, ...[10, 12, 15, ...FPS_OPTIONS].map((f) => ({ value: f, label: `${fpsLabel(f)} fps` }))]}
                onChange={(fps) => set({ fps })}
              />
            </FieldRow>
          </>
        )}
        {codec !== "prores" && p.format !== "wav" && (
          <FieldRow label="Quality">
            <Segmented
              className="flex-1"
              value={p.quality}
              onChange={(quality) => set({ quality })}
              options={[
                { value: "low", label: "Smaller" },
                { value: "medium", label: "Balanced" },
                { value: "high", label: "Best" },
              ]}
            />
          </FieldRow>
        )}
        {fmt.value !== "gif" && (
          <FieldRow label="Audio" hint="Evens out loudness to the streaming standard (−14 LUFS)">
            <Switch checked={p.normalizeAudio} onChange={(normalizeAudio) => set({ normalizeAudio })} label="Normalise loudness" />
          </FieldRow>
        )}
        {isVideo && hwAvailable && canCodec && codec !== "prores" && (
          <FieldRow label="Encoder">
            <Switch checked={p.hardware} onChange={(hardware) => set({ hardware })} label="Hardware accelerated (faster)" />
          </FieldRow>
        )}
        <FieldRow label="Range">
          <Segmented
            className="flex-1"
            value={used}
            onChange={setMode}
            options={[
              { value: "all", label: `Whole timeline · ${fmtDuration(total)}` },
              ...(overhang && !isAudio ? [{ value: "picture" as const, label: `Picture · ${fmtDuration(picture)}`, title: "Stop where the last video clip or title ends" }] : []),
              ...(range ? [{ value: "range" as const, label: `In → Out · ${fmtDuration(range.out - range.in)}` }] : []),
            ]}
          />
        </FieldRow>
        {overhang > 0 && !isAudio && used === "all" && (
          <div className="ml-[88px] flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-2xs leading-relaxed text-ink-muted">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="flex-1">
              The audio runs {seconds(overhang)} past the picture, so the video ends on black.{" "}
              <button className="font-semibold text-accent-ink hover:text-white" onClick={trimAudio}>
                Trim audio to the picture
              </button>
            </span>
          </div>
        )}
        {used === "picture" && <p className="pl-[88px] text-2xs text-ink-dim">Audio after {fmtDuration(picture)} is left out.</p>}
        {!range && used !== "picture" && !overhang && <p className="pl-[88px] text-2xs text-ink-dim">Tip: set an in/out range with I and O to export just a part.</p>}
      </div>

      <div className="flex items-center justify-between rounded-lg border border-line bg-bg px-3 py-2.5">
        <div className="text-xs text-ink-muted">
          {isAudio ? "Audio only" : `${p.format === "gif" ? gifW : outW}×${p.format === "gif" ? gifH : outH}`} · {seconds(span)}
        </div>
        <Button variant="primary" size="lg" disabled={busy || span <= 0.01} onClick={go}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
          Export…
        </Button>
      </div>
      {total <= 0 && <p className="text-xs text-danger">The timeline is empty — add some clips first.</p>}
    </div>
  );
}

function Progress() {
  const job = useExportJob((s) => s.job)!;
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const cancelled = job.status === "cancelled";
  const reset = () => useExportJob.getState().set(null);
  const eta = job.eta != null && job.eta >= 0 ? job.eta : null;
  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center gap-3">
        {done ? (
          <CheckCircle2 className="h-8 w-8 text-success" />
        ) : failed || cancelled ? (
          <XCircle className="h-8 w-8 text-danger" />
        ) : (
          <Loader2 className="h-8 w-8 animate-spin text-accent-ink" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-md font-semibold text-ink">
            {done ? "Export finished" : failed ? "Export failed" : cancelled ? "Export cancelled" : "Exporting…"}
          </div>
          <div className="truncate text-xs text-ink-dim" title={job.output}>
            {basename(job.output)}
          </div>
        </div>
        {!done && !failed && !cancelled && <div className="font-mono text-lg text-ink tabular">{Math.floor(job.progress)}%</div>}
      </div>

      {!failed && !cancelled && (
        <div className="h-2 overflow-hidden rounded-full bg-bg">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${done ? 100 : job.progress}%` }} />
        </div>
      )}

      {!done && !failed && !cancelled && (
        <div className="flex justify-between text-xs text-ink-dim">
          <span>{job.speed ? `${job.speed.toFixed(1)}× realtime` : "Starting…"}</span>
          <span>{eta != null ? `about ${fmtDuration(Math.max(1, eta))} left` : ""}</span>
        </div>
      )}
      {done && job.elapsed != null && <p className="text-xs text-ink-dim">Took {seconds(job.elapsed)}.</p>}
      {failed && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/5 p-2.5 font-mono text-2xs text-danger">
          {job.error ?? "Unknown error"}
        </pre>
      )}

      <div className="flex justify-end gap-2">
        {!done && !failed && !cancelled ? (
          <Button variant="danger" onClick={cancelExport}>
            Cancel export
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={reset}>
              {done ? "Export again" : "Back"}
            </Button>
            {done && (
              <>
                <Button onClick={() => revealInFolder(job.output).catch((e) => store().toast(String(e), "error"))}>
                  <FolderOpen className="h-4 w-4" /> Show in folder
                </Button>
                <Button variant="primary" onClick={() => openPath(job.output).catch((e) => store().toast(firstLine(String(e)), "error"))}>
                  <Play className="h-4 w-4 fill-current" /> Play
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Save the frame under the playhead as a PNG at project resolution. */
export async function exportFrame() {
  const s = store();
  if (projectDuration(s.project) <= 0) {
    s.toast("Nothing to capture — the timeline is empty.", "info");
    return;
  }
  const fps = s.project.settings.fps || 30;
  const t = Math.min(s.playhead, Math.max(0, projectDuration(s.project) - 1 / fps));
  const frame = Math.round(t * fps);
  const path = await pickSavePath("Save frame", `${s.project.name || "Frame"} ${frame}.png`, "PNG image", ["png"]);
  if (!path) return;
  const output = /\.png$/i.test(path) ? path : `${path}.png`;
  const settings: ExportSettings = { format: "png", codec: "h264", width: 0, height: 0, fps: 0, quality: "high", hardware: false, audioBitrate: 192, normalizeAudio: false };
  await startExport(output, settings, [t, t + 1 / fps], true);
}
