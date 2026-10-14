# MichoPlay Project Memory

## Current project state

- The repository now contains the initial React shell under src/ and Tauri 2 host under src-tauri/, alongside the blueprint and docs/ knowledge set.
- The blueprint is version 1.0, dated 14 October 2026, and explicitly describes a proposed planning specification.
- Product name requested for this project: **MichoPlay**. “Mplayer” is the blueprint's name and should be treated as a working-name reference only.
- Platform proposal: Windows, Linux, macOS. Current stack: Tauri 2, React, TypeScript, Rust, Rodio 0.21.1/CPAL, Lofty metadata, and Walkdir. SQLite is still planned.

## Decisions recorded

### 2026-10-14 — Use MichoPlay as the project working name

**Decision:** Documentation created for the project uses MichoPlay.  
**Reason:** The project owner requested this name.  
**Constraint:** Check name/trademark availability before public distribution; the blueprint notes similarity to the established MPlayer project.

### 2026-10-14 — Treat blueprint as proposed specification

**Decision:** Requirements, architecture, stack, performance values, and roadmap are recorded as proposed until implementation and validation confirm them.  
**Reason:** The source blueprint explicitly states that it is a planning draft, not a description of implemented functionality.

### 2026-10-14 — Keep core product local and offline-first

**Decision:** Core playback, indexing, search, playlists, lyrics, and statistics are designed to operate locally; no account or cloud backend is part of the v1.0 scope.  
**Reason:** Product promise and privacy requirements in the blueprint.

### 2026-10-14 — Rust owns playback and persistence

**Decision:** The proposed architecture gives Rust authority over player/queue state, filesystem access, and SQLite through typed Tauri commands.  
**Reason:** Decouples playback from WebView lifecycle and keeps privileged operations behind a validated boundary.

### 2026-10-14 — Initial interface direction

**Decision:** The starter shell uses deep green-black surfaces and a muted mint accent (`#82D8BD`).  
**Reason:** Establish a recognizable local-music identity while keeping the interface calm and legible.  
**Status:** Initial design choice; contrast and user feedback still need review.

## Known risks and open decisions

- Confirm the final accent color; the blueprint's green value is explicitly a placeholder.
- Validate product name and trademark availability before public release.
- Verify supported codecs, seeking behavior, and output-device behavior on each target platform with real fixtures.
- Prove gapless playback, crossfade, DSP quality, and output-device recovery with real fixture/platform testing.
- Select and document exact supported Linux distributions and macOS versions.
- Establish reference hardware and measure all proposed performance targets.
- Decide final schema details for album editions, Windows path identity, and timestamp convention before migrations stabilize.
- Stable Rust 1.99.0 is installed under the user profile and is available in login zsh sessions. The app's first native build completed; current Tauri system libraries are available.

## Setup discoveries

### Tauri CLI bus error — 2026-10-14

The installed `@tauri-apps/cli-linux-x64-gnu` binary was truncated at 4,003,866 bytes; its ELF header referenced section data beyond the file. Moving the damaged copy aside and reinstalling dependencies with a fresh npm cache restored the 19,098,296-byte binary. `npm run tauri -- --version` now reports Tauri CLI 2.12.2.

### Rust toolchain and first Tauri launch — 2026-10-14

Installed Rust stable 1.99.0 under the user profile with rustup and set it as the default. The interactive build also exposed that the Tauri configuration expects an app icon at `src-tauri/icons/icon.png`; generated platform icons from the original `app-icon.svg`. With the Cargo bin path available, `npm run tauri dev` compiled and launched MichoPlay successfully. Stop the running development app with Ctrl+C.

## Completed work

- 2026-10-14: Created initial PRD, architecture, development rules, design system, task roadmap, and project memory from the supplied blueprint.
- 2026-10-14: Added Tauri commands for recursive local audio scanning, basic metadata extraction, native Rodio playback, queue navigation, seeking, volume, shuffle, and repeat. The React player renders scanned tracks and restores selected folder paths from localStorage. Catalog and player data still rebuild in memory on launch.
- 2026-10-14: Added nested folder, album, artist, song, favorite, and playlist views with per-collection search and browser-style back/forward navigation. Playlist edits, favorites, pane sizes, and display preferences currently use localStorage; SQLite persistence is still open.
- 2026-10-14: Added local embedded/sidecar cover art loading, blurred cover backdrops, safe JavaScript track IDs, library refresh actions, explicit next-up queue ordering, draggable queue rows and keyboard-accessible move controls, plus playlist creation and track actions.
- 2026-10-14: Added root `.gitignore` and `.gitattributes` for generated files, local databases, editor files, and consistent source line endings.
- 2026-10-14: Installed npm dependencies and generated the package lockfile. Frontend production build completed successfully.
- 2026-10-14: Added original MichoPlay SVG mark and generated Tauri desktop/platform icons. First native Tauri debug build completed and the app launched.

## Current work

- The first scanning/playback slice is implemented. It still needs playback verification with real audio on supported systems and broader scan recovery and persistence work.

## Known bugs

- Folder roots are stored in localStorage and catalog/playback state is in memory; catalog data is rescanned after restart.
- ALSA development files/pkg-config metadata may be needed to build the Linux audio backend.
