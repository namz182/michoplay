# MichoPlay System Architecture

**Status:** Proposed architecture from the product blueprint; verify against implementation as it is built.

## Overview

MichoPlay is planned as a native desktop shell with a React interface and a Rust application core. The frontend sends typed intentions through Tauri IPC. Rust owns audio playback, filesystem access, SQLite persistence, queue transitions, and platform integrations. User audio stays in its existing folders; SQLite stores the local index and settings.

```text
React + TypeScript UI
        │ typed Tauri commands/events
        ▼
Rust application core ─────── OS media / tray / audio devices
   ├── Player and DSP                  │
   ├── Library scanner                 ▼
   ├── Search / lyrics / stats     CPAL output
   └── SQLite via sqlx
        │                       Local audio folders
        └── Artwork cache
```

## Technology stack

- **Desktop:** Tauri 2
- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui + Radix, Lucide
- **Frontend state:** Zustand for view state; TanStack Query for library read models; Rust remains playback authority
- **Lists/forms/charts:** TanStack Virtual, React Hook Form + Zod, Recharts
- **Native core:** Rust, Tokio/channels for background coordination, tracing for diagnostics
- **Audio:** Rodio 0.22.x candidate over CPAL; Symphonia decoding through Rodio; Lofty metadata; custom biquad DSP and rubato only as needed
- **Database:** SQLite owned by Rust through sqlx migrations; FTS5 for local search
- **Platform media:** Souvlaki is an initial candidate and must be validated for each platform
- **Build:** Tauri CLI and GitHub Actions matrix, with signing/notarization work before release

These are planning selections. Check current dependency APIs, codec flags, and platform support before implementation or upgrade. Advanced gapless playback, crossfade, EQ, and limiting require explicit DSP validation; Rodio alone is not a guarantee of those behaviors.

## Responsibilities and modules

### Frontend

Organize UI by feature: onboarding, library, playback, playlists, search, lyrics, equalizer, statistics, and settings. Shared components include the sidebar, header/search, bottom player, track rows, cards, queue/lyrics panels, scan banner, empty states, dialogs, and mini-player. Put typed command wrappers and event subscriptions in a dedicated IPC module.

### Rust core

- `commands`: validated domain commands for library, playback, queue, playlists, settings, lyrics, and statistics.
- `audio`: player controller, decoder, mixer/DSP, and output-device management.
- `library` / `metadata`: bounded recursive scanning, metadata extraction, artwork caching, and watcher reconciliation.
- `search`: FTS5 projection and parameterized search.
- `persistence`: sqlx pool, migrations, transactions, and domain repositories.
- `lyrics` / `statistics`: local parsing and session aggregation.
- `platform`: tray, media controls, shortcuts, and OS lifecycle/device events.

The blueprint proposes `src/` for React code and `src-tauri/` for Rust code; keep the actual repository layout aligned as scaffolding is added.

## Data and storage

SQLite is the system of record for indexed metadata, library roots, playlists, favorites, queue/player snapshots, settings, lyrics, EQ presets, and optional play sessions. Audio remains in user-selected locations. Artwork is cached under an application data directory with bounded storage. Enable SQLite foreign keys and WAL; use transactions for multi-row changes. Use Unix milliseconds or UTC ISO timestamps consistently (blueprint schema examples use Unix milliseconds).

Key entities: `library_roots`, `tracks`, `artists`, `albums`, `track_artists`, `artworks`, `playlists`, `playlist_items`, `favorites`, `queue_items`, `player_state`, `play_sessions`, `lyrics`, `equalizer_presets`, and `settings`. See the blueprint's schema sketch; revisit uniqueness rules for album editions and path identity across operating systems before final migrations.

FTS5 indexes a flattened projection of track title, artist names, album title, and genre. Keep that projection transactionally synchronized when tracks, artists, or albums change; a tracks-only trigger is insufficient for renamed related records.

## IPC and data flow

Frontend command examples: `library_add_root`, `library_scan`, `library_query`, `player_play`, `player_pause`, `player_seek_ms`, `player_next`, `queue_add`, `queue_move`, `playlist_create`, `settings_get`, `audio_list_devices`, `lyrics_get`, and `stats_summary`.

Rust event examples: `player:state`, `player:position`, `player:track-changed`, `player:error`, `library:scan-progress`, `library:changed`, `audio:device-changed`, and `settings:changed`.

Use typed DTOs and user-safe error codes such as `FILE_MISSING`, `DECODER_UNSUPPORTED`, `OUTPUT_UNAVAILABLE`, and `LIBRARY_PATH_DENIED`. On UI startup, fetch a complete player snapshot, subscribe to events, and reconcile after focus/reload.

## Architecture invariants

1. Rust is the single authoritative owner of transport state, queue transitions, position, gain, repeat/shuffle, and output device.
2. Do not use a WebView `<audio>` element for primary playback; hidden/destroyed UI must not own audio lifetime.
3. Serialize player commands through one controller/actor or equivalent to prevent queue races.
4. Never block an audio callback on database, filesystem, IPC, logging, network, or allocation-heavy work; use bounded buffers and worker channels.
5. Only index user-selected roots. Canonicalize and validate paths against approved roots, accounting for symlinks and removable mounts.
6. Use transactional DB updates and isolate scan errors per file.
7. Throttle high-volume UI events (progress, FFT, scan updates) and bound queues/caches.
8. Keep DSP/player logic independently testable outside Tauri.
9. No broad UI-accessible SQL execution. Expose domain-specific Rust operations.

## Lifecycle and external services

No backend service is required for core use. Network access is only relevant to optional update checks, which must not block playback. Hiding/minimizing keeps Rust playback active. Explicit Quit stops output, flushes history, persists state, releases OS media session, and exits. Handle tray/menu-bar actions, OS sleep/resume, output-device removal, and WebView reload by reconciling against Rust state.

## Security and scalability

Keep Tauri capabilities narrow and filesystem scopes limited. Treat tags, lyrics, filenames, and playlist paths as untrusted input. Sanitize rendered text/URLs and use parameterized SQL with safe FTS query handling. Avoid shell execution. For 50,000-track targets, use bounded scan pools, virtualized lists, lazy artwork, indexed search, and profiling; targets are not measured until benchmarked.
