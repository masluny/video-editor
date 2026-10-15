import * as React from "react";
import { ChevronDown, CircleHelp, Clapperboard, Clock, Loader2, Redo2, Undo2 } from "lucide-react";
import { isDirty, store, useStore } from "../store/store";
import { Button, IconButton } from "./ui/controls";
import { openMenu, type MenuItem } from "./ui/Menu";
import { recentProjects } from "../lib/recent";
import { basename, stripExtension } from "../lib/format";
import { importViaDialog, newProject, openProject, saveProject } from "../lib/actions";
import { useExportJob } from "./dialogs/exportJob";
import { isTauri } from "../lib/backend";
import { cn } from "../lib/cn";

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const cmd = isMac ? "⌘" : "Ctrl+";

export function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0 || !!s.liveBase);
  const canRedo = useStore((s) => s.future.length > 0);
  const dirty = useStore(isDirty);
  const name = useStore((s) => s.project.name);
  const job = useExportJob((s) => s.job);
  const exporting = job && !job.quiet && job.status === "running";
  const [editing, setEditing] = React.useState(false);

  const fileMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      { label: "New project", shortcut: `${cmd}N`, onSelect: () => newProject() },
      { label: "Open…", shortcut: `${cmd}O`, onSelect: () => openProject() },
      ...recentProjects()
        .filter((p) => p !== store().filePath)
        .slice(0, 5)
        .map((p): MenuItem => ({ label: stripExtension(basename(p)), icon: <Clock className="h-3.5 w-3.5" />, onSelect: () => openProject(p) })),
      { separator: true },
      { label: "Save", shortcut: `${cmd}S`, onSelect: () => saveProject() },
      { label: "Save as…", shortcut: isMac ? "⇧⌘S" : "Ctrl+Shift+S", onSelect: () => saveProject(true) },
      { separator: true },
      { label: "Import media…", shortcut: `${cmd}I`, onSelect: () => importViaDialog() },
      { label: "Project settings…", onSelect: () => store().openDialog({ kind: "settings" }) },
      { separator: true },
      { label: "Export…", shortcut: `${cmd}E`, onSelect: () => store().openDialog({ kind: "export" }) },
    ]);
  };

  return (
    <header
      data-tauri-drag-region
      className={cn("flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel/70 pr-2", isMac && isTauri() ? "pl-[84px]" : "pl-2")}
    >
      <Button variant="ghost" size="sm" onClick={fileMenu} className="gap-1">
        File <ChevronDown className="h-3 w-3 text-ink-dim" />
      </Button>
      <div className="mx-1 h-4 w-px bg-line" />
      <IconButton title={`Undo (${cmd}Z)`} disabled={!canUndo} onClick={() => store().undo()}>
        <Undo2 className="h-4 w-4" />
      </IconButton>
      <IconButton title={`Redo (⇧${cmd}Z)`} disabled={!canRedo} onClick={() => store().redo()}>
        <Redo2 className="h-4 w-4" />
      </IconButton>

      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center justify-center">
        {editing ? (
          <input
            autoFocus
            defaultValue={name}
            className="field h-7 w-60 text-center"
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value.trim() !== name) store().renameProject(e.target.value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="flex max-w-[50%] items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-ink-muted hover:bg-white/[0.05] hover:text-ink"
            title="Rename project"
          >
            <span className="truncate">{name}</span>
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-dim" title="Unsaved changes" />}
          </button>
        )}
      </div>

      <IconButton title="Keyboard shortcuts (?)" onClick={() => store().openDialog({ kind: "shortcuts" })}>
        <CircleHelp className="h-4 w-4" />
      </IconButton>
      <Button variant="primary" size="md" className="ml-1" onClick={() => store().openDialog({ kind: "export" })}>
        {exporting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {Math.floor(job!.progress)}%
          </>
        ) : (
          <>
            <Clapperboard className="h-3.5 w-3.5" /> Export
          </>
        )}
      </Button>
    </header>
  );
}
