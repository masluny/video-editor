import * as React from "react";
import { cn } from "../../lib/cn";
import { keyLabel } from "../../lib/format";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-[0_6px_20px_-10px_rgba(139,124,246,0.9)]",
  secondary: "bg-panel-3 text-ink border border-line-strong hover:bg-[#26262d] hover:border-[#41414a]",
  ghost: "text-ink-muted hover:text-ink hover:bg-white/[0.06]",
  danger: "bg-danger/12 text-danger hover:bg-danger/20 border border-danger/25",
};

const SIZES = { sm: "h-7 px-2.5 text-sm gap-1.5", md: "h-8 px-3 text-sm gap-2", lg: "h-9 px-4 text-md gap-2" };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={title && keyLabel(title)}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-[background,color,border,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "xs" | "sm" | "md";
  tone?: "default" | "danger" | "accent";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active, size = "md", tone = "default", className, type = "button", title, ...props },
  ref,
) {
  const dims = size === "xs" ? "h-5 w-5" : size === "sm" ? "h-6 w-6" : "h-7 w-7";
  return (
    <button
      ref={ref}
      type={type}
      title={title && keyLabel(title)}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        dims,
        active
          ? tone === "danger"
            ? "bg-danger/15 text-danger"
            : "bg-accent/18 text-accent-ink"
          : tone === "danger"
            ? "text-ink-muted hover:bg-danger/12 hover:text-danger"
            : "text-ink-muted hover:bg-white/[0.07] hover:text-ink",
        className,
      )}
      {...props}
    />
  );
});

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
  title,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        title={title}
        disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className="field appearance-none pr-7 cursor-pointer disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-dim" viewBox="0 0 12 12" fill="none">
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function Switch({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; title?: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-ink-muted hover:text-ink" title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          checked ? "bg-accent" : "bg-[#34343c]",
        )}
      >
        <span className={cn("absolute left-0 top-[3px] h-3 w-3 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[17px]" : "translate-x-[3px]")} />
      </button>
      {label}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("inline-flex rounded-md border border-line bg-bg p-0.5", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title && keyLabel(o.title)}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 rounded-[5px] px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            size === "sm" ? "h-5 text-2xs" : "h-6 text-xs",
            value === o.value ? "bg-panel-3 text-ink shadow-inset ring-1 ring-line-strong" : "text-ink-dim hover:text-ink-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  return (
    <label className="relative inline-flex h-7 items-center gap-2 rounded-md border border-line bg-bg pl-1 pr-2 hover:border-line-strong" title={title}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-5 w-6" />
      <span className="font-mono text-2xs uppercase text-ink-muted">{value}</span>
    </label>
  );
}

export function FieldRow({ label, children, hint }: { label: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex min-h-7 items-center gap-3" title={hint}>
      <span className="w-[76px] shrink-0 truncate text-xs text-ink-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
