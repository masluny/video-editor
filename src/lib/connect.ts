// Connected clips, for the magnetic main track: titles, B-roll and other clips on the video
// tracks above V1 stay with the V1 clip they sit on. After an edit that moves a V1 clip's
// picture in time (a reorder, a ripple, a freeze frame pushing the rest along), every clip
// above that started over it moves by as much, unless it was moved itself in that edit.
// Sound isn't connected: music keeps its timing (detached audio has its own link).

import type { Id, Project } from "./types";
import { clipEnd, EPS, pictureShift, sortClips } from "./timeline";

export function followMain(prev: Project, next: Project, mainId: Id | null): Project {
  if (!mainId || prev === next) return next;
  const [mainBefore, mainAfter] = [prev.tracks.find((t) => t.id === mainId), next.tracks.find((t) => t.id === mainId)];
  if (!mainBefore || !mainAfter || mainBefore.clips === mainAfter.clips) return next;
  const after = new Map(mainAfter.clips.map((c) => [c.id, c]));
  const before = new Map(prev.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  const shifts = new Map<Id, number>();
  for (const t of next.tracks) {
    if (t.kind !== "video" || t.id === mainId) continue;
    for (const c of t.clips) {
      const was = before.get(c.id);
      if (!was || Math.abs(pictureShift(was, c)) > EPS) continue; // new, or moved itself
      const anchor = mainBefore.clips.find((m) => was.start >= m.start - EPS && was.start < clipEnd(m) - EPS);
      const now = anchor && after.get(anchor.id);
      const d = anchor && now ? pictureShift(anchor, now) : 0;
      if (Math.abs(d) > EPS) shifts.set(c.id, d);
    }
  }
  if (!shifts.size) return next;
  return {
    ...next,
    tracks: next.tracks.map((t) =>
      t.clips.some((c) => shifts.has(c.id)) ? { ...t, clips: sortClips(t.clips.map((c) => (shifts.has(c.id) ? { ...c, start: Math.max(0, c.start + shifts.get(c.id)!) } : c))) } : t,
    ),
  };
}
