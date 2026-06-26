import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "./controls";

export function Modal({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  width = 520,
  dismissable = true,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  dismissable?: boolean;
}) {
  const panel = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Move focus into the dialog for keyboard users.
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    first?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, dismissable]);

  return (
    <div
      className="fixed inset-0 z-[70] flex animate-fadeIn items-center justify-center bg-black/60 p-6 backdrop-blur-[3px]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className="flex max-h-full w-full animate-popIn flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-pop"
        style={{ maxWidth: width }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3.5">
          {icon && <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/14 text-accent-ink">{icon}</div>}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-md font-semibold text-ink">{title}</h2>
            {subtitle && <p className="truncate text-xs text-ink-dim">{subtitle}</p>}
          </div>
          {dismissable && (
            <IconButton data-close onClick={onClose} title="Close (Esc)">
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </header>
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4")}>{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel-2/60 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
