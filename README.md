# Revind — Cross-platform Video Editor (Tauri + Rust)

<img src="logo.png" width="128" height="128" alt="Revind logo" align="right">

A simple, fast, nice-looking video editor built with Tauri 2 (Rust backend + React frontend). Designed to be easy to use while supporting all the basic and necessary professional functions.

<br clear="all">

## Features (v2)

- **Import** video, audio and images by drag-and-drop (files or whole folders) or the file picker. Formats the webview can't play (MKV, AVI, MPEG-2, …) get a preview proxy automatically.
- **Multi-track timeline**: any number of video and audio tracks; move, trim, split, ripple-delete, blade tool, marquee selection, Alt-drag to duplicate, copy/paste, snapping to clips, playhead, markers and range.
- **Preview == export**: the real-time compositor and the ffmpeg export share the same geometry, colour and fade maths, and titles are rasterised once and overlaid identically in both.
- **Per-clip controls**: position, scale, rotation, flip, fit/fill/stretch, crop, opacity, fades, colour (with one-click looks), volume, speed (0.1×–16×, pitch kept), detach audio.
- **Titles** with presets (headline, lower third, subtitle, …), fonts, outline, shadow and background box; drag them straight on the canvas.
- **Remove silences** (new): finds pauses in a clip's audio and cuts them out in one step — instant jump cuts for talking-head videos and voice-overs.
- **Source viewer**: preview any library item and mark in/out before adding it.
- **Export** to MP4/MOV (H.264, HEVC, ProRes), WebM, GIF, MP3/M4A/WAV, or a single PNG frame; any resolution/frame rate, loudness normalisation, export just the in/out range, live progress with cancel.
- **Projects**: `.vproj` JSON (v1 projects open and migrate automatically), autosave with crash recovery, missing-media detection and relinking, unlimited undo/redo.

## Tech

- **Frontend**: React 19 + TypeScript + Vite + Tailwind + Zustand (Immer-based document store with undo history)
- **Backend**: Rust + Tauri 2 (stateless: the frontend owns the document and sends it with each job)
- **Media engine**: ffmpeg + ffprobe sidecars (probe, thumbnails, waveforms, proxies, silence detection, export)
- **Tests**: `npm test` (timeline model & store) and `cargo test` in `src-tauri` (export graphs rendered with real ffmpeg)

## Run (Development)

1. Install Rust (if not already):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Install Node deps:
   ```bash
   cd video-editor
   npm install
   ```

3. Make sure `ffmpeg` and `ffprobe` are installed locally, then prepare Tauri sidecars:
   ```bash
   npm run prepare:sidecars
   ```

4. Start:
   ```bash
   npm run tauri dev
   ```

## Exporting

- Click **Export** (top right) or press ⌘/Ctrl+E
- Pick a format and quality, then choose where to save
- Watch live progress; the file is written next to the destination and only moved into place when complete

## Building for Release Locally

For production builds, prepare real platform-specific ffmpeg sidecars first:
```bash
npm run prepare:sidecars
npm run tauri build
```

The resulting app bundles ffmpeg/ffprobe and runs without asking the user to install media tools separately.

## GitHub Releases

This repo includes `.github/workflows/release.yml`, which builds Revind on macOS, Windows, and Linux.

Manual build:
```bash
gh workflow run "Build Revind"
```

Publish a GitHub Release:
```bash
git tag v0.2.4
git push origin v0.2.4
```

Tagged releases use `RELEASE.md` as the release body and attach native installers/packages from all three platforms.

## Keyboard Shortcuts

Press **?** in the app for the full list. The essentials:

| Key | Action |
|---|---|
| Space · J / K / L | Play/pause · shuttle reverse / stop / forward |
| ← / → · ↑ / ↓ | Step a frame · jump between edit points |
| S (or ⌘B) | Split at playhead |
| ⌫ · ⇧⌫ | Delete · ripple delete |
| V / B | Select / blade tool |
| M · I / O | Add marker · set range in / out |
| ⌘C / ⌘X / ⌘V / ⌘D | Copy / cut / paste / duplicate |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌘S · ⌘E · ⌘I | Save · export · import |

## Project File

Saved as `.vproj` (JSON). Contains full timeline, clips, transforms, color grades, text overlays, and references to media paths (absolute paths; missing files can be relinked from the library).

## Roadmap

- Keyframe editor
- Transitions (cross-dissolve, dip to black)
- Hardware encoders beyond VideoToolbox (NVENC / QSV / AMF)
- LUTs and more effects
- SRT subtitles

## License

MIT (or whatever you want). ffmpeg is LGPL/GPL — make sure your distribution respects that if you ship binaries.

Enjoy editing!
