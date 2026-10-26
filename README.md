<p align="center">
  <img src="public/michoplay-logo.svg" width="112" alt="MichoPlay logo" />
</p>

<h1 align="center">MichoPlay</h1>

<p align="center"><strong>A Spotify-inspired local music player.</strong></p>
<p align="center">Play and organize the music you already own, with an offline-first library for desktop and Android.</p>

<p align="center">
  <a href="https://github.com/namz182/michoplay/releases">
    <img src="https://img.shields.io/badge/Download-Latest%20release-f5c6be?style=for-the-badge&logo=github&logoColor=09090b" alt="Download MichoPlay from GitHub Releases" />
  </a>
</p>

## Screenshots

<p align="center">
  <img src="docs/showcase/home.png" alt="MichoPlay home screen showing music folders, recently played tracks, and the playback menu" width="100%" />
</p>
<p align="center"><em>Home, local music folders, playback, and track actions</em></p>

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/showcase/playlist.png" alt="MichoPlay playlist view with image-backed heading, playlist controls, and song list" width="100%" />
      <em>Playlists with artwork and quick controls</em>
    </td>
    <td width="50%" align="center">
      <img src="docs/showcase/youtube.png" alt="MichoPlay YouTube search results with estimated audio sizes and download buttons" width="100%" />
      <em>YouTube search and audio downloads</em>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/showcase/favorites.png" alt="MichoPlay favorites screen with now-playing panel and playback queue" width="100%" />
      <em>Favorites, queue, and now playing</em>
    </td>
    <td width="50%" align="center">
      <img src="docs/showcase/settings.png" alt="MichoPlay playback and appearance settings" width="100%" />
      <em>Playback and appearance settings</em>
    </td>
  </tr>
</table>

## Features

- Scan local music folders and browse songs, albums, artists, and folders with embedded artwork and tags.
- Create playlists, save favorites, search the library, and sort collections.
- Control playback with shuffle, repeat, an editable queue, an equalizer, and a sleep timer.
- Keep listening history and pick up from the last played track.
- Discover local audio on Android and add on-device folders without copying songs into app storage. Keep the indexed library available across restarts and use background playback controls.
- Use keyboard shortcuts and adjust the interface density and zoom.
- Keep your music library and listening data on your device; no streaming account is required.
- On desktop, download YouTube videos or playlists as MP3 audio into `Music/YouTube` and keep them in the YouTube playlist.

MichoPlay is available for Linux, Windows, macOS, and Android.

## Local library data

MichoPlay keeps its library support files in the `.michoplay` directory in the current user's home folder (for example, `/home/user/.michoplay` on Linux). It stores saved music roots and optional scan settings in `config.json`, the track index in `library.sqlite`, and deduplicated artwork files in `artwork/`. The first scan after launch checks the folders; while the app stays open, filesystem watchers let unchanged refreshes reuse the index. File changes mark a library root dirty so the next refresh reconciles it. If watcher support is unavailable, MichoPlay falls back to a normal scan. The database can be rebuilt by refreshing the library. Artwork cache data is capped at 256 MiB. On upgrade, the previous app-data config, JSON index, and artwork cache are copied when their new locations are empty. `scanWorkers` may be set from 1 to 8 in `config.json`; if omitted, MichoPlay chooses a conservative limit based on available CPU cores. `watchLibrary` defaults to `true` and can be set to `false` to disable the watcher.

## Requirements

- Node.js 20.19+ or 22.12+ (Node 24 is also suitable)
- Rust stable and Cargo
- Platform dependencies for Tauri 2
- Android Studio, Android SDK, NDK, and a JDK to build or run the Android app

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific requirements.

### Linux (Debian, Ubuntu, Kali)

Install Tauri’s Linux development libraries and MichoPlay’s ALSA headers:

```sh
sudo apt update
sudo apt install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev libasound2-dev
```

Install Rust with rustup if needed, then load Cargo into the current shell:

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
rustup default stable
```

If `cargo` is missing in a new terminal, run `source "$HOME/.cargo/env"` or open a new login shell. The Tauri command invokes `cargo metadata`, so Cargo must be on `PATH` before running it.

### Android

1. Install Android Studio and, in SDK Manager, install an Android SDK Platform, Platform Tools, Build Tools, Command-line Tools, and an NDK (Side by side).
2. Set the SDK, NDK, and Java paths in the shell used to build. Adjust the NDK version to one installed under `$ANDROID_HOME/ndk`:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
java -version
adb version
```

If `javac` is not on `PATH`, set `JAVA_HOME` to Android Studio’s bundled `jbr` directory (for example, `/opt/android-studio/jbr`).

3. Add the Android Rust targets:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

The Android project is already checked in under `src-tauri/gen/android`. If setting up a fresh copy where that directory is missing, initialize it once with `npm run tauri android init`.

## Install dependencies

From the project root:

```sh
npm ci
```

## Run in development

### Desktop

```sh
npm run tauri dev
```

Tauri starts Vite for you on port `1420`. Run only one development server for this project at a time. If you see `Port 1420 is already in use`, stop the earlier `npm run dev` or `npm run tauri dev` with `Ctrl+C`. If that terminal is no longer available, find the process listening on the port and stop that process:

```sh
ss -ltnp | grep ':1420'
# Replace 12345 only after verifying that PID is the stale Vite process:
kill 12345
```

Then retry `npm run tauri dev`.

### Android device

Enable Developer options and USB debugging on the phone, connect it, and approve the debugging prompt. Confirm ADB can see it, then run the app:

```sh
adb devices
npm run tauri android dev
```

Choose the connected device if the CLI asks. Vite uses Tauri’s `TAURI_DEV_HOST` value for its mobile development server and HMR connection. The Android dev command starts the frontend server, builds the native app, installs it, and launches it on the device. Keep the terminal open while developing.

## Build release apps

### Linux

Run the build on Linux to create the selected package. Tauri places each bundle under `src-tauri/target/release/bundle/`.

```sh
npm run tauri build -- --bundles deb
npm run tauri build -- --bundles rpm
npm run tauri build -- --bundles appimage
```

### Windows

Build an MSI on Windows. WiX, which Tauri uses for MSI packages, only runs on Windows. On Windows, choose either installer:

```powershell
npm run tauri build -- --bundles msi
npm run tauri build -- --bundles nsis
```

#### Build a Windows NSIS installer from Kali/Linux

You can cross-compile the Windows setup `.exe` from Kali or another Debian-based Linux system. Install NSIS, LLVM, and LLD, then install the Windows Rust target and `cargo-xwin`:

```sh
sudo apt install -y nsis lld llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

Build with the Windows target and runner explicitly selected. Running `--bundles nsis` without these options builds for the current Linux system.

```sh
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The installer is created at `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. MSI packages still need to be built on Windows. See the [Tauri Windows installer guide](https://v2.tauri.app/distribute/windows-installer/) for cross-compilation details and caveats.

### macOS

Run these commands on macOS to create an application bundle and disk image:

```sh
npm run tauri build -- --bundles app
npm run tauri build -- --bundles dmg
```

### Android APK or app bundle

Build APKs for local installation/testing:

```sh
npm run tauri android build -- --apk
```

Build an Android App Bundle for store distribution:

```sh
npm run tauri android build -- --aab
```

Outputs are under `src-tauri/gen/android/app/build/outputs/`. Install a generated APK on the connected phone with:

```sh
adb install -r /path/to/generated.apk
```

The release build runs the frontend build command automatically. For development, use `npm run tauri android dev` instead. Tauri’s desktop bundle targets are `deb`, `rpm`, `appimage`, `msi`, `nsis`, `app`, and `dmg`; see the [Tauri distribution guide](https://v2.tauri.app/distribute/) for platform requirements and bundle details.

Your library, playlists, playback queue, and listening history stay on your device. Music files remain in their original folders on desktop and Android. On Android, MichoPlay requests audio access to discover on-device music through MediaStore, and the folder and file pickers add readable on-device paths without copying the audio. Library metadata and artwork are cached in app storage. A provider that exposes only a content URI cannot currently be added to the Rust player; choose a local folder or file instead. Copies imported by older Android versions remain in app storage until removed separately, so upgrading alone does not reclaim their space.

### YouTube audio downloads (desktop)

Desktop bundles include `yt-dlp`, FFmpeg, and Deno. MP3 conversion prefers the bundled FFmpeg and falls back to an `ffmpeg` executable on the system PATH when the bundle does not include an MP3 encoder. The first desktop build downloads the latest release assets for the selected target and verifies their published SHA-256 checksums. This requires network access during the build. Supported targets are Linux x64/arm64, Windows x64, and macOS x64/Apple Silicon. Bundled tool notices are included in the app under `THIRD-PARTY-LICENSES.txt`.

Open **YouTube** directly below **Favorites** in the desktop sidebar and search for a song, or paste a YouTube video or playlist link. Search waits 500 ms after typing, returns 15 flat results per page, and caches recent queries briefly. Search from the centered YouTube field. Result cards identify MP3 audio; use the Download button to add a result directly. Jobs appear in the bottom bar’s **Downloads** panel with byte progress and totals reported by yt-dlp from YouTube; you can pause, resume, cancel, retry, or dismiss them. MichoPlay extracts MP3 audio into the `YouTube` folder inside the operating system’s Music folder, embeds the thumbnail when available, and adds completed tracks to the app playlist and library. On Android, audio is staged temporarily in app cache and the finished MP3 file is saved to the public `Music/MichoPlay/YouTube` folder. See the [yt-dlp dependency notes](https://github.com/yt-dlp/yt-dlp#dependencies) for the tools MichoPlay bundles.
