import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useStore, type Toast } from "../../store/store";
import { cn } from "../../lib/cn";

export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[95] flex w-[420px] max-w-[90vw] -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastView({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [hover, setHover] = React.useState(false);
  React.useEffect(() => {
    if (hover) return;
    const t = setTimeout(() => dismiss(toast.id), toast.kind === "error" ? 9000 : toast.action ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast, dismiss, hover]);

  const Icon = toast.kind === "error" ? AlertTriangle : toast.kind === "success" ? CheckCircle2 : Info;
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={cn(
        "pointer-events-auto flex w-full animate-slideUp items-start gap-2.5 rounded-lg border bg-panel-2/95 px-3 py-2.5 shadow-pop backdrop-blur-xl",
        toast.kind === "error" ? "border-danger/40" : "border-line-strong",
      )}
    >
      <Icon className={cn("mt-px h-4 w-4 shrink-0", toast.kind === "error" ? "text-danger" : toast.kind === "success" ? "text-success" : "text-accent-ink")} />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-[18px] text-ink">{toast.message}</p>
      {toast.action && (
        <button
          className="shrink-0 rounded px-1.5 text-sm font-semibold text-accent-ink hover:text-white"
          onClick={() => {
            toast.action!.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="-mr-1 shrink-0 rounded p-0.5 text-ink-dim hover:text-ink" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
