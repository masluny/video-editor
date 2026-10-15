import * as React from "react";
import { cn } from "../../lib/cn";

export interface NumberFieldProps {
  value: number;
  onChange: (v: number, opts: { live: boolean }) => void;
  /** Called when a drag/scrub or text edit ends (commit point for undo). */
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  /** Value shown = value * displayScale (e.g. 100 for percentages). */
  displayScale?: number;
  precision?: number;
  suffix?: string;
  label?: string;
  className?: string;
  title?: string;
}

/**
 * A compact numeric input. Drag horizontally on the label (or the field while not
 * focused) to scrub; click to type. Shift = coarse, Alt = fine.
 */
export function NumberField({
  value,
  onChange,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  displayScale = 1,
  precision,
  suffix,
  label,
  className,
  title,
}: NumberFieldProps) {
  const places = precision ?? (step * displayScale < 0.1 ? 2 : step * displayScale < 1 ? 1 : 0);
  const fmt = (v: number) => (Number.isFinite(v) ? (v * displayScale).toFixed(places) : "0");
  const [draft, setDraft] = React.useState(fmt(value));
  const [editing, setEditing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!editing) setDraft(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing, places, displayScale]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = value;
    let moved = false;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const unit = step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      onChange(clamp(startVal + Math.round(dx / 2) * unit), { live: true });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (moved) onCommit?.();
      else {
        setEditing(true);
        requestAnimationFrame(() => inputRef.current?.select());
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const commitDraft = () => {
    setEditing(false);
    const parsed = parseFloat(draft.replace(",", "."));
    if (Number.isFinite(parsed)) {
      const v = clamp(parsed / displayScale);
      if (Math.abs(v - value) > 1e-9) {
        onChange(v, { live: false });
      }
    }
    setDraft(fmt(value));
    onCommit?.();
  };

  return (
    <div
      className={cn(
        "group relative flex h-7 min-w-0 items-center rounded-md border border-line bg-bg text-sm transition-colors hover:border-line-strong",
        editing && "border-accent ring-2 ring-accent/25",
        className,
      )}
      title={title}
    >
      {label && (
        <span onPointerDown={startScrub} className="flex h-full cursor-ew-resize select-none items-center pl-2 pr-1 text-2xs font-medium text-ink-dim group-hover:text-ink-muted">
          {label}
        </span>
      )}
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(fmt(value));
              setEditing(false);
            }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
              const v = clamp(value + d);
              onChange(v, { live: false });
              setDraft(fmt(v));
            }
          }}
          className="h-full w-full min-w-0 bg-transparent px-2 text-right font-mono text-xs tabular text-ink outline-none"
        />
      ) : (
        <span
          onPointerDown={startScrub}
          className="flex h-full min-w-0 flex-1 cursor-ew-resize items-center justify-end truncate px-2 font-mono text-xs tabular text-ink"
        >
          {draft}
          {suffix && <span className="ml-0.5 text-ink-dim">{suffix}</span>}
        </span>
      )}
    </div>
  );
}

export interface SliderFieldProps extends Omit<NumberFieldProps, "label" | "className"> {
  label: string;
  /** Value the double-click on the label resets to. */
  defaultValue?: number;
  sliderMin?: number;
  sliderMax?: number;
  /** Shown after the number (e.g. a keyframe button). */
  trailing?: React.ReactNode;
}

/** Labelled slider + numeric field; double-click the label to reset. */
export function SliderField({ label, defaultValue, sliderMin, sliderMax, trailing, ...num }: SliderFieldProps) {
  const lo = sliderMin ?? num.min ?? 0;
  const hi = sliderMax ?? num.max ?? 1;
  const fill = `${Math.max(0, Math.min(1, (num.value - lo) / (hi - lo || 1))) * 100}%`;
  const changed = defaultValue !== undefined && Math.abs(num.value - defaultValue) > 1e-6;
  return (
    <div className="flex h-7 items-center gap-2.5">
      <button
        type="button"
        className={cn("w-[76px] shrink-0 truncate text-left text-xs", changed ? "text-ink" : "text-ink-muted", defaultValue !== undefined && "hover:text-accent-ink")}
        title={defaultValue !== undefined ? "Double-click to reset" : undefined}
        onDoubleClick={() => {
          if (defaultValue === undefined) return;
          num.onChange(defaultValue, { live: false });
          num.onCommit?.();
        }}
      >
        {label}
        {changed && <span className="ml-1 inline-block h-1 w-1 -translate-y-0.5 rounded-full bg-accent" />}
      </button>
      <input
        type="range"
        className="range min-w-0 flex-1"
        min={lo}
        max={hi}
        step={num.step ?? 0.01}
        value={Math.max(lo, Math.min(hi, num.value))}
        style={{ ["--fill" as string]: fill }}
        onChange={(e) => num.onChange(parseFloat(e.target.value), { live: true })}
        onPointerUp={() => num.onCommit?.()}
        onKeyUp={() => num.onCommit?.()}
      />
      <NumberField {...num} className="w-[68px] shrink-0" />
      {trailing}
    </div>
  );
}
