import { beforeEach, describe, expect, it } from "vitest";
import { forgetProject, recentProjects, rememberProject } from "./recent";

beforeEach(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
});

describe("recent projects", () => {
  it("keeps the newest first, without duplicates, up to six", () => {
    for (const p of ["a", "b", "c", "d", "e", "f", "g"]) rememberProject(`/p/${p}.vproj`);
    rememberProject("/p/c.vproj");
    expect(recentProjects()).toEqual(["/p/c.vproj", "/p/g.vproj", "/p/f.vproj", "/p/e.vproj", "/p/d.vproj", "/p/b.vproj"]);
    forgetProject("/p/g.vproj");
    expect(recentProjects()[1]).toBe("/p/f.vproj");
  });

  it("shrugs off missing or broken storage", () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => "{not json", setItem: () => { throw new Error("full"); } };
    expect(recentProjects()).toEqual([]);
    expect(() => rememberProject("/x.vproj")).not.toThrow();
  });
});
