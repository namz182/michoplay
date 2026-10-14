# MichoPlay Development Rules

These rules translate the product blueprint into working constraints. The blueprint is a proposal; confirm behavior in code before documenting it as implemented.

## General

- Read `PRD.md`, `ARCHITECTURE.md`, `DESIGN.md`, `TASKS.md`, and `MEMORY.md` before starting feature work.
- Follow the existing structure and established patterns. Keep changes scoped to the requested feature.
- Prefer simple, maintainable implementations; reuse shared components and domain logic.
- Update the relevant docs when requirements, architecture, conventions, visuals, task status, or important decisions change.
- Do not claim proposed functionality, platform support, performance, or test coverage as delivered without evidence.

## Rust and application boundaries

- Rust owns playback state, queue transitions, filesystem access, and SQLite access.
- Keep all frontend-to-core calls behind typed command adapters and typed DTOs.
- Validate every IPC input in Rust, even when the UI also validates it.
- Return typed internal errors and map them to useful, safe user messages at the boundary.
- Do not expose arbitrary SQL or shell execution to the frontend.
- Keep player/DSP logic testable independently of Tauri where practical.

## Audio and concurrency

- Never block the real-time audio callback on database, filesystem, network, IPC, logging, or unbounded work.
- Use bounded channels/buffers and worker threads for scanning, metadata, FFT, and persistence.
- Serialize queue/player transitions through one authoritative controller.
- Throttle position/progress/visualizer events; avoid rerendering large lists at playback frequency.
- Treat codec support and gapless/crossfade behavior as build and fixture verified, not assumed from dependency names.
- Preserve explicit volume/headroom behavior when adding ReplayGain, EQ, or limiting; provide clear bypass/disable behavior.

## Data and database

- Keep SQLite owned by Rust through sqlx and migrations. Use parameterized queries and transactions for multi-step changes.
- Enable foreign keys and WAL. Keep timestamp and duration units consistent; durations/positions use integer milliseconds.
- Maintain FTS5 as an explicit projection across related artist/album changes, not only track-row edits.
- Never delete or modify source audio without a deliberate user action and confirmation. Library removal defaults to non-destructive behavior.
- Calculate file hashes lazily for duplicate work; avoid hashing every file on initial import.
- Handle platform-specific path identity, case sensitivity, removable drives, and symlinks deliberately.

## Filesystem, security, and privacy

- Only read/index locations selected by the user. Canonicalize and validate access against approved roots.
- Treat metadata, paths, playlist files, lyrics, and artwork as untrusted input; sanitize anything rendered or interpreted.
- Use least-privilege Tauri capabilities and explicit scopes. Do not grant broad home-directory or disk access by default.
- Do not upload music, artwork, listening history, or file paths. Core workflows must function offline.
- No mandatory analytics or unexpected external requests. Optional update checks stay separate from playback.
- Default logs omit raw file paths, track names, and sensitive content. Never log secrets or tokens.
- Validate playlist paths and warn about missing files; do not execute imported content.

## Frontend and accessibility

- React state is for presentation; do not duplicate authoritative playback logic in Zustand.
- Use semantic controls, accessible names, visible focus, keyboard navigation, and reduced-motion handling.
- Keep long library lists virtualized and artwork lazy-loaded/cached.
- Include empty, loading, scanning, unavailable, unsupported, and error states for new flows.
- Follow tokens and patterns in `DESIGN.md`; avoid one-off styling without updating the design system when reusable.

## Dependencies and platform behavior

- Do not introduce a framework or major dependency that conflicts with the architecture without recording the decision.
- Verify current APIs, licenses, platform support, and codec feature flags before selecting/upgrading dependencies.
- Isolate OS media/session, tray, output-device, and lifecycle differences behind platform modules.
- Do not promise a platform integration until validated on that operating system.

## Verification and completion

- Follow the task's acceptance criteria and applicable project verification instructions.
- Cover relevant error paths and accessibility behavior, not only the happy path.
- Use licensed or synthetic audio fixtures only.
- Record what was verified and on which platform; distinguish automated checks from manual checks.
- Mark a roadmap item complete only when its acceptance criteria are met.
