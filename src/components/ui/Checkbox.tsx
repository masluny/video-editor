import * as React from "react";
import { cn } from "../../lib/cn";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export function Checkbox({ className, label, ...props }: CheckboxProps) {
  return (
    <label className={cn("flex items-center gap-2 cursor-pointer", className)}>
      <input
        type="checkbox"
        className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg"
        {...props}
      />
      {label && <span className="text-sm text-text">{label}</span>}
    </label>
  );
}
