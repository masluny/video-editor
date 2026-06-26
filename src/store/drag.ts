import { create } from "zustand";
import type { Id } from "../lib/types";

export type DragPayload =
  | { kind: "media"; mediaId: Id }
  | { kind: "title"; presetId: string }
  /** Files dragged in from the OS (paths only known on drop). */
  | { kind: "files"; count: number };

interface DragState {
  payload: DragPayload | null;
  x: number;
  y: number;
  /** Cmd/Ctrl held: insert (ripple) instead of overwrite. */
  insert: boolean;
  label: string;
  start: (payload: DragPayload, x: number, y: number, label: string) => void;
  move: (x: number, y: number, insert: boolean) => void;
  end: () => void;
}

export const useDrag = create<DragState>((set) => ({
  payload: null,
  x: 0,
  y: 0,
  insert: false,
  label: "",
  start: (payload, x, y, label) => set({ payload, x, y, label, insert: false }),
  move: (x, y, insert) => set({ x, y, insert }),
  end: () => set({ payload: null }),
}));

/**
 * Pointer-based drag (HTML5 drag & drop is unreliable inside desktop webviews).
 * Call from a pointerdown handler; the drag only starts after a small movement so
 * plain clicks still work. `onDrop` receives the final client coordinates.
 */
export function beginPointerDrag(
  e: React.PointerEvent,
  payload: DragPayload,
  label: string,
  onDrop: (x: number, y: number, insert: boolean) => void,
) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let active = false;
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!active) {
      active = true;
      useDrag.getState().start(payload, ev.clientX, ev.clientY, label);
      document.body.style.cursor = "grabbing";
    }
    useDrag.getState().move(ev.clientX, ev.clientY, ev.metaKey || ev.ctrlKey);
  };
  const finish = (ev: PointerEvent, cancelled: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", esc, true);
    document.body.style.cursor = "";
    if (active) {
      useDrag.getState().end();
      if (!cancelled) onDrop(ev.clientX, ev.clientY, ev.metaKey || ev.ctrlKey);
    }
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const cancel = (ev: PointerEvent) => finish(ev, true);
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && active) {
      ev.stopPropagation();
      finish(new PointerEvent("pointerup"), true);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", esc, true);
}
