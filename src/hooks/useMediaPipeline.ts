import * as React from "react";
import type { MediaAsset } from "../lib/types";
import { backend, fileUrl, onEvent } from "../lib/backend";
import { store, useStore } from "../store/store";

// Containers/codecs desktop webviews can't play; these get a preview proxy right away.
const PROXY_EXT = new Set(["mkv", "avi", "flv", "wmv", "mpg", "mpeg", "mts", "m2ts", "ts", "3gp", "mxf", "ogv", "vob", "wma", "divx", "f4v", "asf", "rm", "rmvb"]);
const PROXY_CODECS = new Set(["mpeg2video", "mpeg1video", "mpeg4", "msmpeg4v3", "msmpeg4v2", "wmv1", "wmv2", "wmv3", "vc1", "theora", "dnxhd", "cfhd", "rawvideo", "huffyuv", "ffv1", "flv1", "h263", "wmav2", "wmapro", "ac3", "eac3", "dts", "truehd"]);

function extOf(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function obviouslyUnplayable(m: MediaAsset): boolean {
  return PROXY_EXT.has(extOf(m.path)) || PROXY_CODECS.has(m.videoCodec ?? "") || PROXY_CODECS.has(m.audioCodec ?? "");
}

/** Ask the webview itself whether it can decode the file. */
function canPlay(m: MediaAsset): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement(m.hasVideo ? "video" : "audio");
    el.muted = true;
    el.preload = "auto";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 10000);
    el.addEventListener("error", () => finish(false));
    if (el instanceof HTMLVideoElement) el.addEventListener("loadeddata", () => finish(el.videoWidth > 0));
    else el.addEventListener("loadedmetadata", () => finish(Number.isFinite(el.duration) || el.duration === Infinity));
    el.src = fileUrl(m.path);
  });
}

const started = new Set<string>();
let running = 0;
const queue: (() => Promise<void>)[] = [];
let proxyChain: Promise<unknown> = Promise.resolve();

function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

function requestProxy(m: MediaAsset) {
  const set = (patch: Parameters<ReturnType<typeof store>["setRuntime"]>[1]) => store().setRuntime(m.id, patch);
  set({ needsProxy: true, proxyProgress: 0, proxyError: undefined });
  // One proxy at a time: they are CPU-heavy and the first one should finish fast.
  proxyChain = proxyChain.then(() =>
    backend
      .proxy(m.path, m.duration, m.hasVideo)
      .then((proxy) => set({ proxy, proxyProgress: 100 }))
      .catch((e) => {
        set({ proxyError: String(e) });
        store().toast(`Couldn't prepare a preview for “${m.name}”: ${String(e).split("\n")[0]}`, "error");
      }),
  );
}

async function analyze(m: MediaAsset) {
  const set = (patch: Parameters<ReturnType<typeof store>["setRuntime"]>[1]) => store().setRuntime(m.id, patch);
  const exists = await backend.pathsExist([m.path]).then((r) => r[0], () => true);
  if (!exists) {
    set({ missing: true });
    return;
  }
  set({ missing: false });

  const work: Promise<unknown>[] = [];
  if (m.hasVideo) {
    const count = m.kind === "image" ? 1 : Math.max(6, Math.min(60, Math.round(m.duration / 2)));
    work.push(backend.thumbnails(m.path, m.duration, count, 144).then((thumbs) => set({ thumbs }), () => {}));
  }
  if (m.hasAudio && m.kind !== "image") {
    work.push(backend.waveform(m.path, m.duration).then((waveform) => set({ waveform }), () => {}));
  }
  if (m.kind !== "image") {
    if (obviouslyUnplayable(m)) requestProxy(m);
    else work.push(canPlay(m).then((ok) => !ok && requestProxy(m)));
  }
  await Promise.all(work);
}

/** Keeps thumbnails, waveforms, proxies and "missing file" state in sync with the project's media. */
export function useMediaPipeline() {
  const media = useStore((s) => s.project.media);

  React.useEffect(() => {
    for (const m of media) {
      const key = `${m.id}|${m.path}`;
      if (started.has(key)) continue;
      started.add(key);
      queue.push(() => analyze(m));
    }
    pump();
  }, [media]);

  React.useEffect(
    () =>
      onEvent<{ path: string; progress: number }>("proxy-progress", ({ path, progress }) => {
        for (const m of store().project.media) if (m.path === path) store().setRuntime(m.id, { proxyProgress: progress });
      }),
    [],
  );
}

/** Forget cached analysis for a media item (after relinking). */
export function reanalyze(m: MediaAsset) {
  started.delete(`${m.id}|${m.path}`);
}
