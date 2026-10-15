import * as React from "react";
import { Search } from "lucide-react";
import { store } from "../../store/store";
import { commands, searchCommands, type Command } from "../../lib/commands";
import { keyLabel } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useLocal } from "../../lib/useLocal";

/** ⌘K: type what you want to do, run it with Enter. */
export function CommandPalette() {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [recent, setRecent] = useLocal<string[]>("revind.recentCommands", []);
  const all = React.useMemo(commands, []);
  // With nothing typed, the actions used lately come first.
  const list = React.useMemo(() => {
    let found = searchCommands(all, query);
    if (!query.trim()) {
      const rank = (c: Command) => (recent.includes(c.id) ? recent.indexOf(c.id) : recent.length);
      found = [...found].sort((a, b) => rank(a) - rank(b));
    }
    // What can run right now comes before what can't, so Enter does something.
    return [...found.filter((c) => !c.blocked?.()), ...found.filter((c) => c.blocked?.())];
  }, [all, query, recent]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const close = () => store().openDialog(null);

  const run = (c: Command | undefined) => {
    if (!c || c.blocked?.()) return;
    const next = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, 5);
    setRecent(next);
    try {
      localStorage.setItem("revind.recentCommands", JSON.stringify(next)); // now: the palette closes before effects run
    } catch {
      /* storage unavailable */
    }
    close(); // first, so commands that open a dialog can
    c.run();
  };

  React.useEffect(() => setActive(0), [query]);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") setActive((i) => Math.min(list.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") run(list[active]);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  };

  return (
    <div className="fixed inset-0 z-[75] flex animate-fadeIn justify-center bg-black/50 px-6 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Search actions" className="flex max-h-[60vh] w-full max-w-[560px] animate-popIn flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-pop">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 text-ink-dim" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What do you want to do? e.g. freeze, duck, blur, dissolve"
            className="h-11 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="kbd">Esc</span>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {list.map((c, i) => {
            const why = c.blocked?.() || "";
            return (
              <button
                key={c.id}
                data-index={i}
                onPointerMove={() => setActive(i)}
                onClick={() => run(c)}
                title={why || undefined}
                className={cn("flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm", i === active ? "bg-accent/15" : "", why ? "text-ink-dim" : "text-ink")}
              >
                <span className="min-w-0 flex-1 truncate">
                  {c.label}
                  {why && i === active && <span className="ml-2 text-2xs text-ink-faint">{why}</span>}
                </span>
                <span className="shrink-0 text-2xs text-ink-faint">{c.group}</span>
                {c.shortcut && <span className="kbd shrink-0">{keyLabel(c.shortcut)}</span>}
              </button>
            );
          })}
          {!list.length && <p className="px-3 py-6 text-center text-xs text-ink-dim">No action matches “{query}”.</p>}
        </div>
      </div>
    </div>
  );
}
