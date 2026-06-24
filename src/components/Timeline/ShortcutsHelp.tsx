import { X, Keyboard } from "lucide-react";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Playback",
    items: [
      ["Space", "Play / pause"],
      ["J / K / L", "Shuttle reverse / pause / forward (2×, 4×)"],
      ["← / →", "Step 1 frame"],
      ["⇧← / ⇧→", "Step 1 second"],
      ["↑ / ↓", "Previous / next edit point"],
      ["Home / End", "Go to start / end"],
    ],
  },
  {
    title: "Editing",
    items: [
      ["V", "Selection tool"],
      ["B", "Razor (blade) tool"],
      ["S", "Toggle snapping"],
      ["⌘K", "Split at playhead"],
      ["⌫", "Delete (leave gap)"],
      ["⇧⌫", "Ripple delete (close gap)"],
      ["Shift-click", "Add to selection"],
    ],
  },
  {
    title: "Source / Clip",
    items: [
      ["C", "Open clip trimmer for selected"],
      ["I / O", "Set in / out (in trimmer)"],
      [", / .", "Insert / overwrite at playhead"],
      ["Enter", "Add trimmed clip"],
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
      ["?", "Toggle this help"],
    ],
  },
];

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="w-[min(720px,92vw)] bg-surface border border-border rounded-2xl shadow-panel overflow-hidden animate-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 h-14 border-b border-border">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/15 text-accent">
            <Keyboard className="w-4 h-4" />
          </div>
          <div className="flex-1 text-sm font-semibold text-text">Keyboard shortcuts</div>
          <button className="btn-icon" onClick={onClose} title="Close (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 p-6">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-text-muted mb-2">{g.title}</h4>
              <ul className="space-y-1.5">
                {g.items.map(([key, label]) => (
                  <li key={key} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-text-muted">{label}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-bg-secondary border border-border font-mono text-2xs text-text whitespace-nowrap">{key}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
