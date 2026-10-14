# MichoPlay Product Requirements Document

**Status:** Planning draft. Requirements below are proposed; they are not claims about implemented behavior.  
**Source:** [`Mplayer_Product_Technical_Blueprint.md`](../Mplayer_Product_Technical_Blueprint.md)

## Product overview

MichoPlay is a privacy respecting desktop music player for music files users already own. It is planned for Windows, Linux, and macOS, with offline playback and a polished, keyboard accessible interface. The working product promise is: **Your music, your library, your experience.**

The blueprint uses “Mplayer” as its product name. This project uses the requested working name “MichoPlay.” Before public distribution, check name and trademark availability; do not use MPlayer branding or assets.

## Problem

People with local music libraries need a dependable way to browse, search, organize, and play their files without an account, streaming subscription, or cloud upload. Basic players can lack library organization, reliable background playback, and modern desktop controls; larger streaming services center online catalogs and accounts.

## Goals

- Import one or more user-selected music folders and build an organized local library.
- Play supported local audio reliably while the main window is hidden.
- Organize albums, artists, playlists, favorites, lyrics, and queue from one library.
- Persist library metadata, playback state, and (when enabled) listening statistics locally.
- Provide responsive search and navigation for large libraries.
- Provide cross-platform installers and native media controls as release work matures.
- Keep playback, indexing, search, playlists, and statistics useful without network access.

Performance values in the blueprint are targets to measure, not current guarantees. The large-library target is 50,000 tracks; proposed search target is p95 under 150 ms after warmup on reference hardware.

## Target users and roles

- **Music enthusiast:** owns a substantial local collection and wants albums, artists, playlists, and fast search.
- **Audiophile:** wants format support, output selection, ReplayGain, EQ bypass, and well-tested transitions.
- **Student or professional:** wants background listening, shortcuts, a mini-player, and a sleep timer.
- **Privacy-conscious power user:** wants local-only data, metadata control, and the ability to inspect or clear history.

The product has no account or server roles in the proposed v1.0 scope. Local user-selected folders and settings belong to the desktop user.

## Core features and priorities

### MVP / P0

- Add and remove multiple library roots with a native folder picker.
- Recursively scan folders, extract metadata/artwork, report progress, and recover from individual bad files.
- Read MP3, FLAC, WAV, Ogg Vorbis, and Opus; verify AAC/M4A support per build before claiming it.
- Browse songs, albums, and artists with title, artist, album artist, track/disc number, year, genre, duration, and artwork where present.
- Play, pause, stop, seek, change volume, and move to previous/next tracks.
- Maintain a deterministic queue with add, reorder, remove, repeat, and shuffle behavior.
- Create, rename, and delete manual playlists; add/reorder/remove playlist items; favorite tracks.
- Search indexed title, artist, album, and genre locally.
- Persist library roots, recent queue and position, volume, repeat/shuffle, and output policy.
- Continue playback when the window is minimized or hidden; explicit Quit stops playback.

### Advanced release / P1

Native OS media controls, tray integration, EQ, ReplayGain, gapless playback, crossfade, embedded and sidecar lyrics, local listening statistics, visualizer, filesystem refresh, output-device selection, mini-player, smart playlists, packaging, and signed update support.

### Follow-on / P2

Non-destructive tag editing, M3U/M3U8 import/export, duplicate grouping, offline listening recaps, and expanded accessibility improvements.

## User stories

- As a first-time user, I can choose a folder, see scan progress, and browse the imported music.
- As a listener, I can hide the main window and keep hearing music; choosing Quit stops playback.
- As a keyboard user, I can search and control playback without relying on a mouse.
- As a curator, I can create playlists, reorder tracks, and export a portable M3U8 playlist when that feature is available.
- As an audiophile, I can choose supported playback options and see clear device/codec errors.
- As a privacy-conscious user, I can view and clear local history or disable statistics collection.
- As a laptop user, the player recovers safely when an output device disconnects or the computer resumes.

## Functional requirements

1. **Import and index:** persist selected roots; scan recursively; extract metadata and artwork; ignore unsupported files; isolate per-file failures; show progress; reconcile moved, deleted, and renamed files in later releases.
2. **Catalog:** represent tracks, credited artists, albums, artwork, availability, and technical audio metadata. Preserve unknown tags where possible.
3. **Playback:** Rust owns authoritative player and queue state. Support transport controls and stable end-of-track handling. React presents state and may animate progress between native snapshots.
4. **Queue and collections:** manual playlist duplicates are allowed; queue items have stable ordering; shuffle uses a deterministic session order; repeat modes are off/all/one.
5. **Search:** local indexed search across title, artist, album, and genre, with debounced input and categorized results. No network dependency.
6. **Persistence:** use transactional local persistence for library and settings. Throttle playback-state writes. Restore a player snapshot at UI startup before reconciling incremental events.
7. **Privacy controls:** do not upload library contents, paths, artwork, or history. Statistics can be disabled and cleared. Logs omit track names and raw paths by default.
8. **Error recovery:** provide useful states for missing files, inaccessible folders, corrupt tags, unsupported codecs, absent devices, and empty results.

## Non-functional requirements

- **Platforms:** target Windows 10/11 x64, supported macOS Intel/Apple Silicon, and tested Linux desktop distributions. Confirm the specific OS matrix before release.
- **Offline first:** all core library and playback workflows work without networking.
- **Responsiveness:** virtualize long lists, bound background work, and avoid blocking the audio callback. Measure proposed targets against named reference hardware.
- **Reliability:** maintain consistent DB/player state through errors, device changes, window reloads, sleep/resume, and process restart.
- **Accessibility:** keyboard navigation, visible focus, semantic labels, reduced motion, scalable typography, and contrast testing.
- **Security:** least-privilege Tauri capabilities; only user-approved roots; validate paths and all IPC input in Rust.
- **Release quality:** test clean installs, platform media integration, codec fixtures, and signed packages where practical.

## Out of scope for v1.0

Cloud streaming, account infrastructure, copyrighted music downloads, DRM, purchasing, media-server hosting, mobile apps, remote music identification, cloud lyrics search, default remote artwork, and a guarantee of bit-perfect output while DSP is active.

## Success measures

- A user can import a folder and play local files fully offline.
- Playback remains active when the window is hidden and stops on explicit Quit.
- Library, queue, playlists, and selected settings survive restart.
- Search, scanning, and scrolling meet agreed, measured targets on reference hardware, including a synthetic 50,000-track library.
- Long-running playback and device recovery pass the release test matrix on supported OSes.
- No mandatory analytics or unexpected network requests occur.

## Future features

See P1/P2 priorities above and the phased delivery plan in [`TASKS.md`](TASKS.md). Feature priority does not mean the feature is implemented.
