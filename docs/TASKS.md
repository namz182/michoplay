# MichoPlay Development Tasks

**Status:** Initial roadmap derived from the blueprint. Foundation scaffolding has been created; feature work remains unstarted unless explicitly marked otherwise.

## Phase 0 — Foundations

- [x] **TASK-001 — Bootstrap desktop app:** Tauri 2, React, TypeScript, Vite, Tailwind, and shared component foundation. Initial shell and folder picker scaffold created; library scanning is not included.
- [ ] **TASK-002 — Configure engineering checks:** strict types, lint/format, frontend and Rust test scaffolding, CI matrix.
- [ ] **TASK-003 — Add Rust core foundations:** typed errors, tracing, IPC DTO conventions, module layout.
- [ ] **TASK-004 — Add SQLite migrations:** sqlx setup, test database, base schema and migration policy.
- [ ] **TASK-005 — Prove native playback and lifecycle:** selected local track plays/pauses and continues while window is hidden on a primary OS.

## Phase 1 — Offline library and core player (P0)

- [ ] **TASK-006 — Import library roots:** native folder selection; add/remove roots; persist selection and status.
- [ ] **TASK-007 — Scan and extract metadata:** recursive bounded scan, Lofty metadata/artwork, progress, cancellation, per-file recovery.
- [ ] **TASK-008 — Build catalog views:** songs, albums, artists, details, artwork cache, empty/error states.
- [ ] **TASK-009 — Implement player controller:** Rust-owned transport state, typed commands/events, seek and volume.
- [ ] **TASK-010 — Implement queue semantics:** add/reorder/remove, repeat, deterministic shuffle, previous behavior, end handling.
- [ ] **TASK-011 — Persist and restore player state:** recent queue/position, volume, repeat/shuffle, output policy.
- [ ] **TASK-012 — Add manual playlists and favorites:** CRUD, ordering, favorites, transactional persistence.
- [ ] **TASK-013 — Add local indexed search:** FTS5 projection and categorized, debounced UI results.
- [ ] **TASK-014 — Verify core offline slice:** 1,000-track fixture import, offline playback, playlists, and search on reference platform.

**Implementation note (2026-10-14):** Initial folder scanning and in-memory playback commands now exist for local audio files. The roadmap items remain open until persistence, recovery, queue behavior, and supported-platform playback are verified against the stated acceptance criteria.

**Implementation note (2026-10-14):** Current UI and core work adds recursive folder/album/artist detail pages, embedded and folder cover loading, local playlists/favorites, scoped search, adjustable panes, library refresh, and editable playback queue. Playlists and preferences are persisted in WebView local storage for now; these features still need the SQLite migration and full platform acceptance checks before the roadmap items can be closed.

## Phase 2 — Desktop integration and UX (P1)

- [ ] **TASK-015 — Complete desktop shell:** home, sidebar, bottom player, queue, responsive layouts, shortcuts.
- [ ] **TASK-016 — Add tray and close behavior:** hide/minimize preferences, tray menu, explicit Quit handling.
- [ ] **TASK-017 — Add OS media controls:** Windows SMTC, Linux MPRIS, macOS Now Playing/media keys where supported.
- [ ] **TASK-018 — Add mini-player:** compact window, position recovery, always-on-top preference.
- [ ] **TASK-019 — Handle window/device lifecycle:** WebView reconnect, suspend/resume, output disconnect and fallback.
- [ ] **TASK-020 — Verify desktop integration on target OSes.**

## Phase 3 — Advanced audio and lyrics (P1)

- [ ] **TASK-021 — Implement equalizer:** 10 bands, presets, preamp, bypass, headroom behavior.
- [ ] **TASK-022 — Implement ReplayGain:** track/album/no-gain modes and clipping safeguards.
- [ ] **TASK-023 — Validate preloading and gapless behavior:** codec fixtures and album transition cases.
- [ ] **TASK-024 — Implement crossfade:** configurable 0–12 seconds, repeat-one and album-gapless rules.
- [ ] **TASK-025 — Add local lyrics:** embedded text and `.lrc`, synchronized highlighting, manual offset.
- [ ] **TASK-026 — Add visualizer:** worker-based FFT, bounded/decimated data, pause when hidden.

## Phase 4 — Library intelligence and polish (P1/P2)

- [ ] **TASK-027 — Add playback statistics:** listened-time sessions, thresholds, opt-out, clear/export controls.
- [ ] **TASK-028 — Add filesystem refresh:** watcher plus reconciliation for moved, removed, renamed files.
- [ ] **TASK-029 — Add smart playlists:** validated dynamic rules for genre, favorites, last played, rating, and dates.
- [ ] **TASK-030 — Profile large libraries:** synthetic 50,000-track scan/search/scroll benchmark and measured results.
- [ ] **TASK-031 — Complete accessibility and theme checks:** keyboard, labels, focus, contrast, reduced motion, scalable type.
- [ ] **TASK-032 — Evaluate tag editing and M3U8:** non-destructive editing and portable playlist import/export.

## Phase 5 — Release readiness

- [ ] **TASK-033 — Package target platforms:** Windows installer, Linux packages, macOS DMG; clean install/uninstall checks.
- [ ] **TASK-034 — Configure signing and updates:** signed packages/update feed; update checks never block playback.
- [ ] **TASK-035 — Complete privacy, license, and recovery review:** no unexpected network access, crash recovery, dependency/license audit.
- [ ] **TASK-036 — Run release test matrix:** codecs, long playback, device changes, sleep/resume, large libraries, supported desktop environments.
- [ ] **TASK-037 — Prepare beta release notes and support docs.**

## Definition of done

- Acceptance criteria and relevant loading, empty, error, and recovery states are met.
- Database/filesystem operations are validated and transactional where needed.
- Audio callbacks remain free from blocking work; resource use is bounded.
- Keyboard and accessibility behavior is checked for UI work.
- Verification is recorded with the tested OS/build. A task is marked complete only after its stated gate is satisfied.

## Delivery gates

- **Alpha A:** library import, play/pause, player bar, playlists, local search.
- **Alpha B:** tray, native media controls, mini-player, restore state.
- **Beta:** EQ, ReplayGain, tested transitions, synchronized lyrics, statistics, visualizer.
- **v1.0:** stable installers, accessibility, measured performance, signed updates, and documentation.
