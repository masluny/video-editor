import * as React from "react";
import { cn } from "../../lib/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "icon" | "danger";
  size?: "sm" | "md";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", children, disabled, ...props }, ref) => {
    const base = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium rounded-md transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none";
    const variants = {
      primary: "bg-accent text-white hover:bg-accent-hover shadow-[0_8px_24px_-16px_rgba(79,140,255,0.95)]",
      ghost: "bg-transparent text-text-muted hover:text-text hover:bg-surface-hover/90",
      icon: "bg-transparent text-text-muted hover:text-text hover:bg-surface-hover p-1.5",
      danger: "bg-danger/15 text-danger hover:bg-danger/25 hover:text-danger-hover",
    };
    const sizes = {
      sm: "px-2.5 py-1 text-xs",
      md: "px-3 py-1.5 text-sm",
    };
    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
