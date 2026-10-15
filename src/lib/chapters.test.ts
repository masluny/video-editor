import { describe, expect, it } from "vitest";
import { chapterTime, youtubeChapters } from "./chapters";
import type { Marker } from "./types";

const mk = (time: number, label = ""): Marker => ({ id: String(time), time, label, color: "#fff" });

describe("YouTube chapters", () => {
  it("formats times like YouTube", () => {
    expect([0, 9.99, 65, 3723.4].map(chapterTime)).toEqual(["0:00", "0:09", "1:05", "1:02:03"]);
  });

  it("lists named markers, starting at 0:00", () => {
    const c = youtubeChapters([mk(95, "Setup"), mk(30.6, "The plan"), mk(50), mk(400, "Past the end")], 300);
    expect(c.text).toBe("0:00 Intro\n0:30 The plan\n1:35 Setup");
    expect(c.problems).toEqual([]);
  });

  it("uses every marker when none is named, and explains what YouTube won't accept", () => {
    const c = youtubeChapters([mk(0), mk(4)], 60);
    expect(c.text).toBe("0:00 Chapter 1\n0:04 Chapter 2");
    expect(c.problems).toHaveLength(2);
    expect(c.problems[0]).toMatch(/at least 3 chapters/);
    expect(c.problems[1]).toMatch(/“Chapter 1” \(0:00\)/);
  });
});
