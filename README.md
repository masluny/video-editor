# Revind — Cross-platform Video Editor (Tauri + Rust)

<img src="logo.png" width="128" height="128" alt="Revind logo" align="right">

A simple, fast, nice-looking video editor built with Tauri 2 (Rust backend + React frontend). Designed to be easy to use while supporting all the basic and necessary professional functions.

## Features (MVP + Phase 2 scope)

- Import video/audio via drag-drop or file picker
- Multi-track timeline (unlimited video + audio tracks)
- Trim, split, ripple-delete, move clips with snapping
- Playhead scrubbing + smooth playback preview (native `<video>`)
- Per-clip transforms (position, scale, rotation)
- Color correction (brightness, contrast, saturation, gamma, hue, blur, opacity)
- Opacity, speed (0.25x–4x), volume, mute, fades
- Text/title overlays (position, size, color, font style)
- Keyframe-ready data model (UI for basic keyframes coming next)
- Full multi-track export to MP4 (H.264 + AAC) via bundled ffmpeg
- Project save/load (.vproj JSON)
- Undo/redo + autosync with backend
- Keyboard-first: Space (play/pause), S (split), Del/Backspace (delete), Ctrl/Cmd+Z/Y (undo/redo)

## Tech

- **Frontend**: React 19 + TypeScript + Vite + Tailwind + Zustand + @dnd-kit
- **Backend**: Rust + Tauri 2
- **Video engine**: ffmpeg + ffprobe (sidecar binaries)
- **Export**: Single-pass filter_complex pipeline (trim, speed, eq, scale, crop, fade, overlay text, concat, amix)

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

- Click **Export Movie** (top right)
- Choose output `.mp4`
- Watch live progress (powered by Rust sidecar + event stream)

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
git tag v0.2.3
git push origin v0.2.3
```

Tagged releases use `RELEASE.md` as the release body and attach native installers/packages from all three platforms.

## Keyboard Shortcuts

| Key              | Action                  |
|------------------|-------------------------|
| Space            | Play / Pause            |
| S                | Split clip at playhead  |
| Delete / ⌫       | Delete selected clip    |
| Ctrl/Cmd + Z     | Undo                    |
| Ctrl/Cmd + Shift+Z / Y | Redo             |
| Drag from bin    | Add clip to track       |

## Project File

Saved as `.vproj` (JSON). Contains full timeline, clips, transforms, color grades, text overlays, and references to media paths (absolute for now).

## Roadmap (after this milestone)

- Real keyframe editor UI
- Transitions (xfade, fade to black)
- Better multi-track audio mixing preview
- Proxy generation for 4K/8K performance
- LUTs, blur, vignette effects
- SRT subtitles
- Hardware-accelerated encode flags (NVENC / VideoToolbox)

## License

MIT (or whatever you want). ffmpeg is LGPL/GPL — make sure your distribution respects that if you ship binaries.

Enjoy editing!
