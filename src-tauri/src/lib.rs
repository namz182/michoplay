use base64::{engine::general_purpose::STANDARD, Engine};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::ItemKey,
};
use rodio::{
    source::SeekError, ChannelCount, Decoder, OutputStream, OutputStreamBuilder, SampleRate, Sink,
    Source,
};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use souvlaki::{MediaControls, MediaMetadata, MediaPlayback, PlatformConfig};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Emitter;
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

const EQ_FREQUENCIES: [f32; 6] = [60.0, 150.0, 400.0, 1_000.0, 2_400.0, 15_000.0];

#[derive(Clone, Copy)]
struct BiquadCoefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Default for BiquadCoefficients {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct BiquadState {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

struct EqualizerSource<S: Source> {
    input: S,
    bands: Arc<[AtomicU32; 6]>,
    enabled: Arc<AtomicBool>,
    was_enabled: bool,
    states: Vec<[BiquadState; 6]>,
    gains: [u32; 6],
    coefficients: [BiquadCoefficients; 6],
    channel: usize,
}

impl<S: Source> EqualizerSource<S> {
    fn new(input: S, bands: Arc<[AtomicU32; 6]>, enabled: Arc<AtomicBool>) -> Self {
        let channels = usize::from(input.channels()).max(1);
        let sample_rate = input.sample_rate();
        let gains = std::array::from_fn(|index| bands[index].load(Ordering::Relaxed));
        let coefficients = std::array::from_fn(|index| {
            eq_coefficients(
                f32::from_bits(gains[index]),
                EQ_FREQUENCIES[index],
                sample_rate,
            )
        });
        Self {
            input,
            bands,
            enabled: enabled.clone(),
            was_enabled: enabled.load(Ordering::Relaxed),
            states: vec![[BiquadState::default(); 6]; channels],
            gains,
            coefficients,
            channel: 0,
        }
    }
}

fn eq_coefficients(gain_db: f32, frequency: f32, sample_rate: SampleRate) -> BiquadCoefficients {
    if gain_db.abs() < 0.001 {
        return BiquadCoefficients::default();
    }
    let frequency = frequency.min(sample_rate as f32 * 0.45).max(1.0);
    let omega = 2.0 * std::f32::consts::PI * frequency / sample_rate as f32;
    let alpha = omega.sin() / (2.0 * 1.15);
    let a = 10.0_f32.powf(gain_db / 40.0);
    let a0 = 1.0 + alpha / a;
    BiquadCoefficients {
        b0: (1.0 + alpha * a) / a0,
        b1: (-2.0 * omega.cos()) / a0,
        b2: (1.0 - alpha * a) / a0,
        a1: (-2.0 * omega.cos()) / a0,
        a2: (1.0 - alpha / a) / a0,
    }
}

impl<S: Source> Iterator for EqualizerSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        let mut sample = self.input.next()?;
        let enabled = self.enabled.load(Ordering::Relaxed);
        if enabled != self.was_enabled {
            self.states.fill([BiquadState::default(); 6]);
            self.was_enabled = enabled;
        }
        if !enabled {
            self.channel = (self.channel + 1) % self.states.len();
            return Some(sample);
        }
        for index in 0..6 {
            let gain = self.bands[index].load(Ordering::Relaxed);
            if gain != self.gains[index] {
                self.gains[index] = gain;
                self.coefficients[index] = eq_coefficients(
                    f32::from_bits(gain),
                    EQ_FREQUENCIES[index],
                    self.input.sample_rate(),
                );
            }
            let coefficient = self.coefficients[index];
            let state = &mut self.states[self.channel][index];
            let output =
                coefficient.b0 * sample + coefficient.b1 * state.x1 + coefficient.b2 * state.x2
                    - coefficient.a1 * state.y1
                    - coefficient.a2 * state.y2;
            state.x2 = state.x1;
            state.x1 = sample;
            state.y2 = state.y1;
            state.y1 = output;
            sample = output;
        }
        self.channel = (self.channel + 1) % self.states.len();
        Some(sample)
    }
}

impl<S: Source> Source for EqualizerSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.input.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.input.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.input.try_seek(position)?;
        self.states.fill([BiquadState::default(); 6]);
        self.channel = 0;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    id: u64,
    title: String,
    artist: String,
    album: String,
    release_date: String,
    duration_ms: u64,
    added_at: u64,
    folder_path: String,
    folder_name: String,
    root_path: String,
    folders: Vec<Folder>,
    artwork_key: Option<String>,
}

#[derive(Clone, Serialize)]
struct Folder {
    path: String,
    name: String,
}

struct Artwork {
    mime: String,
    data: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAudioFile {
    name: String,
    data_base64: String,
}

struct LibraryTrack {
    track: Track,
    path: PathBuf,
    artwork: Option<Arc<Artwork>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSnapshot {
    current_track_id: Option<u64>,
    is_playing: bool,
    position_ms: u64,
    duration_ms: u64,
    volume: f32,
    shuffle: bool,
    repeat_mode: String,
    queue: Vec<u64>,
    autoplay: bool,
    priority_queue: Vec<u64>,
    sleep_timer_remaining_ms: Option<u64>,
    sleep_timer_at_track_end: bool,
    equalizer_bands: [f32; 6],
    equalizer_enabled: bool,
}

#[derive(Default)]
struct PlayerCore {
    roots: Vec<PathBuf>,
    tracks: Vec<LibraryTrack>,
    queue: Vec<u64>,
    current_queue_index: Option<usize>,
    output: Option<OutputStream>,
    sink: Option<Sink>,
    output_failed: Arc<AtomicBool>,
    is_playing: bool,
    volume: f32,
    shuffle: bool,
    repeat_mode: String,
    autoplay: bool,
    priority_queue: Vec<u64>,
    sleep_timer_deadline: Option<SystemTime>,
    sleep_timer_at_track_end: bool,
    equalizer_bands: Arc<[AtomicU32; 6]>,
    equalizer_enabled: Arc<AtomicBool>,
}

struct AppState(Mutex<PlayerCore>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct MediaBridge(Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>>);

#[cfg(target_os = "linux")]
struct DesktopMediaBridge(Mutex<Option<MediaControls>>);
#[cfg(not(target_os = "linux"))]
struct DesktopMediaBridge;

struct PendingAudioOpens(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_audio_opens(state: State<'_, PendingAudioOpens>) -> Result<Vec<String>, String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Opened audio files are unavailable.".to_owned())?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
fn media_take_opened_audio(
    state: State<'_, MediaBridge>,
) -> Result<Vec<ImportedAudioFile>, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = state
            .0
            .lock()
            .map_err(|_| "Media controls are unavailable.".to_owned())?;
        if let Some(handle) = bridge.as_ref() {
            return handle
                .run_mobile_plugin("takeOpenedAudio", ())
                .map_err(|error| error.to_string());
        }
        return Ok(Vec::new());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = state;
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn library_open_audio_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    if paths.is_empty() || paths.len() > 100 {
        return Err("Choose between 1 and 100 audio files.".to_owned());
    }
    let mut selected = Vec::new();
    for value in paths {
        let path = PathBuf::from(value)
            .canonicalize()
            .map_err(|_| "That audio file is no longer available.".to_owned())?;
        if !path.is_file() || !supported_audio(&path) {
            continue;
        }
        if !selected.contains(&path) {
            selected.push(path);
        }
    }
    if selected.is_empty() {
        return Err("No supported audio files were found.".to_owned());
    }
    let mut roots = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .roots
        .clone();
    for path in &selected {
        if let Some(parent) = path.parent() {
            let root = parent.to_path_buf();
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    let roots_copy = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || scan_roots(&roots_copy))
        .await
        .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let selected_ids = tracks
        .iter()
        .filter(|track| selected.contains(&track.path))
        .map(|track| track.track.id)
        .collect::<Vec<_>>();
    if selected_ids.is_empty() {
        return Err("Those audio files could not be added to the library.".to_owned());
    }
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    let views = core.replace_library(roots, tracks);
    core.queue = selected_ids;
    core.priority_queue.clear();
    core.play_queue_index(0)?;
    Ok(views)
}

#[tauri::command]
fn system_set_default_player() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let desktop_id = "michoplay.desktop";
        let mime_types = [
            "audio/mpeg",
            "audio/flac",
            "audio/wav",
            "audio/ogg",
            "audio/opus",
            "audio/mp4",
            "audio/aac",
            "audio/aiff",
        ];
        for mime in mime_types {
            let status = std::process::Command::new("xdg-mime")
                .args(["default", desktop_id, mime])
                .status()
                .map_err(|_| {
                    "Install MichoPlay as a desktop app before setting it as the default player."
                        .to_owned()
                })?;
            if !status.success() {
                return Err(
                    "The system could not set MichoPlay as the default audio player.".to_owned(),
                );
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(
            "Choose MichoPlay as the default music app in your system’s Default Apps settings."
                .to_owned(),
        )
    }
}

#[tauri::command]
fn media_update(
    title: Option<String>,
    artist: Option<String>,
    is_playing: bool,
    duration_ms: u64,
    position_ms: u64,
    state: State<'_, MediaBridge>,
    desktop: State<'_, DesktopMediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = state
            .0
            .lock()
            .map_err(|_| "Media controls are unavailable.".to_owned())?;
        if let Some(handle) = bridge.as_ref() {
            handle
                .run_mobile_plugin::<()>(
                    "update",
                    serde_json::json!({
                        "title": title.unwrap_or_default(),
                        "artist": artist.unwrap_or_default(),
                        "isPlaying": is_playing,
                        "durationMs": duration_ms,
                        "positionMs": position_ms,
                    }),
                )
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut controls = desktop
            .0
            .lock()
            .map_err(|_| "System media controls are unavailable.".to_owned())?;
        if let Some(controls) = controls.as_mut() {
            if let Some(title) = title.as_deref() {
                controls
                    .set_metadata(MediaMetadata {
                        title: Some(title),
                        artist: artist.as_deref(),
                        duration: Some(Duration::from_millis(duration_ms)),
                        ..Default::default()
                    })
                    .map_err(|error| error.to_string())?;
                let progress = Some(souvlaki::MediaPosition(Duration::from_millis(position_ms)));
                controls
                    .set_playback(if is_playing {
                        MediaPlayback::Playing { progress }
                    } else {
                        MediaPlayback::Paused { progress }
                    })
                    .map_err(|error| error.to_string())?;
            } else {
                controls
                    .set_playback(MediaPlayback::Stopped)
                    .map_err(|error| error.to_string())?;
            }
        }
        let _ = &state;
    }
    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    let _ = (title, artist, is_playing, duration_ms, position_ms, state);
    #[cfg(not(target_os = "linux"))]
    let _ = desktop;
    Ok(())
}

#[tauri::command]
fn media_stop(state: State<'_, MediaBridge>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = state
            .0
            .lock()
            .map_err(|_| "Media controls are unavailable.".to_owned())?;
        if let Some(handle) = bridge.as_ref() {
            handle
                .run_mobile_plugin::<()>("stop", ())
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = state;
    Ok(())
}

fn supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "aiff" | "aif"
            )
        })
        .unwrap_or(false)
}

fn read_track(path: &Path, id: u64, root: &Path, sidecar: Option<Arc<Artwork>>) -> LibraryTrack {
    let mut artwork = sidecar;
    let fallback_title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Unknown track")
        .to_owned();

    let (title, artist, album, release_date, duration_ms) = Probe::open(path)
        .and_then(|probe| probe.read())
        .map(|tagged| {
            if let Some(picture) = tagged
                .tags()
                .iter()
                .flat_map(|tag| tag.pictures())
                .find(|picture| picture.pic_type() == lofty::picture::PictureType::CoverFront)
                .or_else(|| tagged.tags().iter().flat_map(|tag| tag.pictures()).next())
            {
                if picture.data().len() <= 8 * 1024 * 1024 {
                    if let Some(mime) = picture.mime_type() {
                        let mime = mime.to_string();
                        if matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") {
                            artwork = Some(Arc::new(Artwork {
                                mime,
                                data: picture.data().to_vec(),
                            }));
                        }
                    }
                }
            }
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
            let get = |key: ItemKey, fallback: &str| {
                tag.and_then(|tag| tag.get_string(key))
                    .map(str::to_owned)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| fallback.to_owned())
            };
            let props = tagged.properties();
            (
                get(ItemKey::TrackTitle, &fallback_title),
                get(ItemKey::TrackArtist, "Unknown artist"),
                get(ItemKey::AlbumTitle, "Unknown album"),
                tag.and_then(|tag| {
                    tag.get_string(ItemKey::ReleaseDate)
                        .or_else(|| tag.get_string(ItemKey::RecordingDate))
                })
                .unwrap_or_default()
                .to_owned(),
                props.duration().as_millis().min(u64::MAX as u128) as u64,
            )
        })
        .unwrap_or_else(|_| {
            (
                fallback_title,
                "Unknown artist".to_owned(),
                "Unknown album".to_owned(),
                String::new(),
                0,
            )
        });
    let added_at = path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default();

    let parent = path.parent().unwrap_or(root);
    let mut folders = Vec::new();
    let mut ancestor = Some(parent);
    while let Some(folder) = ancestor {
        if !folder.starts_with(root) {
            break;
        }
        folders.push(Folder {
            path: folder.to_string_lossy().into_owned(),
            name: folder
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Music")
                .to_owned(),
        });
        ancestor = folder.parent();
    }
    let artwork_key = artwork.as_ref().map(|art| {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        art.data.hash(&mut hash);
        format!("{:x}", hash.finish())
    });
    LibraryTrack {
        track: Track {
            id,
            title,
            artist,
            album,
            release_date,
            duration_ms,
            added_at,
            folder_path: parent.to_string_lossy().into_owned(),
            folder_name: parent
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Music")
                .to_owned(),
            root_path: root.to_string_lossy().into_owned(),
            folders,
            artwork_key,
        },
        path: path.to_owned(),
        artwork,
    }
}

fn read_folder_art(folder: &Path) -> Option<Arc<Artwork>> {
    let mut images = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "jpg" | "jpeg" | "png" | "webp"
                    )
                })
        })
        .collect::<Vec<_>>();
    images.sort_by_key(|path| {
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        (
            if matches!(
                stem.as_str(),
                "cover" | "folder" | "front" | "album" | "artwork"
            ) {
                0
            } else {
                1
            },
            path.clone(),
        )
    });
    for path in images {
        if std::fs::metadata(&path).ok()?.len() > 8 * 1024 * 1024 {
            continue;
        }
        let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        if let Ok(data) = std::fs::read(path) {
            return Some(Arc::new(Artwork {
                mime: mime.to_owned(),
                data,
            }));
        }
    }
    None
}

fn scan_roots(roots: &[PathBuf]) -> Result<Vec<LibraryTrack>, String> {
    let mut paths = Vec::new();
    for root in roots {
        let Ok(canonical) = root.canonicalize() else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        for entry in WalkDir::new(canonical)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if entry.file_type().is_file() && supported_audio(entry.path()) {
                if let Ok(path) = entry.path().canonicalize() {
                    paths.push(path);
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    let mut folder_art = HashMap::new();
    let mut result = Vec::new();
    for path in paths {
        let Some(root) = roots
            .iter()
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.components().count())
        else {
            continue;
        };
        let parent = path.parent().unwrap_or(root).to_owned();
        let art = folder_art
            .entry(parent.clone())
            .or_insert_with(|| read_folder_art(&parent))
            .clone();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut hasher);
        // IPC numbers must survive JavaScript's 53-bit integer representation exactly.
        let id = hasher.finish() & ((1u64 << 53) - 1);
        result.push(read_track(&path, id, root, art));
    }
    Ok(result)
}

impl PlayerCore {
    fn discard_failed_output(&mut self) {
        if self.output_failed.swap(false, Ordering::AcqRel) {
            self.is_playing = false;
            self.sink = None;
            self.output = None;
        }
    }

    fn queue_add(&mut self, track_id: u64) -> Result<(), String> {
        self.find_track_index(track_id)?;
        if self
            .current_queue_index
            .and_then(|index| self.queue.get(index))
            .copied()
            == Some(track_id)
        {
            return Ok(());
        }
        if let Some(existing) = self.queue.iter().position(|id| *id == track_id) {
            let current = self.current_queue_index;
            self.queue.remove(existing);
            if let Some(index) = current {
                if existing < index {
                    self.current_queue_index = Some(index - 1);
                }
            }
        }
        let insert_at = self.current_queue_index.map(|index| index + 1).unwrap_or(0);
        self.priority_queue.retain(|id| *id != track_id);
        self.priority_queue.insert(0, track_id);
        let insert_at = insert_at.min(self.queue.len());
        self.queue.insert(insert_at, track_id);
        Ok(())
    }

    fn queue_move(&mut self, from_index: usize, to_index: usize) -> Result<(), String> {
        let offset = self.current_queue_index.map(|index| index + 1).unwrap_or(0);
        let remaining = self.queue.len().saturating_sub(offset);
        if from_index >= remaining || to_index >= remaining {
            return Err("That queue position is no longer available.".to_owned());
        }
        let id = self.queue.remove(offset + from_index);
        self.queue.insert(offset + to_index, id);
        self.priority_queue = self.queue.iter().skip(offset).copied().collect();
        Ok(())
    }

    fn queue_remove(&mut self, index: usize) -> Result<(), String> {
        let offset = self.current_queue_index.map(|index| index + 1).unwrap_or(0);
        if index >= self.queue.len().saturating_sub(offset) {
            return Err("That queue position is no longer available.".to_owned());
        }
        let id = self.queue.remove(offset + index);
        self.priority_queue.retain(|queued| *queued != id);
        Ok(())
    }

    fn replace_library(&mut self, roots: Vec<PathBuf>, tracks: Vec<LibraryTrack>) -> Vec<Track> {
        let views = tracks.iter().map(|track| track.track.clone()).collect();
        let current_id = self
            .current_queue_index
            .and_then(|index| self.queue.get(index))
            .copied();
        self.roots = roots;
        self.tracks = tracks;
        let valid = self
            .tracks
            .iter()
            .map(|track| track.track.id)
            .collect::<HashSet<_>>();
        self.queue.retain(|id| valid.contains(id));
        self.priority_queue.retain(|id| valid.contains(id));
        let added = self
            .tracks
            .iter()
            .map(|track| track.track.id)
            .filter(|id| !self.queue.contains(id))
            .collect::<Vec<_>>();
        self.queue.extend(added);
        self.current_queue_index =
            current_id.and_then(|id| self.queue.iter().position(|queued| *queued == id));
        if self.current_queue_index.is_none() {
            self.is_playing = false;
            if let Some(sink) = &self.sink {
                sink.stop();
            }
        }
        views
    }

    fn random_next_index(&self, current: usize) -> usize {
        if self.queue.len() < 2 {
            return current;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as usize;
        let offset = nanos % (self.queue.len() - 1) + 1;
        (current + offset) % self.queue.len()
    }

    fn next_index(&self, current: usize) -> Option<usize> {
        if let Some(id) = self.priority_queue.first() {
            if let Some(index) = self.queue.iter().position(|queued| queued == id) {
                return Some(index);
            }
        }
        if self.shuffle {
            return Some(self.random_next_index(current));
        }
        if current + 1 < self.queue.len() {
            Some(current + 1)
        } else if self.repeat_mode == "all" {
            Some(0)
        } else {
            None
        }
    }

    fn find_track_index(&self, id: u64) -> Result<usize, String> {
        self.tracks
            .iter()
            .position(|track| track.track.id == id)
            .ok_or_else(|| {
                "That song is no longer in the library. Refresh the folder and try again."
                    .to_owned()
            })
    }

    fn play_queue_index(&mut self, queue_index: usize) -> Result<(), String> {
        self.discard_failed_output();
        let track_id = *self
            .queue
            .get(queue_index)
            .ok_or_else(|| "There is no song at that position in the queue.".to_owned())?;
        let track_index = self.find_track_index(track_id)?;
        let path = self.tracks[track_index].path.clone();
        let file = File::open(&path).map_err(|_| "This music file can’t be opened.".to_owned())?;
        let source = Decoder::try_from(file)
            .map_err(|_| "This audio format could not be decoded.".to_owned())?;
        if self.tracks[track_index].track.duration_ms == 0 {
            self.tracks[track_index].track.duration_ms = source
                .total_duration()
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or(0);
        }

        if self.output.is_none() {
            let output_failed = self.output_failed.clone();
            self.output = Some(
                OutputStreamBuilder::from_default_device()
                    .and_then(|builder| {
                        builder
                            .with_buffer_size(rodio::cpal::BufferSize::Fixed(2048))
                            .with_error_callback(move |_error| {
                                output_failed.store(true, Ordering::Release);
                            })
                            .open_stream_or_fallback()
                    })
                    .map_err(|_| "No audio output device is available.".to_owned())?,
            );
        }
        if self.sink.is_none() {
            let sink =
                Sink::connect_new(&self.output.as_ref().expect("output initialized").mixer());
            sink.set_volume(self.volume.clamp(0.0, 1.0));
            self.sink = Some(sink);
        }
        let sink = self.sink.as_ref().expect("sink initialized");
        sink.clear();
        sink.append(EqualizerSource::new(
            source,
            self.equalizer_bands.clone(),
            self.equalizer_enabled.clone(),
        ));
        sink.play();
        self.current_queue_index = Some(queue_index);
        let upcoming = self
            .queue
            .iter()
            .skip(queue_index + 1)
            .copied()
            .collect::<HashSet<_>>();
        self.priority_queue.retain(|id| upcoming.contains(id));
        self.is_playing = true;
        Ok(())
    }

    fn play_track(&mut self, id: u64) -> Result<(), String> {
        self.find_track_index(id)?;
        if let Some(index) = self.queue.iter().position(|queued_id| *queued_id == id) {
            self.play_queue_index(index)
        } else {
            self.queue.push(id);
            self.play_queue_index(self.queue.len() - 1)
        }
    }

    fn snapshot(&mut self) -> PlayerSnapshot {
        self.discard_failed_output();
        let track_ended = self.is_playing && self.sink.as_ref().is_some_and(Sink::empty);
        let timer_expired = self
            .sleep_timer_deadline
            .is_some_and(|deadline| SystemTime::now() >= deadline);
        if timer_expired || (track_ended && self.sleep_timer_at_track_end) {
            if let Some(sink) = &self.sink {
                sink.pause();
            }
            self.is_playing = false;
            self.sleep_timer_deadline = None;
            self.sleep_timer_at_track_end = false;
        } else if track_ended {
            let current = self.current_queue_index.unwrap_or(0);
            if self.repeat_mode == "one" && self.priority_queue.is_empty() {
                let _ = self.play_queue_index(current);
            } else {
                if self.autoplay || !self.priority_queue.is_empty() {
                    if let Some(next) = self.next_index(current) {
                        let _ = self.play_queue_index(next);
                    } else {
                        self.is_playing = false;
                    }
                } else {
                    self.is_playing = false;
                }
            }
        }
        let current_track = self
            .current_queue_index
            .and_then(|index| self.queue.get(index))
            .and_then(|id| self.tracks.iter().find(|track| track.track.id == *id));
        let position_ms = self
            .sink
            .as_ref()
            .map(|sink| sink.get_pos().as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0);

        PlayerSnapshot {
            current_track_id: current_track.map(|track| track.track.id),
            is_playing: self.is_playing,
            position_ms,
            duration_ms: current_track
                .map(|track| track.track.duration_ms)
                .unwrap_or(0),
            volume: self.volume,
            shuffle: self.shuffle,
            repeat_mode: self.repeat_mode.clone(),
            queue: self
                .queue
                .iter()
                .skip(self.current_queue_index.map(|index| index + 1).unwrap_or(0))
                .copied()
                .collect(),
            priority_queue: self.priority_queue.clone(),
            autoplay: self.autoplay,
            sleep_timer_remaining_ms: self.sleep_timer_deadline.and_then(|deadline| {
                deadline
                    .duration_since(SystemTime::now())
                    .ok()
                    .map(|remaining| remaining.as_millis().min(u64::MAX as u128) as u64)
            }),
            sleep_timer_at_track_end: self.sleep_timer_at_track_end,
            equalizer_bands: std::array::from_fn(|index| {
                f32::from_bits(self.equalizer_bands[index].load(Ordering::Relaxed))
            }),
            equalizer_enabled: self.equalizer_enabled.load(Ordering::Relaxed),
        }
    }
}

#[tauri::command]
async fn library_scan_folder(
    folder: String,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    let path = PathBuf::from(folder);
    let canonical = path
        .canonicalize()
        .map_err(|_| "The selected music folder can’t be accessed.".to_owned())?;
    if !canonical.is_dir() {
        return Err("The selected path is not a folder.".to_owned());
    }

    let mut roots = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        core.roots.clone()
    };
    if !roots.contains(&canonical) {
        roots.push(canonical.clone());
    }
    let scan_roots_copy = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || scan_roots(&scan_roots_copy))
        .await
        .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    Ok(core.replace_library(roots, tracks))
}

#[tauri::command]
fn library_import_audio_files(
    files: Vec<ImportedAudioFile>,
    app: AppHandle,
) -> Result<String, String> {
    const MAX_FILES: usize = 100;
    const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 1024 * 1024 * 1024;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("Choose between 1 and 100 audio files at a time.".to_owned());
    }
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "The app’s music storage is unavailable.".to_owned())?
        .join("Music");
    std::fs::create_dir_all(&data_dir)
        .map_err(|_| "The app couldn’t create its music storage folder.".to_owned())?;

    let mut total_bytes = 0usize;
    for (index, file) in files.into_iter().enumerate() {
        let name = file
            .name
            .rsplit(|character| character == '/' || character == '\\')
            .next()
            .unwrap_or("audio-file")
            .chars()
            .map(|character| {
                if character.is_control()
                    || matches!(
                        character,
                        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                    )
                {
                    '_'
                } else {
                    character
                }
            })
            .collect::<String>();
        if !supported_audio(Path::new(&name)) {
            return Err(format!("“{name}” is not a supported audio file."));
        }
        if file.data_base64.len() > MAX_FILE_BYTES.saturating_mul(4) / 3 + 8 {
            return Err(format!("“{name}” is too large to import."));
        }
        let bytes = STANDARD
            .decode(file.data_base64)
            .map_err(|_| format!("“{name}” couldn’t be read."))?;
        if bytes.len() > MAX_FILE_BYTES || total_bytes.saturating_add(bytes.len()) > MAX_TOTAL_BYTES
        {
            return Err("The selected audio files exceed the import size limit.".to_owned());
        }
        total_bytes += bytes.len();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let destination = data_dir.join(format!("{stamp}-{index}-{name}"));
        std::fs::write(destination, bytes)
            .map_err(|_| format!("“{name}” couldn’t be saved to app storage."))?;
    }
    Ok(data_dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn library_import_and_play_audio_files(
    files: Vec<ImportedAudioFile>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    let existing_ids = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .tracks
        .iter()
        .map(|track| track.track.id)
        .collect::<HashSet<_>>();
    let directory = library_import_audio_files(files, app)?;
    let folder = PathBuf::from(directory)
        .canonicalize()
        .map_err(|_| "Imported music could not be located.".to_owned())?;
    let mut roots = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .roots
        .clone();
    if !roots.contains(&folder) {
        roots.push(folder.clone());
    }
    let roots_to_scan = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || scan_roots(&roots_to_scan))
        .await
        .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let selected_ids = tracks
        .iter()
        .filter(|track| {
            track.path.parent() == Some(folder.as_path()) && !existing_ids.contains(&track.track.id)
        })
        .map(|track| track.track.id)
        .collect::<Vec<_>>();
    if selected_ids.is_empty() {
        return Err("Imported audio could not be added to the library.".to_owned());
    }
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    let views = core.replace_library(roots, tracks);
    core.queue = selected_ids;
    core.priority_queue.clear();
    core.play_queue_index(0)?;
    Ok(views)
}

#[tauri::command]
fn youtube_music_directory(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    return Err("YouTube audio downloads are available in the desktop app.".to_owned());

    #[cfg(not(target_os = "android"))]
    {
        let directory = app
            .path()
            .audio_dir()
            .map_err(|_| "The Music folder couldn’t be located.".to_owned())?
            .join("YouTube");
        std::fs::create_dir_all(&directory)
            .map_err(|_| "MichoPlay couldn’t create Music/YouTube.".to_owned())?;
        let directory = directory
            .canonicalize()
            .map_err(|_| "The YouTube music folder couldn’t be located.".to_owned())?;
        Ok(directory.to_string_lossy().into_owned())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeSearchResult {
    id: String,
    title: String,
    url: String,
    thumbnail: Option<String>,
    duration_seconds: Option<f64>,
    is_playlist: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeDownloadItem {
    id: String,
    title: String,
    url: String,
    thumbnail: Option<String>,
    is_playlist: bool,
    status: String,
    percent: Option<f32>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: String,
}

struct YoutubeDownloadTask {
    item: YoutubeDownloadItem,
    process_id: Option<u32>,
}

#[derive(Default)]
struct YoutubeDownloadManager {
    tasks: Vec<YoutubeDownloadTask>,
    next_id: u64,
    running: bool,
}

#[derive(Default)]
struct YoutubeDownloadState(Mutex<YoutubeDownloadManager>);

impl YoutubeDownloadManager {
    fn snapshot(&self) -> Vec<YoutubeDownloadItem> {
        self.tasks.iter().map(|task| task.item.clone()).collect()
    }
}

#[cfg(not(target_os = "android"))]
fn emit_youtube_downloads(app: &AppHandle) {
    let items = app
        .state::<YoutubeDownloadState>()
        .0
        .lock()
        .map(|manager| manager.snapshot())
        .unwrap_or_default();
    let _ = app.emit("youtube-downloads-updated", items);
}

#[cfg(not(target_os = "android"))]
fn report_youtube_progress(app: &AppHandle, id: &str, line: &str) {
    let Some(progress) = line.strip_prefix("__MICHOPLAY_PROGRESS__") else {
        return;
    };
    let mut fields = progress.splitn(5, '|');
    let raw_percent = fields.next().unwrap_or_default();
    let downloaded_bytes = fields
        .next()
        .and_then(|value| value.trim().parse::<u64>().ok());
    let total_bytes = fields
        .next()
        .filter(|value| !value.trim().is_empty() && *value != "NA")
        .and_then(|value| value.trim().parse::<u64>().ok());
    let total_bytes_estimate = fields
        .next()
        .filter(|value| !value.trim().is_empty() && *value != "NA")
        .and_then(|value| value.trim().parse::<u64>().ok());
    let total_bytes = total_bytes.or(total_bytes_estimate);
    let title = fields.next().unwrap_or_default();
    let percent = raw_percent
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0));
    if let Ok(mut manager) = app.state::<YoutubeDownloadState>().0.lock() {
        if let Some(task) = manager.tasks.iter_mut().find(|task| task.item.id == id) {
            if !title.trim().is_empty() && !task.item.is_playlist {
                task.item.title = title.trim().to_owned();
            }
            task.item.percent = percent.or(task.item.percent);
            task.item.downloaded_bytes = downloaded_bytes.or(task.item.downloaded_bytes);
            task.item.total_bytes = total_bytes.or(task.item.total_bytes);
            task.item.message = if task.item.is_playlist && !title.trim().is_empty() {
                format!("Downloading: {}", title.trim())
            } else {
                "Downloading audio".to_owned()
            };
        }
    }
    emit_youtube_downloads(app);
}

#[cfg(not(target_os = "android"))]
fn bundled_desktop_tool(name: &str) -> Result<std::path::PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "MichoPlay couldn’t locate its bundled audio tools.".to_owned())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "MichoPlay couldn’t locate its bundled audio tools.".to_owned())?;
    let filename = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let path = directory.join(filename);
    if !path.is_file() {
        return Err(format!(
            "MichoPlay’s bundled {name} tool is missing. Reinstall the desktop app."
        ));
    }
    Ok(path)
}

#[tauri::command]
async fn youtube_search(query: String) -> Result<Vec<YoutubeSearchResult>, String> {
    #[cfg(target_os = "android")]
    return Err("YouTube search is available in the desktop app.".to_owned());

    #[cfg(not(target_os = "android"))]
    {
        let query = query.trim().to_owned();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Enter a search or YouTube link (up to 200 characters).".to_owned());
        }
        let is_url = query.starts_with("https://") || query.starts_with("http://");
        if is_url {
            validate_youtube_url(&query)?;
        }
        let is_playlist_url = is_url
            && url::Url::parse(&query)
                .ok()
                .is_some_and(|url| url.query_pairs().any(|(key, _)| key == "list"));
        let yt_dlp = bundled_desktop_tool("yt-dlp")?;
        tauri::async_runtime::spawn_blocking(move || {
            let search = if is_url {
                query
            } else {
                format!("ytsearch10:{query}")
            };
            let output = Command::new(yt_dlp)
                .arg("--ignore-config")
                .arg("--no-warnings")
                .arg("--flat-playlist")
                .arg("--dump-single-json")
                .arg("--playlist-end")
                .arg("10")
                .arg("--skip-download")
                .arg("--")
                .arg(&search)
                .output()
                .map_err(|_| "MichoPlay couldn’t start YouTube search.".to_owned())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n"));
            }
            let document: serde_json::Value =
                serde_json::from_slice(&output.stdout).map_err(|_| {
                    "YouTube search returned unreadable results. Try another search.".to_owned()
                })?;
            if is_playlist_url {
                let title = document
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("YouTube playlist")
                    .to_owned();
                let url = document
                    .get("webpage_url")
                    .and_then(serde_json::Value::as_str)
                    .filter(|url| validate_youtube_url(url).is_ok())
                    .unwrap_or(&search)
                    .to_owned();
                let thumbnail = document
                    .get("thumbnail")
                    .and_then(serde_json::Value::as_str)
                    .filter(|url| valid_youtube_thumbnail(url))
                    .map(ToOwned::to_owned);
                return Ok(vec![YoutubeSearchResult {
                    id: document
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("playlist")
                        .to_owned(),
                    title,
                    url,
                    thumbnail,
                    duration_seconds: None,
                    is_playlist: true,
                }]);
            }
            let entries: Vec<&serde_json::Value> = document
                .get("entries")
                .and_then(serde_json::Value::as_array)
                .map(|entries| entries.iter().collect())
                .unwrap_or_else(|| vec![&document]);
            let results = entries
                .into_iter()
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?.to_owned();
                    let title = entry.get("title")?.as_str()?.trim().to_owned();
                    if title.is_empty() {
                        return None;
                    }
                    let url = entry
                        .get("webpage_url")
                        .and_then(serde_json::Value::as_str)
                        .filter(|url| validate_youtube_url(url).is_ok())
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
                    let thumbnail = entry
                        .get("thumbnail")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| {
                            entry
                                .get("thumbnails")
                                .and_then(serde_json::Value::as_array)
                                .and_then(|items| items.last())
                                .and_then(|item| item.get("url"))
                                .and_then(serde_json::Value::as_str)
                        })
                        .filter(|url| valid_youtube_thumbnail(url))
                        .map(ToOwned::to_owned);
                    Some(YoutubeSearchResult {
                        id,
                        title,
                        url,
                        thumbnail,
                        duration_seconds: entry.get("duration").and_then(serde_json::Value::as_f64),
                        is_playlist: false,
                    })
                })
                .take(10)
                .collect::<Vec<_>>();
            Ok(results)
        })
        .await
        .map_err(|_| "YouTube search couldn’t be completed.".to_owned())?
    }
}

#[cfg(not(target_os = "android"))]
fn validate_youtube_url(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "Enter a valid YouTube URL.".to_owned())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if parsed.scheme() != "https"
        || !matches!(
            host.as_str(),
            "youtube.com"
                | "www.youtube.com"
                | "m.youtube.com"
                | "music.youtube.com"
                | "youtu.be"
                | "www.youtu.be"
        )
    {
        return Err("Enter a YouTube video or playlist URL.".to_owned());
    }
    Ok(parsed.to_string())
}

#[cfg(not(target_os = "android"))]
fn valid_youtube_thumbnail(raw: &str) -> bool {
    url::Url::parse(raw)
        .ok()
        .filter(|url| url.scheme() == "https")
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .is_some_and(|host| host == "ytimg.com" || host.ends_with(".ytimg.com"))
}

#[tauri::command]
fn youtube_downloads_state(state: State<'_, YoutubeDownloadState>) -> Vec<YoutubeDownloadItem> {
    state
        .0
        .lock()
        .map(|manager| manager.snapshot())
        .unwrap_or_default()
}

#[tauri::command]
fn youtube_download_enqueue(
    url: String,
    title: String,
    thumbnail: Option<String>,
    is_playlist: bool,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
) -> Result<YoutubeDownloadItem, String> {
    #[cfg(target_os = "android")]
    return Err("YouTube audio downloads are available in the desktop app.".to_owned());

    #[cfg(not(target_os = "android"))]
    {
        let url = validate_youtube_url(&url)?;
        let thumbnail = thumbnail.filter(|url| valid_youtube_thumbnail(url));
        let is_playlist = is_playlist
            && url::Url::parse(&url)
                .ok()
                .is_some_and(|url| url.query_pairs().any(|(key, _)| key == "list"));
        let item = {
            let mut manager = state
                .0
                .lock()
                .map_err(|_| "The download manager is unavailable.".to_owned())?;
            manager.next_id += 1;
            let item = YoutubeDownloadItem {
                id: format!("youtube-{}", manager.next_id),
                title: if title.trim().is_empty() {
                    "YouTube audio".to_owned()
                } else {
                    title.trim().to_owned()
                },
                url: url.clone(),
                thumbnail,
                is_playlist,
                status: "queued".to_owned(),
                percent: None,
                downloaded_bytes: None,
                total_bytes: None,
                message: "Waiting to download".to_owned(),
            };
            manager.tasks.push(YoutubeDownloadTask {
                item: item.clone(),
                process_id: None,
            });
            item
        };
        emit_youtube_downloads(&app);
        start_youtube_download_worker(app.clone());
        Ok(item)
    }
}

#[tauri::command]
fn youtube_download_pause(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return Err("YouTube audio downloads are available in the desktop app.".to_owned());
    #[cfg(not(target_os = "android"))]
    {
        let pid = {
            let mut manager = state
                .0
                .lock()
                .map_err(|_| "The download manager is unavailable.".to_owned())?;
            let task = manager
                .tasks
                .iter_mut()
                .find(|task| task.item.id == id)
                .ok_or_else(|| "That download no longer exists.".to_owned())?;
            if task.item.status != "queued" && task.item.status != "downloading" {
                return Ok(());
            }
            task.item.status = "paused".to_owned();
            task.item.message = "Paused".to_owned();
            task.process_id
        };
        if let Some(pid) = pid {
            stop_download_process(pid);
        }
        emit_youtube_downloads(&app);
        Ok(())
    }
}

#[tauri::command]
fn youtube_download_resume(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return Err("YouTube audio downloads are available in the desktop app.".to_owned());
    #[cfg(not(target_os = "android"))]
    {
        {
            let mut manager = state
                .0
                .lock()
                .map_err(|_| "The download manager is unavailable.".to_owned())?;
            let task = manager
                .tasks
                .iter_mut()
                .find(|task| task.item.id == id)
                .ok_or_else(|| "That download no longer exists.".to_owned())?;
            if task.item.status != "paused" && task.item.status != "failed" {
                return Ok(());
            }
            task.item.status = "queued".to_owned();
            task.item.message = "Waiting to resume".to_owned();
        }
        emit_youtube_downloads(&app);
        start_youtube_download_worker(app);
        Ok(())
    }
}

#[tauri::command]
fn youtube_download_cancel(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return Err("YouTube audio downloads are available in the desktop app.".to_owned());
    #[cfg(not(target_os = "android"))]
    {
        let pid = {
            let mut manager = state
                .0
                .lock()
                .map_err(|_| "The download manager is unavailable.".to_owned())?;
            let task = manager
                .tasks
                .iter_mut()
                .find(|task| task.item.id == id)
                .ok_or_else(|| "That download no longer exists.".to_owned())?;
            if task.item.status == "completed" || task.item.status == "cancelled" {
                return Ok(());
            }
            task.item.status = "cancelled".to_owned();
            task.item.message = "Cancelled".to_owned();
            task.process_id
        };
        if let Some(pid) = pid {
            stop_download_process(pid);
        }
        emit_youtube_downloads(&app);
        Ok(())
    }
}

#[tauri::command]
fn youtube_download_remove(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
) -> Result<(), String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "The download manager is unavailable.".to_owned())?;
    manager.tasks.retain(|task| {
        task.item.id != id || task.item.status == "downloading" || task.item.status == "queued"
    });
    drop(manager);
    #[cfg(not(target_os = "android"))]
    emit_youtube_downloads(&app);
    #[cfg(target_os = "android")]
    let _ = app;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn start_youtube_download_worker(app: AppHandle) {
    let start = app
        .state::<YoutubeDownloadState>()
        .0
        .lock()
        .map(|mut manager| {
            if manager.running {
                false
            } else {
                manager.running = true;
                true
            }
        })
        .unwrap_or(false);
    if start {
        tauri::async_runtime::spawn_blocking(move || youtube_download_worker(app));
    }
}

#[cfg(not(target_os = "android"))]
fn youtube_download_worker(app: AppHandle) {
    loop {
        let next = {
            let state = app.state::<YoutubeDownloadState>();
            let Ok(mut manager) = state.0.lock() else {
                return;
            };
            if let Some(task) = manager
                .tasks
                .iter_mut()
                .find(|task| task.item.status == "queued")
            {
                task.item.status = "downloading".to_owned();
                task.item.message = "Starting download".to_owned();
                Some((task.item.id.clone(), task.item.url.clone()))
            } else {
                manager.running = false;
                None
            }
        };
        let Some((id, url)) = next else {
            emit_youtube_downloads(&app);
            return;
        };
        emit_youtube_downloads(&app);
        let is_playlist = app
            .state::<YoutubeDownloadState>()
            .0
            .lock()
            .ok()
            .and_then(|manager| {
                manager
                    .tasks
                    .iter()
                    .find(|task| task.item.id == id)
                    .map(|task| task.item.is_playlist)
            })
            .unwrap_or(false);
        let result = run_youtube_download(&app, &id, &url, is_playlist);
        {
            let state = app.state::<YoutubeDownloadState>();
            if let Ok(mut manager) = state.0.lock() {
                if let Some(task) = manager.tasks.iter_mut().find(|task| task.item.id == id) {
                    task.process_id = None;
                    if task.item.status == "downloading" {
                        match result {
                            Ok(()) => {
                                task.item.status = "completed".to_owned();
                                task.item.percent = Some(100.0);
                                task.item.message = "Saved to Music/YouTube".to_owned();
                            }
                            Err(error) => {
                                task.item.status = "failed".to_owned();
                                task.item.message = error;
                            }
                        }
                    }
                }
            };
        }
        emit_youtube_downloads(&app);
    }
}

#[cfg(not(target_os = "android"))]
fn run_youtube_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    is_playlist: bool,
) -> Result<(), String> {
    let directory = app
        .path()
        .audio_dir()
        .map_err(|_| "The Music folder couldn’t be located.".to_owned())?
        .join("YouTube");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "MichoPlay couldn’t create Music/YouTube.".to_owned())?;
    let yt_dlp = bundled_desktop_tool("yt-dlp")?;
    let ffmpeg = bundled_desktop_tool("ffmpeg")?;
    let deno = bundled_desktop_tool("deno")?;
    let output_template = directory.join("%(title)s [%(id)s].%(ext)s");
    let mut child = Command::new(yt_dlp)
        .arg("--ignore-config")
        .arg("--no-warnings")
        .arg("--newline")
        .arg("--continue")
        .arg(if is_playlist {
            "--yes-playlist"
        } else {
            "--no-playlist"
        })
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg("m4a")
        .arg("--audio-quality")
        .arg("0")
        .arg("--ffmpeg-location")
        .arg(ffmpeg)
        .arg("--js-runtimes")
        .arg(format!("deno:{}", deno.to_string_lossy()))
        .arg("--embed-metadata")
        .arg("--embed-thumbnail")
        .arg("--convert-thumbnails")
        .arg("jpg")
        .arg("--progress-template")
        .arg("download:__MICHOPLAY_PROGRESS__%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(info.title)s")
        .arg("--output")
        .arg(output_template)
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "MichoPlay couldn’t start its bundled YouTube audio downloader.".to_owned())?;
    let pid = child.id();
    let continue_running = {
        let state = app.state::<YoutubeDownloadState>();
        state
            .0
            .lock()
            .ok()
            .and_then(|mut manager| {
                manager
                    .tasks
                    .iter_mut()
                    .find(|task| task.item.id == id)
                    .map(|task| {
                        task.process_id = Some(pid);
                        task.item.status == "downloading"
                    })
            })
            .unwrap_or(false)
    };
    if !continue_running {
        stop_download_process(pid);
    }
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Couldn’t read downloader output.".to_owned())?;
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail = stderr_tail.clone();
    let app_for_stderr = app.clone();
    let task_id = id.to_owned();
    let stderr_reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            if line.starts_with("__MICHOPLAY_PROGRESS__") {
                report_youtube_progress(&app_for_stderr, &task_id, &line);
            } else if let Ok(mut lines) = tail.lock() {
                lines.push(line);
                if lines.len() > 24 {
                    lines.remove(0);
                }
            }
        }
    });
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().flatten() {
            if line.starts_with("__MICHOPLAY_PROGRESS__") {
                report_youtube_progress(app, id, &line);
            }
        }
    }
    let status = child
        .wait()
        .map_err(|_| "yt-dlp stopped before the download finished.".to_owned())?;
    let _ = stderr_reader.join();
    if status.success() {
        return Ok(());
    }
    let current_status = app
        .state::<YoutubeDownloadState>()
        .0
        .lock()
        .ok()
        .and_then(|manager| {
            manager
                .tasks
                .iter()
                .find(|task| task.item.id == id)
                .map(|task| task.item.status.clone())
        })
        .unwrap_or_default();
    if current_status == "paused" || current_status == "cancelled" {
        return Ok(());
    }
    let details = stderr_tail
        .lock()
        .map(|lines| {
            lines
                .iter()
                .rev()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if details.trim().is_empty() {
        Err(format!(
            "yt-dlp couldn’t download that video (exit code {}).",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_owned())
        ))
    } else {
        Err(details)
    }
}

#[cfg(all(unix, not(target_os = "android")))]
fn stop_download_process(pid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

#[cfg(windows)]
fn stop_download_process(pid: u32) {
    let _ = Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .status();
}

#[tauri::command]
fn library_import_directory(app: AppHandle) -> Result<String, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "The app’s music storage is unavailable.".to_owned())?
        .join("Music");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "The app couldn’t create its music storage folder.".to_owned())?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
async fn library_remove_folder(
    folder: String,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    let path = PathBuf::from(folder);
    let target = path.canonicalize().unwrap_or(path);
    let mut roots = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .roots
        .clone();
    roots.retain(|root| root != &target);
    let roots_to_scan = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || scan_roots(&roots_to_scan))
        .await
        .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    Ok(core.replace_library(roots, tracks))
}

#[tauri::command]
async fn library_refresh(
    folders: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    if folders.len() > 256 {
        return Err("Too many library folders.".to_owned());
    }
    let mut roots = Vec::new();
    for folder in folders {
        let path = PathBuf::from(folder);
        let path = path.canonicalize().unwrap_or(path);
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    let roots_to_scan = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || scan_roots(&roots_to_scan))
        .await
        .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    Ok(core.replace_library(roots, tracks))
}

#[tauri::command]
fn player_play_track(track_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?
        .play_track(track_id)
}

#[tauri::command]
fn player_queue_add(track_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.queue_add(track_id)
}

#[tauri::command]
fn library_artwork(
    artwork_key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let art = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .tracks
        .iter()
        .find(|track| track.track.artwork_key.as_deref() == Some(&artwork_key))
        .and_then(|track| track.artwork.clone());
    Ok(art.map(|art| format!("data:{};base64,{}", art.mime, STANDARD.encode(&art.data))))
}

#[tauri::command]
fn player_play_collection(
    track_ids: Vec<u64>,
    start_id: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if track_ids.is_empty() || track_ids.len() > core.tracks.len() {
        return Err("Choose songs from your library.".to_owned());
    }
    let mut unique = HashSet::new();
    for id in &track_ids {
        core.find_track_index(*id)?;
        if !unique.insert(*id) {
            return Err("The collection contains duplicate songs.".to_owned());
        }
    }
    let start = track_ids
        .iter()
        .position(|id| *id == start_id)
        .ok_or_else(|| "Choose a song in this collection.".to_owned())?;
    core.queue = track_ids;
    core.priority_queue.clear();
    core.play_queue_index(start)
}

#[tauri::command]
fn player_queue_move(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.queue_move(from_index, to_index)
}

#[tauri::command]
fn player_queue_remove(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.queue_remove(index)
}

#[tauri::command]
fn player_set_autoplay(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?
        .autoplay = enabled;
    Ok(())
}

#[tauri::command]
fn player_set_sleep_timer(
    duration_minutes: Option<u32>,
    at_track_end: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if at_track_end && core.current_queue_index.is_none() {
        return Err("Start a song before setting the timer to end of track.".to_owned());
    }
    if let Some(minutes) = duration_minutes {
        if !(1..=180).contains(&minutes) {
            return Err("Choose a sleep timer between 1 and 180 minutes.".to_owned());
        }
        core.sleep_timer_deadline =
            SystemTime::now().checked_add(Duration::from_secs(minutes as u64 * 60));
        core.sleep_timer_at_track_end = false;
    } else {
        core.sleep_timer_deadline = None;
        core.sleep_timer_at_track_end = at_track_end;
    }
    Ok(())
}

#[tauri::command]
fn player_toggle(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if core.current_queue_index.is_none() {
        let first = core
            .queue
            .first()
            .copied()
            .ok_or_else(|| "Add a music folder first.".to_owned())?;
        return core.play_track(first);
    }
    core.discard_failed_output();
    if core.sink.is_none() {
        let index = core
            .current_queue_index
            .ok_or_else(|| "No song is loaded.".to_owned())?;
        return core.play_queue_index(index);
    }
    let sink = core.sink.as_ref().expect("sink checked above");
    if core.is_playing {
        sink.pause();
        core.is_playing = false;
    } else if sink.empty() {
        let index = core.current_queue_index.unwrap_or(0);
        core.play_queue_index(index)?;
    } else {
        sink.play();
        core.is_playing = true;
    }
    Ok(())
}

#[tauri::command]
fn player_next(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if core.queue.is_empty() {
        return Err("Add a music folder first.".to_owned());
    }
    if core.current_queue_index.is_none() {
        return core.play_queue_index(0);
    }
    let index = core.current_queue_index.unwrap_or(0);
    if let Some(next) = core.next_index(index) {
        core.play_queue_index(next)
    } else {
        core.is_playing = false;
        if let Some(sink) = &core.sink {
            sink.stop();
        }
        Ok(())
    }
}

#[tauri::command]
fn player_previous(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if core.queue.is_empty() {
        return Err("Add a music folder first.".to_owned());
    }
    if core.current_queue_index.is_none() {
        return core.play_queue_index(0);
    }
    if core
        .sink
        .as_ref()
        .is_some_and(|sink| sink.get_pos() > Duration::from_secs(3))
    {
        core.sink
            .as_ref()
            .expect("sink exists")
            .try_seek(Duration::ZERO)
            .map_err(|_| "This audio format can’t seek.".to_owned())?;
        return Ok(());
    }
    let index = core.current_queue_index.unwrap_or(0);
    if index == 0 && core.repeat_mode == "off" {
        core.sink
            .as_ref()
            .expect("sink exists")
            .try_seek(Duration::ZERO)
            .map_err(|_| "This audio format can’t seek.".to_owned())?;
        return Ok(());
    }
    let previous = if index == 0 {
        core.queue.len() - 1
    } else {
        index - 1
    };
    core.play_queue_index(previous)
}

#[tauri::command]
fn player_toggle_shuffle(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.shuffle = !core.shuffle;
    Ok(())
}

#[tauri::command]
fn player_toggle_repeat(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.repeat_mode = match core.repeat_mode.as_str() {
        "off" => "all".to_owned(),
        "all" => "one".to_owned(),
        _ => "off".to_owned(),
    };
    Ok(())
}

#[tauri::command]
fn player_seek(position_ms: u64, state: State<'_, AppState>) -> Result<(), String> {
    let core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    let sink = core
        .sink
        .as_ref()
        .ok_or_else(|| "No song is loaded.".to_owned())?;
    sink.try_seek(Duration::from_millis(position_ms))
        .map_err(|_| "This audio format can’t seek.".to_owned())
}

#[tauri::command]
fn player_set_volume(volume: f32, state: State<'_, AppState>) -> Result<(), String> {
    if !volume.is_finite() {
        return Err("Volume must be a number between 0 and 100.".to_owned());
    }
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &core.sink {
        sink.set_volume(core.volume);
    }
    Ok(())
}

#[tauri::command]
fn player_set_equalizer_bands(
    bands: Vec<f32>,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if bands.len() != 6 || bands.iter().any(|gain| !gain.is_finite()) {
        return Err("The equalizer needs six valid band values.".to_owned());
    }
    let core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    for (band, gain) in core.equalizer_bands.iter().zip(bands) {
        band.store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
    core.equalizer_enabled.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn player_state(state: State<'_, AppState>) -> Result<PlayerSnapshot, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?
        .snapshot())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.manage(DesktopMediaBridge(Mutex::new(None)));
    #[cfg(not(target_os = "linux"))]
    let builder = builder.manage(DesktopMediaBridge);
    let startup_audio_files = {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            std::env::args_os()
                .skip(1)
                .filter_map(|arg| {
                    let path = PathBuf::from(arg);
                    (path.is_file() && supported_audio(&path)).then(|| {
                        path.canonicalize()
                            .unwrap_or(path)
                            .to_string_lossy()
                            .into_owned()
                    })
                })
                .collect::<Vec<_>>()
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            Vec::new()
        }
    };
    let builder = builder.manage(PendingAudioOpens(Mutex::new(startup_audio_files)));
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        let paths = args
            .iter()
            .filter_map(|arg| {
                let path = PathBuf::from(arg);
                (path.is_file() && supported_audio(&path)).then(|| {
                    path.canonicalize()
                        .unwrap_or(path)
                        .to_string_lossy()
                        .into_owned()
                })
            })
            .collect::<Vec<_>>();
        if !paths.is_empty() {
            if let Ok(mut pending) = app.state::<PendingAudioOpens>().0.lock() {
                pending.extend(paths);
            }
            let _ = app.emit("open-audio-files-ready", ());
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .manage(AppState(Mutex::new(PlayerCore {
            volume: 0.75,
            repeat_mode: "off".to_owned(),
            autoplay: true,
            equalizer_enabled: Arc::new(AtomicBool::new(true)),
            ..PlayerCore::default()
        })))
        .manage(YoutubeDownloadState::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(MediaBridge(Mutex::new(None)))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("michoplay-media")
                .setup(|app, api| {
                    #[cfg(target_os = "android")]
                    {
                        let handle =
                            api.register_android_plugin("app.michoplay.desktop", "MediaPlugin")?;
                        *app.state::<MediaBridge>()
                            .0
                            .lock()
                            .map_err(|_| "Media controls are unavailable.")? = Some(handle);
                    }
                    #[cfg(not(target_os = "android"))]
                    let _ = (app, api);
                    Ok(())
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                if let Ok(mut controls) = MediaControls::new(PlatformConfig {
                    dbus_name: "michoplay",
                    display_name: "MichoPlay",
                    hwnd: None,
                }) {
                    let handle = app.handle().clone();
                    if controls
                        .attach(move |event| {
                            let action = match event {
                                souvlaki::MediaControlEvent::Play => "play",
                                souvlaki::MediaControlEvent::Pause => "pause",
                                souvlaki::MediaControlEvent::Toggle => "toggle",
                                souvlaki::MediaControlEvent::Next => "next",
                                souvlaki::MediaControlEvent::Previous => "previous",
                                _ => return,
                            };
                            let _ = handle.emit("system-media-control", action);
                        })
                        .is_ok()
                    {
                        if let Ok(mut bridge) = app.state::<DesktopMediaBridge>().0.lock() {
                            *bridge = Some(controls);
                        }
                    }
                }
            }
            #[cfg(target_os = "android")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking::<_, ()>(move || loop {
                    std::thread::sleep(Duration::from_millis(400));
                    let state = handle.state::<AppState>();
                    if let Ok(mut core) = state.0.lock() {
                        let _ = core.snapshot();
                    };
                });
            }
            #[cfg(not(any(target_os = "android", target_os = "linux")))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_import_audio_files,
            library_import_and_play_audio_files,
            library_import_directory,
            youtube_music_directory,
            youtube_search,
            youtube_downloads_state,
            youtube_download_enqueue,
            youtube_download_pause,
            youtube_download_resume,
            youtube_download_cancel,
            youtube_download_remove,
            library_scan_folder,
            library_refresh,
            library_remove_folder,
            library_artwork,
            take_pending_audio_opens,
            library_open_audio_files,
            system_set_default_player,
            media_take_opened_audio,
            player_play_collection,
            player_queue_move,
            player_queue_remove,
            player_play_track,
            player_queue_add,
            player_set_autoplay,
            player_set_sleep_timer,
            player_toggle,
            player_next,
            player_previous,
            player_toggle_shuffle,
            player_toggle_repeat,
            player_seek,
            player_set_volume,
            player_set_equalizer_bands,
            player_state,
            media_update,
            media_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running MichoPlay");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> PlayerCore {
        let tracks = (1..=4)
            .map(|id| LibraryTrack {
                track: Track {
                    id,
                    title: format!("Song {id}"),
                    artist: "Artist".into(),
                    album: "Album".into(),
                    release_date: String::new(),
                    duration_ms: 1000,
                    added_at: id,
                    folder_path: "/music".into(),
                    folder_name: "music".into(),
                    root_path: "/music".into(),
                    folders: vec![],
                    artwork_key: None,
                },
                path: PathBuf::from(format!("/music/{id}.wav")),
                artwork: None,
            })
            .collect();
        PlayerCore {
            tracks,
            queue: vec![1, 2, 3, 4],
            current_queue_index: Some(0),
            ..PlayerCore::default()
        }
    }

    #[test]
    fn explicit_queue_overrides_default_and_shuffle() {
        let mut core = library();
        core.shuffle = true;
        core.queue_add(4).unwrap();
        assert_eq!(core.queue, vec![1, 4, 2, 3]);
        assert_eq!(core.priority_queue, vec![4]);
        assert_eq!(core.next_index(0), Some(1));
        assert_eq!(core.snapshot().queue, vec![4, 2, 3]);
    }

    #[test]
    fn queue_add_with_no_current_song_goes_first() {
        let mut core = library();
        core.current_queue_index = None;
        core.queue_add(3).unwrap();
        assert_eq!(core.queue, vec![3, 1, 2, 4]);
        core.queue_add(3).unwrap();
        assert_eq!(core.queue, vec![3, 1, 2, 4]);
    }

    #[test]
    fn queue_moves_and_removes_preserve_current_song() {
        let mut core = library();
        core.current_queue_index = Some(1);
        core.queue_add(1).unwrap();
        assert_eq!(core.queue[core.current_queue_index.unwrap()], 2);
        assert_eq!(core.snapshot().queue, vec![1, 3, 4]);
        core.queue_move(2, 0).unwrap();
        assert_eq!(core.snapshot().queue, vec![4, 1, 3]);
        core.queue_remove(1).unwrap();
        assert_eq!(core.snapshot().queue, vec![4, 3]);
        assert_eq!(core.queue[core.current_queue_index.unwrap()], 2);
        assert!(core.queue_move(10, 0).is_err());
        assert!(core.queue_add(999).is_err());
    }

    #[test]
    fn refresh_preserves_explicit_queue_and_drops_missing_songs() {
        let mut core = library();
        core.queue_add(4).unwrap();
        let mut tracks = library().tracks;
        tracks.retain(|track| track.track.id != 3);
        core.replace_library(vec![], tracks);
        assert_eq!(core.queue, vec![1, 4, 2]);
        assert_eq!(core.priority_queue, vec![4]);
        assert_eq!(core.current_queue_index, Some(0));
    }

    #[test]
    fn scanner_discovers_nested_folders_sidecar_art_and_safe_stable_ids() {
        let root = std::env::temp_dir().join(format!(
            "michoplay-scan-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let leaf = root.join("Artist").join("Album");
        std::fs::create_dir_all(&leaf).unwrap();
        // A valid mono PCM WAV with one silent sample.
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend(38u32.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(44100u32.to_le_bytes());
        wav.extend(88200u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(2u32.to_le_bytes());
        wav.extend(0u16.to_le_bytes());
        std::fs::write(leaf.join("Silent.wav"), wav).unwrap();
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=").unwrap();
        std::fs::write(leaf.join("cover.png"), &png).unwrap();
        let first = scan_roots(&[root.clone(), root.join("unavailable")]).unwrap();
        let second = scan_roots(&[root.clone(), leaf.clone()]).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].track.title, "Silent");
        assert_eq!(first[0].track.folders.len(), 3);
        assert_eq!(first[0].track.folder_name, "Album");
        assert!(first[0].track.id < (1u64 << 53));
        assert_eq!(first[0].track.id, second[0].track.id);
        assert_eq!(first[0].artwork.as_ref().unwrap().data, png);
        assert!(first[0].track.artwork_key.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
