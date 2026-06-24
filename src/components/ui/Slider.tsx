import * as React from "react";
import { cn } from "../../lib/cn";

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "className"> {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  label?: string;
  className?: string;
  precision?: number;
}

export function Slider({ className, min = 0, max = 1, step = 0.01, value, onChange, label, precision, ...props }: SliderProps) {
  const places = precision ?? (step < 0.1 ? 2 : step < 1 ? 1 : 0);
  const [draft, setDraft] = React.useState(formatNumber(value, places));
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setDraft(formatNumber(value, places));
  }, [focused, places, value]);

  const commitDraft = React.useCallback(() => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatNumber(value, places));
      return;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    onChange(clamped);
    setDraft(formatNumber(clamped, places));
  }, [draft, max, min, onChange, places, value]);

  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      {label && <span className="text-xs text-text-muted w-20 shrink-0 truncate">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 min-w-0 h-1.5 bg-border rounded appearance-none cursor-pointer"
        {...props}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commitDraft();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(formatNumber(value, places));
            e.currentTarget.blur();
          }
        }}
        className="w-16 shrink-0 select-text rounded-md border border-border bg-bg/70 px-1.5 py-1 text-right text-xs font-mono text-text-muted outline-none transition-colors focus:border-accent focus:text-text focus:ring-2 focus:ring-accent/20"
        aria-label={label ? `${label} value` : "Slider value"}
      />
    </div>
  );
}

function formatNumber(value: number, places: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(places);
}
