import * as React from "react";
import { store } from "../store/store";
import { nextEditPoint, prevEditPoint, projectDuration, snapToFrame } from "../lib/timeline";
import { importViaDialog, newProject, openProject, saveProject } from "../lib/actions";

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || !!t.closest("input, textarea, select"));
}

/** App-wide keyboard shortcuts (see the shortcuts dialog for the list). */
export function useShortcuts() {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      // Document commands work everywhere except while a dialog is open.
      if (mod && !s.dialog) {
        const run = (fn: () => void) => {
          e.preventDefault();
          fn();
        };
        if (k === "s") return run(() => saveProject(e.shiftKey));
        if (k === "o") return run(() => openProject());
        if (k === "n") return run(() => newProject());
        if (k === "i") return run(() => importViaDialog());
        if (k === "e") return run(() => s.openDialog({ kind: "export" }));
      }
      if (s.dialog || typing(e)) return;

      const fps = s.project.settings.fps || 30;
      const handled = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (mod) {
        if (k === "z") return handled(() => (e.shiftKey ? s.redo() : s.undo()));
        if (k === "y") return handled(() => s.redo());
        if (k === "c") return handled(() => s.copy());
        if (k === "x") return handled(() => s.cut());
        if (k === "v") return handled(() => s.paste());
        if (k === "d") return handled(() => s.duplicateClips(s.selection));
        if (k === "a") return handled(() => s.selectAll());
        if (k === "b") return handled(() => s.splitAtPlayhead());
        if (k === "=" || k === "+") return handled(() => s.setZoom(s.zoom * 1.4));
        if (k === "-") return handled(() => s.setZoom(s.zoom / 1.4));
        return;
      }
      if (e.altKey && (k === "x" || e.code === "KeyX")) return handled(() => s.setRange(null));

      switch (e.key) {
        case " ":
          return handled(() => s.togglePlay());
        case "ArrowLeft":
          return handled(() => (s.pause(), s.seek(snapToFrame(s.playhead - (e.shiftKey ? 1 : 1 / fps), fps))));
        case "ArrowRight":
          return handled(() => (s.pause(), s.seek(snapToFrame(s.playhead + (e.shiftKey ? 1 : 1 / fps), fps))));
        case "ArrowUp":
          return handled(() => s.seek(prevEditPoint(s.project.tracks, s.playhead)));
        case "ArrowDown":
          return handled(() => s.seek(nextEditPoint(s.project.tracks, s.playhead)));
        case "Home":
          return handled(() => s.seek(0));
        case "End":
          return handled(() => s.seek(projectDuration(s.project)));
        case "Backspace":
        case "Delete":
          return handled(() => s.deleteClips(s.selection, e.shiftKey));
        case "Escape":
          return handled(() => (s.select([]), s.setTool("select")));
        case "Enter":
          if (s.selectedMedia) return handled(() => s.placeMedia(s.selectedMedia!, { mode: e.shiftKey ? "insert" : "overwrite" }));
          return;
        case "?":
          return handled(() => s.openDialog({ kind: "shortcuts" }));
        case "+":
        case "=":
          return handled(() => s.setZoom(s.zoom * 1.4));
        case "-":
        case "_":
          return handled(() => s.setZoom(s.zoom / 1.4));
      }

      switch (k) {
        case "s":
          return handled(() => s.splitAtPlayhead());
        case "b":
          return handled(() => s.setTool("blade"));
        case "v":
          return handled(() => s.setTool("select"));
        case "a":
          return handled(() => s.setTool("select"));
        case "n":
          return handled(() => s.toggleSnapping());
        case "m":
          return handled(() => s.addMarker());
        case "i":
          return handled(() => s.setRangeIn(snapToFrame(s.playhead, fps)));
        case "o":
          return handled(() => s.setRangeOut(snapToFrame(s.playhead, fps)));
        case "z":
          if (e.shiftKey) return handled(() => document.querySelector<HTMLButtonElement>('[title^="Zoom to fit"]')?.click());
          return;
        case "k":
          return handled(() => s.pause());
        case "l":
          return handled(() => {
            if (s.playing && s.rate > 0) s.setRate(Math.min(8, s.rate * 2));
            else {
              s.setRate(1);
              if (!s.playing) s.play();
            }
          });
        case "j":
          return handled(() => {
            if (s.playing && s.rate < 0) s.setRate(Math.max(-8, s.rate * 2));
            else {
              s.setRate(-1);
              if (!s.playing) s.play();
            }
          });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
