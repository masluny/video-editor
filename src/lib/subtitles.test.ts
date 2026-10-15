import { describe, expect, it } from "vitest";
import { parseSubtitles, srtTime, toSrt } from "./subtitles";

describe("subtitles", () => {
  it("parses SRT with a BOM, CRLF line ends, markup and multi-line cues", () => {
    const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> there\r\n\r\n2\r\n00:00:03,250 --> 00:00:05,000\r\n{\\an8}Two\r\nlines &amp; more\r\n\r\n";
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: "Hello there" },
      { start: 3.25, end: 5, text: "Two\nlines & more" },
    ]);
  });

  it("parses WebVTT: header, short timestamps, cue settings, notes and voice tags", () => {
    const vtt = "WEBVTT - demo\n\nNOTE written by hand\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\n<v Ana>Hi!</v>\n\n01:00:00.500 --> 01:00:01.000\nLate";
    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 2, text: "Hi!" },
      { start: 3600.5, end: 3601, text: "Late" },
    ]);
  });

  it("skips broken cues and sorts the rest", () => {
    const srt = "1\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n2\n00:00:03,000 --> 00:00:04,000\nlater\n\n3\nno timing here\n\n4\n00:00:01,000 --> 00:00:02,000\nfirst";
    expect(parseSubtitles(srt).map((c) => c.text)).toEqual(["first", "later"]);
  });

  it("writes SRT that reads back the same", () => {
    expect(srtTime(3723.4567)).toBe("01:02:03,457");
    const cues = [
      { start: 0.5, end: 1.25, text: "One" },
      { start: 2, end: 4, text: "Two\nlines" },
    ];
    expect(parseSubtitles(toSrt(cues))).toEqual(cues);
  });
});
