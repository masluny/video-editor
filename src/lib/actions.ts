// Document-level actions shared by the top bar, menus and keyboard shortcuts.

import type { Clip, Id, MediaAsset } from "./types";
import { backend, confirmDialog, fileUrl, pickMedia, pickProjectToOpen, pickSavePath } from "./backend";
import { migrateProject } from "./migrate";
import { uid } from "./uid";
import { basename, stripExtension } from "./format";
import { clipDuration, speedOf } from "./timeline";
import { isDirty, store, findClip, useStore } from "../store/store";
import { captionsOf, isSubtitlePath, parseSubtitles, toSrt } from "./subtitles";
import { BEAT_RATE, beatsFromPeaks, detectBeats, mono, toBeatRate, type Beats } from "./beats";
import { forgetProject, rememberProject } from "./recent";

export async function importFiles(paths: string[], place?: { trackId?: Id; at: number }): Promise<MediaAsset[]> {
  // Subtitle files become a captions track; everything else is probed as media.
  const subs = paths.filter(isSubtitlePath);
  for (const path of subs) await importCaptions(path, place?.at ?? 0);
  paths = paths.filter((p) => !isSubtitlePath(p));
  if (!paths.length) return [];
  const s = store();
  let outcomes;
  try {
    outcomes = await backend.probe(paths);
  } catch (e) {
    s.toast(String(e), "error");
    return [];
  }
  const ok = outcomes.filter((o) => o.info);
  const failed = outcomes.filter((o) => !o.info);
  const assets = s.addMedia(ok.map((o) => ({ ...(o.info as Omit<MediaAsset, "id">), id: uid() })));

  if (failed.length) {
    const list = failed.slice(0, 4).map((f) => `• ${basename(f.path)} — ${f.error ?? "unsupported"}`).join("\n");
    s.toast(`Couldn't import ${failed.length} file${failed.length > 1 ? "s" : ""}:\n${list}${failed.length > 4 ? "\n…" : ""}`, "error");
  }
  if (place && assets.length) {
    let at = place.at;
    for (const a of assets) {
      const clipId = store().placeMedia(a.id, { trackId: place.trackId, at });
      const hit = clipId ? findClip(store().project, clipId) : null;
      if (hit) at = hit.clip.start + clipDuration(hit.clip);
    }
  } else if (assets.length && !failed.length) {
    s.toast(`Imported ${assets.length} item${assets.length > 1 ? "s" : ""}. Drag to the timeline or press ⏎ to add at the playhead.`, "success");
  }
  return assets;
}

async function importCaptions(path: string, offset: number) {
  const s = store();
  try {
    const n = s.addCaptions(parseSubtitles(await backend.readText(path)), offset);
    if (n) s.toast(`Added ${n} caption${n > 1 ? "s" : ""} from “${basename(path)}” on a new Captions track. Select one to restyle it.`, "success");
    else s.toast(`No captions found in “${basename(path)}”.`, "error");
  } catch (e) {
    s.toast(`Couldn't read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Save the titles on a track as an .srt file (for YouTube, players, translators). */
export async function exportCaptions(trackId: Id) {
  const s = store();
  const track = s.project.tracks.find((t) => t.id === trackId);
  const cues = track ? captionsOf(track) : [];
  if (!cues.length) {
    s.toast("This track has no titles to save as captions.", "info");
    return;
  }
  const path = await pickSavePath("Export captions", `${stripExtension(s.project.name || "Captions")}.srt`, "SubRip subtitles", ["srt"]);
  if (!path) return;
  const out = /\.srt$/i.test(path) ? path : `${path}.srt`;
  try {
    await backend.writeText(out, toSrt(cues));
    s.toast(`Saved ${cues.length} caption${cues.length > 1 ? "s" : ""} to ${basename(out)}.`, "success");
  } catch (e) {
    s.toast(`Couldn't save captions: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Lower music under the speech on other tracks, with feedback. */
export function duckUnderVoice(ids: Id[]) {
  const s = store();
  const n = s.duckUnderVoice(ids);
  if (n < 0) s.toast("Still reading the sound of your clips. Try again in a moment.", "info");
  else if (n === 0) s.toast("No speech or other sound found on the other tracks to duck under.", "info");
  else s.toast(`Lowered ${n > 1 ? `${n} clips` : "the music"} under speech. The line on the clip shows its volume.`, "success");
}

/** Beats in a clip's source range (seconds after its `in`): decoded audio, else the waveform. */
async function clipBeats(c: Clip, media: MediaAsset, path: string): Promise<Beats> {
  try {
    const data = await (await fetch(fileUrl(path))).arrayBuffer();
    let ctx: OfflineAudioContext;
    try {
      ctx = new OfflineAudioContext(1, 1, BEAT_RATE);
    } catch {
      ctx = new OfflineAudioContext(1, 1, 44100); // some WebKits only decode at common rates
    }
    const audio = await ctx.decodeAudioData(data);
    const [a, b] = [Math.floor(c.in * audio.sampleRate), Math.min(audio.length, Math.ceil(c.out * audio.sampleRate))];
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).subarray(a, b));
    const beats = detectBeats(toBeatRate(mono(channels), audio.sampleRate));
    return { ...beats, times: beats.times.map((t) => t + a / audio.sampleRate - c.in) };
  } catch (e) {
    // The webview can't fetch or decode it: fall back on the waveform the app computed.
    const wf = store().runtime[media.id]?.waveform;
    if (!wf) throw e;
    const first = Math.floor(c.in * wf.rate);
    const beats = beatsFromPeaks(wf.peaks.slice(first, Math.ceil(c.out * wf.rate)).map((v) => v / 255), wf.rate);
    return { ...beats, times: beats.times.map((t) => t + first / wf.rate - c.in) };
  }
}

/** Find the beat of a clip's sound and put a marker on every `every`-th beat. */
export async function addBeatMarkers(clipId: Id, every = 1) {
  const s = store();
  const hit = findClip(s.project, clipId);
  const media = hit?.clip.mediaId ? s.project.media.find((m) => m.id === hit.clip.mediaId) : undefined;
  if (!hit || !media?.hasAudio) return;
  const rt = s.runtime[media.id];
  const path = rt?.needsProxy ? rt.proxy : media.path;
  if (!path || rt?.missing) {
    s.toast("This clip's sound isn't available yet. Try again once its preview is ready.", "info");
    return;
  }
  const busy = s.toast("Listening for the beat…", "info");
  try {
    const c = hit.clip;
    const { bpm, times } = await clipBeats(c, media, path);
    const at = times.filter((_, i) => i % every === 0).map((t) => c.start + t / speedOf(c)).filter((t) => t >= c.start && t <= c.start + clipDuration(c));
    const n = store().addMarkers(at);
    s.dismissToast(busy);
    if (n) s.toast(`Added ${n} beat marker${n > 1 ? "s" : ""} at ${Math.round(bpm * speedOf(c))} BPM. Clip edges now snap to the beat.`, "success");
    else s.toast("Couldn't find a steady beat in this clip.", "info");
  } catch (e) {
    s.dismissToast(busy);
    s.toast(`Couldn't analyse the sound: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function importViaDialog() {
  const paths = await pickMedia();
  if (paths.length) await importFiles(paths);
}

async function confirmDiscard(): Promise<boolean> {
  const s = store();
  if (!isDirty(s) || !hasContent()) return true;
  return confirmDialog(`“${s.project.name}” has unsaved changes. Discard them?`, "Unsaved changes", "Discard", "Cancel");
}

function hasContent() {
  const p = store().project;
  return p.media.length > 0 || p.tracks.some((t) => t.clips.length > 0);
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  store().newProject();
  backend.autosaveClear().catch(() => {});
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  const file = path ?? (await pickProjectToOpen());
  if (!file) return;
  try {
    const text = await backend.readText(file);
    const project = migrateProject(JSON.parse(text));
    if (!path && project.name === "Untitled") project.name = stripExtension(basename(file));
    store().loadProject(project, file);
    rememberProject(file);
    backend.autosaveClear().catch(() => {});
    await reportMissing();
  } catch (e) {
    if (path) forgetProject(path);
    store().toast(`Couldn't open project: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function reportMissing() {
  const media = store().project.media;
  if (!media.length) return;
  const exists = await backend.pathsExist(media.map((m) => m.path)).catch(() => media.map(() => true));
  const missing = media.filter((_, i) => !exists[i]);
  if (missing.length)
    store().toast(
      `${missing.length} media file${missing.length > 1 ? "s are" : " is"} missing (moved or deleted). Right-click ${missing.length > 1 ? "them" : "it"} in the library to relink.`,
      "error",
    );
}

export function serialize(): string {
  return JSON.stringify(store().project, null, 2);
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = store();
  let path = s.filePath;
  if (!path || saveAs) {
    path = await pickSavePath("Save project", `${s.project.name || "Untitled"}.vproj`, "Revind project", ["vproj"]);
    if (!path) return false;
    if (!/\.vproj$/i.test(path)) path += ".vproj";
  }
  try {
    // Name the project after its file the first time it is saved.
    if (s.project.name === "Untitled") s.renameProject(stripExtension(basename(path)));
    const snapshot = store().project;
    await backend.writeText(path, JSON.stringify(snapshot, null, 2));
    // Edits made while writing keep the document dirty.
    useStore.setState({ savedProject: snapshot, filePath: path });
    rememberProject(path);
    backend.autosaveClear().catch(() => {});
    s.toast(`Saved ${basename(path)}`, "success");
    return true;
  } catch (e) {
    s.toast(`Save failed: ${String(e)}`, "error");
    return false;
  }
}

/** Offer to restore an autosave left by a crash or force-quit. */
export async function checkRecovery() {
  const auto = await backend.autosaveRead().catch(() => null);
  if (!auto) return;
  let project;
  try {
    const parsed = JSON.parse(auto.contents);
    project = migrateProject(parsed.project ?? parsed);
    if (!project.media.length && !project.tracks.some((t) => t.clips.length)) return;
    const when = new Date(auto.modified).toLocaleString();
    store().toast(`Found unsaved work from ${when}.`, "info", {
      label: "Restore",
      run: () => {
        store().loadProject(project!, typeof parsed.filePath === "string" ? parsed.filePath : null, { dirty: true });
        reportMissing();
      },
    });
  } catch {
    backend.autosaveClear().catch(() => {});
  }
}
