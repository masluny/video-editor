# Revind — Cross-platform Video Editor (Tauri + Rust)

<img src="logo.png" width="128" height="128" alt="Revind logo" align="right">

A simple, fast, nice-looking video editor built with Tauri 2 (Rust backend + React frontend). Designed to be easy to use while supporting all the basic and necessary professional functions.

<br clear="all">

## Features (v2)

- **Import** video, audio, images and subtitles (.srt / .vtt) by drag-and-drop (files or whole folders) or the file picker. Formats the webview can't play (MKV, AVI, MPEG-2, …) get a preview proxy automatically. Pick the video's shape up front (16:9, 9:16, 1:1, 4:5) or let the first clip decide.
- **Multi-track timeline**: any number of video and audio tracks; move, trim, split, blade, marquee selection, Alt-drag to duplicate, copy/paste, snapping (with a magnetic pull to the end of the picture), markers and range (lift / extract).
- **Magnetic main track**: on V1, dragging reorders clips, drops from the library slot in at the nearest cut, and trims and deletes close up instead of leaving gaps, while titles and overlays above stay on the clip they sit on. ⌘ flips it; ⌥ on a cut rolls it. The viewer shows the frame at the edge while trimming.
- **Preview == export**: the real-time compositor and the ffmpeg export share the same geometry, colour, motion, keyframe, transition and fade maths, and titles are rasterised once and overlaid identically in both.
- **Per-clip controls**: position, scale, rotation, flip, fit/fill/stretch, blurred bars, picture-in-picture corners, crop, rounded corners and circle face-cams, opacity, fades, colour (one-click looks, Auto colour, Match colour to another clip), volume, speed (0.1×–16×, pitch kept, or type a length), freeze frames.
- **Keyframes** for position, scale, rotation and opacity (linear or smooth), plus Ken Burns zoom/pan presets and title entrances (Pop, Rise, Slide).
- **Transitions**: cross dissolve, push, slide and zoom (T at the nearest cut), dip to black, audio crossfades.
- **Titles** with presets (headline, lower third, subtitle, …), fonts, outline, shadow and background box; drag them straight on the canvas; Paste look copies a title's style onto others. Captions import from and export to .srt.
- **Music & sound**: trim music to the video's length (or loop it), duck it under speech automatically, even out the volume of several clips, clean up a voice (noise, hum, level), remove silences, volume envelopes, detached audio that stays in sync with its video.
- **Smart cuts**: beat detection and beat markers, cut a run of clips to the beat, split a clip at its shot changes or at markers.
- **Find anything**: the command palette (⌘K) searches every action; the Edit menu has the everyday ones.
- **Source viewer**: preview any library item and mark in/out before adding it. The library shows which parts of each file are already used, and sorts by name or length.
- **Export** to MP4/MOV (H.264, HEVC, ProRes), WebM, GIF, MP3/M4A/WAV, or a single PNG frame; one-click presets for YouTube, TikTok/Reels/Shorts and small files; any resolution/frame rate, loudness normalisation, export the in/out range or stop where the picture ends; live progress with cancel. YouTube chapters from named markers.
- **Projects**: `.vproj` JSON (v1 projects open and migrate automatically), recent projects, autosave with crash recovery, missing-media detection and relinking, unlimited undo/redo.

## Tech

- **Frontend**: React 19 + TypeScript + Vite + Tailwind + Zustand (Immer-based document store with undo history)
- **Backend**: Rust + Tauri 2 (stateless: the frontend owns the document and sends it with each job)
- **Media engine**: ffmpeg + ffprobe sidecars (probe, thumbnails, waveforms, proxies, silence, shot-change and picture analysis, voice clean-up, export)
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
| S (or ⌘B) · Q / W | Split at playhead · trim the clip's start / end to the playhead |
| T · ⌥F | Transition at the nearest cut · freeze the frame under the playhead |
| ⌫ · ⇧⌫ | Delete · ripple delete |
| V / B · N · P | Select / blade tool · snapping · magnetic main track |
| M · I / O · ; / ' | Add marker · set range in / out · lift / extract the range |
| ⌘C / ⌘X / ⌘V / ⌘D · ⌥⌘V | Copy / cut / paste / duplicate · paste look |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌘K | Search every action |
| ⌘S · ⌘E · ⌘I | Save · export · import |

## Project File

Saved as `.vproj` (JSON). Contains full timeline, clips, transforms, color grades, text overlays, and references to media paths (absolute paths; missing files can be relinked from the library).

## Roadmap

- Hardware encoders beyond VideoToolbox (NVENC / QSV / AMF)
- LUTs and more effects
- Speech-to-text captions
- Speed ramps

## License

MIT (or whatever you want). ffmpeg is LGPL/GPL — make sure your distribution respects that if you ship binaries.

Enjoy editing!
