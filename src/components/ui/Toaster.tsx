import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import { cn } from "../../lib/cn";
import { X, AlertTriangle, Info } from "lucide-react";

/** Non-blocking toast notifications, bottom-right, auto-dismissing. */
export function Toaster() {
  const toasts = useProjectStore((s) => s.toasts);
  const dismiss = useProjectStore((s) => s.dismissToast);

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-80 max-w-[90vw] pointer-events-none">
      {toasts.map((t) => (
        <Toast key={t.id} id={t.id} msg={t.msg} kind={t.kind} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ id, msg, kind, onDismiss }: { id: string; msg: string; kind: "error" | "info"; onDismiss: () => void }) {
  React.useEffect(() => {
    const t = setTimeout(onDismiss, kind === "error" ? 6000 : 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-panel animate-scaleIn bg-surface",
        kind === "error" ? "border-danger/50" : "border-border"
      )}
    >
      <div className={cn("mt-0.5 shrink-0", kind === "error" ? "text-danger" : "text-accent")}>
        {kind === "error" ? <AlertTriangle className="w-4 h-4" /> : <Info className="w-4 h-4" />}
      </div>
      <p className="flex-1 text-xs text-text leading-snug whitespace-pre-wrap break-words">{msg}</p>
      <button className="btn-icon w-6 h-6 shrink-0 -mr-1 -mt-0.5" onClick={onDismiss} title="Dismiss">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
