// Titles are rasterised once to a transparent, frame-sized PNG. The preview shows
// that image and the export overlays the very same pixels, so text looks identical
// in both — no dependency on ffmpeg's (often missing) drawtext filter.

import type { TitleStyle } from "./types";

function fontString(s: TitleStyle, size = s.fontSize): string {
  return `${s.italic ? "italic " : ""}${Math.round(s.fontWeight)} ${size}px "${s.fontFamily}", "Inter Variable", system-ui, sans-serif`;
}

async function ensureFont(s: TitleStyle): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(fontString(s, 32), s.text || "A");
  } catch {
    /* fall back to whatever is available */
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = "";
    for (const w of words) {
      const candidate = line + w;
      if (line.trim() && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

export async function drawTitle(style: TitleStyle, width: number, height: number): Promise<HTMLCanvasElement> {
  await ensureFont(style);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width));
  canvas.height = Math.max(2, Math.round(height));
  const ctx = canvas.getContext("2d")!;
  ctx.font = fontString(style);
  const ls = style.letterSpacing || 0;
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;

  const maxW = Math.max(40, (style.maxWidth / 100) * width);
  const lines = wrap(ctx, style.text || "", maxW);
  const lh = style.fontSize * style.lineHeight;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(1, ...widths);
  const blockH = lines.length * lh;
  const cx = (style.x / 100) * width;
  const cy = (style.y / 100) * height;
  const left = cx - blockW / 2;
  const top = cy - blockH / 2;

  if (style.box && style.text.trim()) {
    const p = style.boxPadding;
    ctx.fillStyle = hexToRgba(style.boxColor, style.boxOpacity);
    ctx.beginPath();
    const r = Math.min(style.boxRadius, (blockH + 2 * p) / 2);
    if (typeof ctx.roundRect === "function") ctx.roundRect(left - p, top - p, blockW + 2 * p, blockH + 2 * p, r);
    else ctx.rect(left - p, top - p, blockW + 2 * p, blockH + 2 * p);
    ctx.fill();
  }

  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.textAlign = style.align;
  const x = style.align === "left" ? left : style.align === "right" ? left + blockW : cx;

  lines.forEach((line, i) => {
    const y = top + lh * (i + 0.5);
    if (style.shadow > 0) {
      ctx.shadowColor = hexToRgba(style.shadowColor, 0.85);
      ctx.shadowBlur = style.shadow;
      ctx.shadowOffsetY = style.shadow * 0.25;
    }
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * 2;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = "transparent";
  });
  return canvas;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Bounding box of the text block (incl. box padding), in frame pixels. */
export function titleBounds(style: TitleStyle, width: number, height: number): { x: number; y: number; w: number; h: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  ctx.font = fontString(style);
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${style.letterSpacing || 0}px`;
  const lines = wrap(ctx, style.text || " ", Math.max(40, (style.maxWidth / 100) * width));
  const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const h = lines.length * style.fontSize * style.lineHeight;
  const pad = style.box ? style.boxPadding : Math.max(4, style.strokeWidth);
  const cx = (style.x / 100) * width;
  const cy = (style.y / 100) * height;
  return { x: cx - w / 2 - pad, y: cy - h / 2 - pad, w: w + 2 * pad, h: h + 2 * pad };
}

const cache = new Map<string, Promise<string>>();

function key(style: TitleStyle, width: number, height: number) {
  return `${width}x${height}|${JSON.stringify(style)}`;
}

/** Object URL of the rendered title (cached; for the preview). */
export function titleImageUrl(style: TitleStyle, width: number, height: number): Promise<string> {
  const k = key(style, width, height);
  let hit = cache.get(k);
  if (!hit) {
    hit = drawTitle(style, width, height).then(
      (c) => new Promise<string>((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : c.toDataURL("image/png")), "image/png")),
    );
    cache.set(k, hit);
    if (cache.size > 64) {
      const [oldKey, old] = cache.entries().next().value as [string, Promise<string>];
      cache.delete(oldKey);
      old.then((u) => u.startsWith("blob:") && URL.revokeObjectURL(u));
    }
  }
  return hit;
}

/** Base64 PNG of the rendered title (for export). */
export async function titlePngDataUrl(style: TitleStyle, width: number, height: number): Promise<string> {
  return (await drawTitle(style, width, height)).toDataURL("image/png");
}
