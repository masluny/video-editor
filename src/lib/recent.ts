// Recently opened / saved project files, newest first (per machine, in localStorage).

const KEY = "revind.recentProjects";
const MAX = 6;

export function recentProjects(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function store(paths: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(paths.slice(0, MAX)));
  } catch {
    /* storage unavailable: just don't remember */
  }
}

export function rememberProject(path: string) {
  store([path, ...recentProjects().filter((p) => p !== path)]);
}

export function forgetProject(path: string) {
  store(recentProjects().filter((p) => p !== path));
}
