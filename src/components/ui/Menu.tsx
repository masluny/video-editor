import * as React from "react";
import { create } from "zustand";
import { cn } from "../../lib/cn";

export type MenuItem =
  | { separator: true }
  | {
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  open: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));

export const openMenu = (e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) => {
  e.preventDefault?.();
  e.stopPropagation?.();
  useMenu.getState().open(e.clientX, e.clientY, items);
};

/** Renders the active context menu (one at a time, app-wide). */
export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const close = useMenu((s) => s.close);
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y;
    setPos({ x: Math.max(8, x), y });
  }, [menu]);

  React.useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onBlur = () => close();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[90] min-w-[200px] max-w-[300px] animate-popIn rounded-lg border border-line-strong bg-panel-2/98 p-1 shadow-pop backdrop-blur-xl"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        "separator" in item ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className={cn("menu-item", item.danger && "text-danger hover:bg-danger/12")}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center", item.danger ? "text-danger" : "text-ink-muted")}>
              {item.checked !== undefined ? (item.checked ? "✓" : "") : item.icon}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="shrink-0 whitespace-nowrap pl-4 font-mono text-2xs text-ink-dim">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
