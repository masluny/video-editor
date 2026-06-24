import * as React from "react";
import { cn } from "../../lib/cn";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[];
}

export function Select({ className, options, children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        "bg-bg-secondary border border-border rounded px-2 py-1 text-sm text-text outline-none focus:border-accent",
        className
      )}
      {...props}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
      {children}
    </select>
  );
}
