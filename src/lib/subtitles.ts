// SubRip (.srt) and WebVTT (.vtt) captions: parsed into cues on import, written back
// out of a captions track.

import type { Track } from "./types";
import { clipEnd, sortClips } from "./timeline";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export const isSubtitlePath = (path: string) => /\.(srt|vtt)$/i.test(path);

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function seconds(stamp: string): number | null {
  const m = TIME.exec(stamp);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** Strip markup: <i>, <font …>, VTT voice/class tags and ASS overrides like {\an8}. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Cues of an SRT or WebVTT file, sorted by start; malformed blocks are skipped. */
export function parseSubtitles(source: string): Cue[] {
  const blocks = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // header, NOTE, STYLE, or junk
    const [a, b] = lines[at].split("-->");
    const start = seconds(a);
    const end = seconds(b ?? "");
    const text = plain(lines.slice(at + 1).join("\n"));
    if (start == null || end == null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** SRT timestamp, e.g. 00:01:02,345. */
export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** The title clips of a track as cues, in timeline time. */
export function captionsOf(track: Track): Cue[] {
  return sortClips(track.clips.filter((c) => c.type === "title" && c.title?.text.trim())).map((c) => ({ start: c.start, end: clipEnd(c), text: c.title!.text.trim() }));
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}
