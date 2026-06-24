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
}

export function Slider({ className, min = 0, max = 1, step = 0.01, value, onChange, label, ...props }: SliderProps) {
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
      <span className="text-xs text-text-muted font-mono w-14 shrink-0 text-right">{value.toFixed(step < 0.1 ? 2 : 1)}</span>
    </div>
  );
}
