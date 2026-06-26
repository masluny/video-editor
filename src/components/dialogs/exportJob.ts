// Export job state lives outside the dialog so closing it doesn't lose progress.

import { create } from "zustand";
import type { Project } from "../../lib/types";
import { backend, onEvent, revealInFolder, type ExportProgressEvent, type ExportSettings } from "../../lib/backend";
import { titlePngDataUrl } from "../../lib/title";
import { clipEnd } from "../../lib/timeline";
import { store } from "../../store/store";
import { basename } from "../../lib/format";

export interface ExportJob {
  id: string;
  output: string;
  status: ExportProgressEvent["status"];
  progress: number;
  speed?: number;
  eta?: number;
  error?: string;
  elapsed?: number;
  /** Single-frame exports report via toast only. */
  quiet: boolean;
}

interface ExportState {
  job: ExportJob | null;
  set: (job: ExportJob | null) => void;
}

export const useExportJob = create<ExportState>((set) => ({ job: null, set: (job) => set({ job }) }));

let listening = false;
/** Events that arrived before exportStart returned the job id (fast exports). */
const early = new Map<string, ExportProgressEvent>();

function listen() {
  if (listening) return;
  listening = true;
  onEvent<ExportProgressEvent>("export-progress", handle);
}

function handle(e: ExportProgressEvent) {
  const { job, set } = useExportJob.getState();
  if (job && job.id === "") {
    const prev = early.get(e.jobId);
    if (!prev || prev.status === "running") early.set(e.jobId, e);
    return;
  }
  if (!job || job.id !== e.jobId) return;
  const next: ExportJob = {
    ...job,
    status: e.status,
    progress: e.progress ?? job.progress,
    speed: e.speed ?? job.speed,
    eta: e.eta ?? job.eta,
    error: e.error || undefined,
    elapsed: e.elapsed ?? job.elapsed,
    output: e.output ?? job.output,
  };
  set(next);
  const name = basename(next.output);
  const reveal = { label: "Show", run: () => revealInFolder(next.output).catch(() => {}) };
  if (e.status === "completed" && (job.quiet || store().dialog?.kind !== "export")) store().toast(`Exported ${name}`, "success", reveal);
  if (e.status === "failed" && (job.quiet || store().dialog?.kind !== "export")) store().toast(`Export failed: ${firstLine(e.error)}`, "error");
  if (job.quiet && e.status !== "running") set(null);
}

export function firstLine(s?: string) {
  return (s ?? "unknown error").split("\n").find((l) => l.trim()) ?? "unknown error";
}

/** Render every title clip that overlaps the range to a PNG the backend can overlay. */
async function renderTitles(project: Project, range: [number, number] | null): Promise<Record<string, string>> {
  const { width, height } = project.settings;
  const out: Record<string, string> = {};
  for (const t of project.tracks) {
    if (t.kind !== "video" || t.hidden) continue;
    for (const c of t.clips) {
      if (c.type !== "title" || !c.title) continue;
      if (range && (clipEnd(c) <= range[0] || c.start >= range[1])) continue;
      out[c.id] = await titlePngDataUrl(c.title, width, height);
    }
  }
  return out;
}

export async function startExport(output: string, settings: ExportSettings, range: [number, number] | null, quiet = false): Promise<boolean> {
  listen();
  const project = store().project;
  try {
    const titles = await renderTitles(project, range);
    useExportJob.getState().set({ id: "", output, status: "running", progress: 0, quiet });
    const id = await backend.exportStart({ project, output, settings, range, titles });
    useExportJob.getState().set({ id, output, status: "running", progress: 0, quiet });
    const buffered = early.get(id);
    early.clear();
    if (buffered) handle(buffered);
    return true;
  } catch (e) {
    useExportJob.getState().set(quiet ? null : { id: "", output, status: "failed", progress: 0, error: String(e), quiet });
    if (quiet) store().toast(`Export failed: ${firstLine(String(e))}`, "error");
    return false;
  }
}

export function cancelExport() {
  const job = useExportJob.getState().job;
  if (job?.id) backend.exportCancel(job.id).catch(() => {});
}
