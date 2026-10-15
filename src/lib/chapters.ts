// YouTube chapters from timeline markers: a "0:00 Intro" list for the video description.
// YouTube shows chapters only when the first starts at 0:00, there are at least three,
// and each lasts at least 10 seconds; anything that breaks those rules is reported.

import type { Marker } from "./types";

export const MIN_CHAPTER = 10;

/** 0:00, 1:05, 1:02:03 (whole seconds, rounded down). */
export function chapterTime(t: number): string {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export interface Chapters {
  text: string;
  count: number;
  /** Why YouTube wouldn't show them, in plain words; empty when it will. */
  problems: string[];
}

/**
 * Chapters from the named markers (or every marker, when none is named) before `duration`.
 * A chapter is added at 0:00 when no marker sits there.
 */
export function youtubeChapters(markers: Marker[], duration: number): Chapters {
  const named = markers.filter((m) => m.label.trim());
  const used = (named.length ? named : markers).filter((m) => m.time < duration - 1e-6).sort((a, b) => a.time - b.time);
  const list = used.map((m, i) => ({ time: Math.floor(m.time + 1e-6), title: m.label.trim() || `Chapter ${i + 1}` }));
  if (!list.length || list[0].time > 0) list.unshift({ time: 0, title: "Intro" });
  // Markers within the same second would print the same time: keep the first.
  const chapters = list.filter((c, i) => i === 0 || c.time > list[i - 1].time);
  const problems: string[] = [];
  if (chapters.length < 3) problems.push(`YouTube needs at least 3 chapters; there ${chapters.length === 1 ? "is 1" : `are ${chapters.length}`}. Add markers (M) where sections begin.`);
  const short = chapters.filter((c, i) => (i + 1 < chapters.length ? chapters[i + 1].time : duration) - c.time < MIN_CHAPTER);
  if (short.length)
    problems.push(`Chapters must last at least ${MIN_CHAPTER} seconds: ${short.map((c) => `“${c.title}” (${chapterTime(c.time)})`).join(", ")} ${short.length > 1 ? "are" : "is"} shorter.`);
  return { text: chapters.map((c) => `${chapterTime(c.time)} ${c.title}`).join("\n"), count: chapters.length, problems };
}
