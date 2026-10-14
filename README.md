# MichoPlay

MichoPlay is an offline-first music player for Linux, Windows, macOS, and Android. It scans local music folders, reads tags and embedded cover art, and plays local audio. The Android app can import shared audio files into app storage and offers background playback controls.

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

### Desktop

Build the frontend and native desktop bundle:

```sh
npm run build
npm run tauri build
```

Installers and bundles are written under `src-tauri/target/release/bundle/`.

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

The release build runs the frontend build command automatically. For development, use `npm run tauri android dev` instead.

## Project layout

- `src/` — React interface and styles
- `src-tauri/` — Rust/Tauri host, Android project, and native playback integration
- `docs/` — project documentation

The library, playlists, playback queue, and listening history are stored locally. Music files remain on disk on desktop; Android imports are copied into MichoPlay’s app storage.
