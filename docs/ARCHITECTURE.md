# MichoPlay Architecture

This document describes the current implementation. The application is a Tauri 2 desktop/mobile shell with a React and TypeScript UI and a Rust core.

## Current structure

```text
src/
  app/                 Main application composition and artwork handling
  components/          Shared UI components
  lib/                 Tauri IPC API, persistent UI storage, utilities
  screens/             Home, library, search, downloads, and settings views
  styles.css           Shared application styles
src-tauri/src/
  lib.rs               Player, library scanner/cache, downloads, platform bridges
  app_data.rs          Persistent UI preferences and legacy-storage migration
```

The frontend calls Rust through `src/lib/api.ts`. Rust owns local audio playback, library scanning, the SQLite library index, and platform media controls. The UI composes screens and maintains transient navigation and interaction state.

## Storage

- `library.sqlite` stores the scanned track index and metadata cache. Artwork files live beside it in the app data directory.
- `app-data.sqlite` stores durable UI preferences and user collections as keyed JSON values. Existing `michoplay-*` WebView storage is copied into SQLite on first launch; local storage remains a compatibility mirror and browser fallback.
- The library config stores selected roots and scan options. Library files stay in their original folders; imported audio is copied into app-managed `Music` storage.

The track index is rebuilt per successfully scanned root. If a configured root is unavailable, its cached records must be retained until that root can be scanned again.

## Platform and external services

Core playback and library browsing work offline. YouTube search/download and release checks require network access and depend on upstream services. Desktop media controls use the platform bridge; Android media controls use the native plugin. These integrations still need validation on each supported OS and device.

Desktop downloads default to the user's system Music folder, with a home `Music` fallback, and share the resolved `YouTube` directory with library scanning. yt-dlp reports final MP3 paths as JSON strings with UTF-8 output so desktop encodings cannot strip filename characters. Workers verify each file before optional artwork embedding and again before marking the download complete. Download failures distinguish missing files, unreadable save locations, access permissions, empty files, unsupported formats, and MP3 conversion failures. The UI preserves approved native messages and classifies other tool output without displaying debug logs, file paths, or operating system error details.

## Known implementation limits

- `src-tauri/src/lib.rs` still contains several domains in one module; continue extracting library scanning, playback, downloads, and platform integration behind focused modules.
- `src/app/App.tsx` remains the main UI composition file. Screen components have been extracted, but feature state and some rendering logic remain there.
- Library tracks and playback transport are Rust-owned, while playlist/favorite/history/preference records are persisted as JSON values in app-data SQLite rather than normalized domain tables.
- Player session recovery currently uses a saved UI session; lifecycle and crash-recovery behavior still needs platform verification.
- Automated checks and release validation are incomplete. See `TASKS.md` for outstanding work.

## Data safety rules

1. Do not remove cached tracks for roots that were not successfully scanned.
2. Validate complete import batches before committing files; roll back staged files if a commit fails.
3. Use parameterized SQL and transactions for multi-record updates.
4. Treat filenames, tags, and downloaded metadata as untrusted input.
5. Keep playback independent of the WebView lifetime and reconcile UI state with Rust after reload.
