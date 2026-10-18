# MichoPlay Design System

**Status:** Proposed visual direction from the product blueprint. Values marked as candidates need validation before a public launch.

## Principles

- Make local music easy to browse and control, with familiar desktop patterns and original MichoPlay branding.
- Keep the interface dark-first, calm, and readable; avoid copying Spotify assets or reproducing proprietary layouts pixel-for-pixel.
- Prioritize artwork and clear hierarchy while keeping controls predictable and accessible.
- Use restrained motion and provide visible feedback for user actions.

## Color tokens

Initial dark theme candidates from the blueprint:

| Token | Candidate | Use |
|---|---|---|
| `--bg` | `#101514` | Main application background |
| `--surface` | `#1A2320` | Cards and panels |
| `--surface-elevated` | `#202B27` | Menus, dialogs, raised surfaces |
| `--text` | `#E9EFEB` | Primary text |
| `--muted` | `#95A29B` | Secondary text and metadata |
| `--accent` | `#D8EEE4` | Brand highlight |
| `--accent-strong` | `#73DDA0` | Playback status indicators |
| `--brand-gradient` | `#F5C6BE → #F5EEE8 → #D8EEE4` | Primary brand gradient |

The app uses deep dark neutral surfaces, the primary blush-to-cream-to-mint gradient, and green for playback. Album, artist, and folder views use available local artwork behind their headings. Check contrast against WCAG AA targets before release. Light mode and configurable accents are later options.

## Typography

- Use Inter or another appropriately licensed modern UI family.
- Desktop body text target: 13–14 px. Use a clear hierarchy for headings, labels, and metadata.
- Support scalable typography and avoid clipping at larger text sizes.

## Layout and spacing

- Main shell: left navigation, center content, optional right Now Playing/Queue/Lyrics panel, and fixed bottom playback bar.
- Compact windows collapse sidebar labels and the right panel before content becomes unusable.
- Proposed breakpoints: compact below 900 px; standard 900–1300 px; wide above 1300 px. Adjust after UX testing.
- Reserve artwork aspect ratios and use skeleton placeholders to prevent layout jumps.
- Use consistent spacing tokens and align repeated cards, rows, and controls.

## Components

- **Navigation:** `AppSidebar`, `MainHeader`, search command, clear selected/hover states.
- **Playback:** `BottomPlayer`, transport controls, volume, progress, repeat/shuffle state.
- **Library:** album/artist/playlist cards; virtualized `TrackRow`; context menus and multi-select affordances.
- **Panels:** queue drawer, lyrics panel, Now Playing panel, visualizer canvas.
- **Feedback:** folder scan banner, empty state, toast, confirm dialog, loading skeleton, keyboard shortcuts dialog.
- **Mini-player:** optional compact always-on-top window with artwork, title, progress, and transport.

Reuse components and keep interaction patterns consistent across screens. Tooltips must not obscure click targets or transport controls.

## Interaction and motion

- Use 100–200 ms transitions for hover/focus and simple state changes.
- Keep artwork motion restrained; respect reduced-motion preferences.
- Show focus rings and tooltips for icon-only actions.
- Keyboard proposals: Space toggles playback outside text fields; Ctrl/Cmd+K opens search; Ctrl/Cmd+L opens library; media keys are handled natively. Keep shortcuts discoverable and configurable where appropriate.

## Accessibility and responsive behavior

- Use semantic roles and accessible labels for controls, with keyboard-first navigation.
- Ensure visible focus, usable contrast, reduced motion, and scalable text.
- Test screen-reader labels and keyboard flows on supported desktop platforms.
- Handle narrow windows and restored mini-player positions after monitor changes.

## Content and states

Design explicit states for no folders, scanning, empty library, no search results, unreadable folders, corrupt tags, unsupported codecs, missing files, unavailable output device, and recovery actions. Explain permission requests in context and never imply cloud access for local features.
