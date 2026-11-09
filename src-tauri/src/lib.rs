use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(not(target_os = "android"))]
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::{
    config::WriteOptions,
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::{ItemKey, Tag, TagExt, TagType},
};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rodio::{
    source::SeekError, ChannelCount, Decoder, OutputStream, OutputStreamBuilder, SampleRate, Sink,
    Source,
};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(target_os = "android")]
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use souvlaki::{MediaControls, MediaMetadata, MediaPlayback, PlatformConfig};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(not(target_os = "android"))]
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

mod app_data;
use app_data::{app_data_load, app_data_migrate, app_data_save};

const EQ_FREQUENCIES: [f32; 6] = [60.0, 150.0, 400.0, 1_000.0, 2_400.0, 15_000.0];
static LIBRARY_CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static LIBRARY_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);
static LIBRARY_WATCHERS: OnceLock<Mutex<HashMap<PathBuf, RecommendedWatcher>>> = OnceLock::new();
static LIBRARY_DIRTY_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
#[cfg(not(target_os = "android"))]
static YOUTUBE_DOWNLOAD_PERSIST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(not(target_os = "android"))]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(windows)]
    let command = {
        let mut command = Command::new(program);
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let command = Command::new(program);
    command
}

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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    id: u64,
    #[serde(default)]
    path: String,
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
    #[serde(default)]
    has_lyrics: bool,
}

#[derive(Clone, Deserialize, Serialize)]
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

#[derive(Clone)]
struct LibraryTrack {
    track: Track,
    path: PathBuf,
    artwork: Option<Arc<Artwork>>,
}

fn lyrics_path(audio_path: &Path) -> PathBuf {
    let mut path = audio_path.to_path_buf();
    path.set_extension("lrc");
    path
}

fn pending_lyrics_path(audio_path: &Path) -> PathBuf {
    let name = audio_path.file_name().unwrap_or_default().to_string_lossy();
    audio_path.with_file_name(format!("{name}.lyrics-pending"))
}

fn embedded_lyrics(audio_path: &Path) -> Option<String> {
    let tagged = Probe::open(audio_path).ok()?.read().ok()?;
    let tag = tagged.primary_tag()?;
    tag.get_string(ItemKey::Lyrics)
        .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

fn track_has_lyrics(audio_path: &Path) -> bool {
    lyrics_path(audio_path).is_file() || embedded_lyrics(audio_path).is_some()
}

fn embed_lyrics_file(audio_path: &Path, lyrics_file: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(lyrics_file)
        .map_err(|_| "Could not read downloaded lyrics.".to_owned())?;
    embed_lyrics_text(audio_path, &contents)
}

fn embed_lyrics_text(audio_path: &Path, contents: &str) -> Result<(), String> {
    if contents.trim().is_empty() {
        return Err("Downloaded lyrics were empty.".to_owned());
    }
    let mut tagged = Probe::open(audio_path)
        .map_err(|error| format!("Could not read downloaded audio tags: {error}"))?
        .read()
        .map_err(|error| format!("Could not read downloaded audio tags: {error}"))?;
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(TagType::Id3v2));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "Could not prepare audio lyrics metadata.".to_owned())?;
    // Keep the original LRC timestamp markup inside the audio's lyrics tag.
    // This works for ID3 MP3 downloads and preserves timing for MichoPlay's renderer.
    tag.insert_text(ItemKey::UnsyncLyrics, contents.to_owned());
    tag.save_to_path(audio_path, WriteOptions::default())
        .map_err(|error| format!("Could not embed downloaded lyrics: {error}"))
}

#[cfg(not(target_os = "android"))]
fn vtt_timestamp_ms(value: &str) -> Option<u64> {
    let (time, fraction) = value.trim().split_once('.')?;
    let parts = time
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let seconds = match parts.as_slice() {
        [minutes, seconds] => minutes.checked_mul(60)?.checked_add(*seconds)?,
        [hours, minutes, seconds] => hours
            .checked_mul(3600)?
            .checked_add(minutes.checked_mul(60)?)?
            .checked_add(*seconds)?,
        _ => return None,
    };
    let millis = fraction.chars().take(3).collect::<String>();
    let millis = millis.parse::<u64>().ok()? * 10_u64.pow(3 - millis.len() as u32);
    seconds.checked_mul(1000)?.checked_add(millis)
}

#[cfg(not(target_os = "android"))]
fn append_vtt_cue(lyrics: &mut Vec<String>, start_ms: Option<u64>, cue: &mut Vec<String>) {
    let Some(start_ms) = start_ms else {
        cue.clear();
        return;
    };
    let raw = cue.join(" ");
    cue.clear();
    let mut plain = String::new();
    let mut in_tag = false;
    for character in raw.chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(character),
            _ => {}
        }
    }
    let plain = plain
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let line = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty()
        || lyrics.last().is_some_and(|previous| {
            previous
                .split_once(']')
                .is_some_and(|(_, text)| text == line)
        })
    {
        return;
    }
    lyrics.push(format!(
        "[{:02}:{:02}.{:02}]{}",
        start_ms / 60_000,
        start_ms / 1000 % 60,
        start_ms % 1000 / 10,
        line
    ));
}

#[cfg(not(target_os = "android"))]
fn vtt_to_lrc(vtt: &str) -> String {
    let mut lyrics = Vec::new();
    let mut cue = Vec::new();
    let mut start_ms = None;
    for row in vtt.lines().chain(std::iter::once("")) {
        let row = row.trim();
        if let Some((start, _)) = row.split_once("-->") {
            append_vtt_cue(&mut lyrics, start_ms, &mut cue);
            start_ms = vtt_timestamp_ms(start);
        } else if row.is_empty() {
            append_vtt_cue(&mut lyrics, start_ms, &mut cue);
            start_ms = None;
        } else if start_ms.is_some() {
            cue.push(row.to_owned());
        }
    }
    if lyrics.is_empty() {
        String::new()
    } else {
        format!("{}\n", lyrics.join("\n"))
    }
}

#[cfg(not(target_os = "android"))]
fn attach_downloaded_lyrics(audio_path: &Path) {
    let Some(parent) = audio_path.parent() else {
        return;
    };
    let Some(stem) = audio_path.file_stem().and_then(|value| value.to_str()) else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let mut sources = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("lrc") || ext.eq_ignore_ascii_case("vtt")
            }) && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name == stem || name.starts_with(&format!("{stem}.")))
        })
        .collect::<Vec<_>>();
    sources.sort_by_key(|path| {
        !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lrc"))
    });
    for source in &sources {
        let result = if source
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lrc"))
        {
            embed_lyrics_file(audio_path, source)
        } else {
            fs::read_to_string(source)
                .map_err(|_| "Could not read downloaded captions.".to_owned())
                .and_then(|text| embed_lyrics_text(audio_path, &vtt_to_lrc(&text)))
        };
        if result.is_ok() {
            for sidecar in &sources {
                let _ = fs::remove_file(sidecar);
            }
            break;
        }
    }
}

#[cfg(not(target_os = "android"))]
fn has_downloaded_lyrics(audio_path: &Path) -> bool {
    let Some(parent) = audio_path.parent() else {
        return false;
    };
    let Some(stem) = audio_path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    fs::read_dir(parent)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            path.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("lrc") || ext.eq_ignore_ascii_case("vtt")
            }) && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name == stem || name.starts_with(&format!("{stem}.")))
        })
}

#[tauri::command]
fn embed_downloaded_lyrics(paths: Vec<String>) -> Vec<String> {
    let mut embedded = Vec::new();
    for value in paths {
        let audio_path = PathBuf::from(value);
        let staging_path = pending_lyrics_path(&audio_path);
        if staging_path.is_file() {
            if embed_lyrics_file(&audio_path, &staging_path).is_ok() {
                let _ = fs::remove_file(staging_path);
                embedded.push(audio_path.to_string_lossy().into_owned());
            }
        }
    }
    embedded
}

#[tauri::command]
fn lyrics_read(track_id: u64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    let track = core
        .tracks
        .iter()
        .find(|track| track.track.id == track_id)
        .ok_or_else(|| "That song is no longer in the library.".to_owned())?;
    let path = lyrics_path(&track.path);
    match fs::read_to_string(path) {
        Ok(contents) if !contents.trim().is_empty() => Ok(Some(contents)),
        Ok(_) => Ok(embedded_lyrics(&track.path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(embedded_lyrics(&track.path))
        }
        Err(_) => Err("Could not read this song’s lyrics.".to_owned()),
    }
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
    track_indices: HashMap<u64, usize>,
    artwork_by_key: HashMap<String, Arc<Artwork>>,
    storage_dir: PathBuf,
    scan_workers: Option<usize>,
    watch_library: bool,
    queue: Vec<u64>,
    current_queue_index: Option<usize>,
    output: Option<OutputStream>,
    sink: Option<Sink>,
    output_failed: Arc<AtomicBool>,
    is_playing: bool,
    resume_after_interruption: bool,
    #[cfg(any(target_os = "android", test))]
    audio_focus_generation: u64,
    #[cfg(target_os = "android")]
    android_media: Option<tauri::plugin::PluginHandle<tauri::Wry>>,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryConfig {
    version: u32,
    roots: Vec<String>,
    #[serde(default)]
    scan_workers: Option<usize>,
    #[serde(default = "default_watch_library")]
    watch_library: bool,
}

fn default_watch_library() -> bool {
    true
}

struct AppState(Mutex<PlayerCore>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct MediaBridge(Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>>);

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct PendingMediaActions {
    actions: Vec<String>,
}

#[cfg(target_os = "android")]
fn android_media_plugin(
    state: &State<'_, MediaBridge>,
) -> Result<tauri::plugin::PluginHandle<tauri::Wry>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Android media services are unavailable.".to_owned())?
        .clone()
        .ok_or_else(|| "Android media services are still starting. Try again shortly.".to_owned())
}

#[cfg(any(target_os = "android", test))]
fn apply_android_media_action(core: &mut PlayerCore, action: &str) -> Result<(), String> {
    let (action, generation) = match action.split_once(':') {
        Some((
            kind @ ("focus-loss"
            | "focus-loss-transient"
            | "focus-gain"
            | "becoming-noisy"
            | "service-stopped"),
            generation,
        )) => (
            kind,
            Some(
                generation
                    .parse::<u64>()
                    .map_err(|_| "Invalid audio focus generation.".to_owned())?,
            ),
        ),
        _ => (action, None),
    };
    // A queued interruption from an earlier focus request must not pause a new
    // song the user explicitly started while the event was in flight.
    if generation.is_some_and(|generation| generation != core.audio_focus_generation) {
        return Ok(());
    }
    match action {
        "play" => core.set_playing(true),
        "toggle" => core.set_playing(!core.is_playing),
        "pause" | "focus-loss" | "becoming-noisy" | "service-stopped" => core.set_playing(false),
        "focus-loss-transient" => {
            let resume = core.is_playing || core.resume_after_interruption;
            core.set_playing(false)?;
            core.resume_after_interruption = resume;
            Ok(())
        }
        "focus-gain" => {
            if core.resume_after_interruption {
                // Only resume a song interrupted by Android. A user's pause
                // clears this flag, even while focus is temporarily held away.
                core.resume_after_interruption = false;
                core.set_playing(true)?;
            }
            Ok(())
        }
        "next" => {
            if core.queue.is_empty() {
                return Err("Add a music folder first.".to_owned());
            }
            core.play_next_available()
        }
        "previous" => {
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
                return core
                    .sink
                    .as_ref()
                    .expect("sink checked above")
                    .try_seek(Duration::ZERO)
                    .map_err(|_| "This audio format can’t seek.".to_owned());
            }
            let index = core.current_queue_index.unwrap_or(0);
            if index == 0 && core.repeat_mode == "off" {
                return core
                    .sink
                    .as_ref()
                    .ok_or_else(|| "No song is loaded.".to_owned())?
                    .try_seek(Duration::ZERO)
                    .map_err(|_| "This audio format can’t seek.".to_owned());
            }
            core.play_queue_index(if index == 0 {
                core.queue.len() - 1
            } else {
                index - 1
            })
        }
        action if action.starts_with("seek:") => {
            let position = action[5..]
                .parse::<u64>()
                .map_err(|_| "Invalid playback position.".to_owned())?;
            core.sink
                .as_ref()
                .ok_or_else(|| "No song is loaded.".to_owned())?
                .try_seek(Duration::from_millis(position))
                .map_err(|_| "This audio format can’t seek.".to_owned())
        }
        action if action.starts_with("seek-by:") => {
            let delta = action[8..]
                .parse::<i64>()
                .map_err(|_| "Invalid seek distance.".to_owned())?;
            let sink = core
                .sink
                .as_ref()
                .ok_or_else(|| "No song is loaded.".to_owned())?;
            let duration = core
                .current_queue_index
                .and_then(|index| core.queue.get(index))
                .and_then(|id| core.tracks.iter().find(|track| track.track.id == *id))
                .map(|track| track.track.duration_ms)
                .unwrap_or(0);
            let position = sink.get_pos().as_millis() as i64;
            sink.try_seek(Duration::from_millis(
                (position + delta).clamp(0, duration as i64) as u64,
            ))
            .map_err(|_| "This audio format can’t seek.".to_owned())
        }
        _ => Ok(()),
    }
}

#[cfg(target_os = "android")]
async fn call_android_media<T: DeserializeOwned>(
    plugin: tauri::plugin::PluginHandle<tauri::Wry>,
    command: &'static str,
    payload: serde_json::Value,
) -> Result<T, String> {
    plugin
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct DesktopMediaBridge(Mutex<Option<MediaControls>>);
#[cfg(any(target_os = "android", target_os = "ios"))]
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
fn media_take_opened_audio(state: State<'_, MediaBridge>) -> Result<Vec<String>, String> {
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
fn media_take_pending_actions(state: State<'_, MediaBridge>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = state
            .0
            .lock()
            .map_err(|_| "Media controls are unavailable.".to_owned())?;
        if let Some(handle) = bridge.as_ref() {
            return handle
                .run_mobile_plugin::<PendingMediaActions>("takePendingActions", ())
                .map(|response| response.actions)
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
    play: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
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
    let (mut roots, storage_dir) = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        (core.roots.clone(), core.storage_dir.clone())
    };
    for path in &selected {
        if let Some(parent) = path.parent() {
            let root = parent.to_path_buf();
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    let roots_copy = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_for_app(&app, &roots_copy, &storage_dir)
    })
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
    if play.unwrap_or(true) {
        core.queue = selected_ids;
        core.priority_queue.clear();
        core.play_queue_index(0)?;
    }
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
            let status = hidden_command("xdg-mime")
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
    artwork_data_url: Option<String>,
    state: State<'_, MediaBridge>,
    desktop: State<'_, DesktopMediaBridge>,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let mut controls = desktop
            .0
            .lock()
            .map_err(|_| "System media controls are unavailable.".to_owned())?;
        if let Some(controls) = controls.as_mut() {
            if let Some(title) = title.as_deref() {
                let cover_url = artwork_data_url.as_deref().and_then(save_media_artwork);
                controls
                    .set_metadata(MediaMetadata {
                        title: Some(title),
                        artist: artist.as_deref(),
                        duration: Some(Duration::from_millis(duration_ms)),
                        cover_url: cover_url.as_deref(),
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = (
        title,
        artist,
        is_playing,
        duration_ms,
        position_ms,
        artwork_data_url,
        state,
    );
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = desktop;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn save_media_artwork(data_url: &str) -> Option<String> {
    let (header, encoded) = data_url.split_once(',')?;
    let bytes = STANDARD.decode(encoded).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let extension = if header.contains("image/png") {
        "png"
    } else if header.contains("image/webp") {
        "webp"
    } else {
        "jpg"
    };
    let path =
        std::env::temp_dir().join(format!("michoplay-art-{:x}.{extension}", hasher.finish()));
    std::fs::write(&path, bytes).ok()?;
    url::Url::from_file_path(path)
        .ok()
        .map(|url| url.to_string())
}

#[tauri::command]
fn media_stop(
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
                .run_mobile_plugin::<()>("stop", ())
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(mut controls) = desktop.0.lock() {
            if let Some(controls) = controls.as_mut() {
                controls
                    .set_playback(MediaPlayback::Stopped)
                    .map_err(|error| error.to_string())?;
            }
        }
        let _ = state;
    }
    #[cfg(target_os = "ios")]
    let _ = state;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = desktop;
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
    let mut artwork = read_track_art(path).or(sidecar);
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
                        if matches!(
                            mime.as_str(),
                            "image/jpeg" | "image/png" | "image/webp" | "image/avif"
                        ) {
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
            path: path.to_string_lossy().into_owned(),
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
            has_lyrics: track_has_lyrics(path),
        },
        path: path.to_owned(),
        artwork,
    }
}

fn read_track_art(path: &Path) -> Option<Arc<Artwork>> {
    let parent = path.parent()?;
    let stem = path.file_stem()?.to_str()?;
    for extension in ["jpg", "jpeg", "png", "webp", "avif"] {
        let artwork_path = parent.join(format!("{stem}.{extension}"));
        let Ok(metadata) = std::fs::metadata(&artwork_path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 {
            continue;
        }
        let Ok(data) = std::fs::read(artwork_path) else {
            continue;
        };
        let mime = match extension {
            "png" => "image/png",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "jpeg" | "jpg" => "image/jpeg",
            _ => continue,
        };
        return Some(Arc::new(Artwork {
            mime: mime.to_owned(),
            data,
        }));
    }
    None
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
                        "jpg" | "jpeg" | "png" | "webp" | "avif"
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
    let preferred = images.iter().position(|path| {
        path.file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|stem| {
                matches!(
                    stem.to_ascii_lowercase().as_str(),
                    "cover" | "folder" | "front" | "album" | "artwork"
                )
            })
    });
    let path = preferred
        .map(|index| images.remove(index))
        .or_else(|| (images.len() == 1).then(|| images.remove(0)))?;
    if std::fs::metadata(&path).ok()?.len() > 8 * 1024 * 1024 {
        return None;
    }
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    };
    let data = std::fs::read(path).ok()?;
    Some(Arc::new(Artwork {
        mime: mime.to_owned(),
        data,
    }))
}

#[cfg(not(target_os = "android"))]
fn thumbnail_for_audio(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let stem = path.file_stem()?.to_str()?;
    std::fs::read_dir(parent)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|candidate| {
            candidate.file_stem().and_then(|name| name.to_str()) == Some(stem)
                && candidate
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "jpg" | "jpeg" | "png" | "webp" | "avif"
                        )
                    })
                && candidate.is_file()
        })
}

#[cfg(not(target_os = "android"))]
fn embed_thumbnail_in_mp3(audio_path: &Path, thumbnail_path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(thumbnail_path)
        .map_err(|_| "The YouTube thumbnail could not be read.".to_owned())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 {
        return Err("The YouTube thumbnail is empty or too large to embed.".to_owned());
    }
    let extension = thumbnail_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return Err("The YouTube thumbnail format is not supported.".to_owned()),
    };
    let picture = Picture::unchecked(
        std::fs::read(thumbnail_path)
            .map_err(|_| "The YouTube thumbnail could not be read.".to_owned())?,
    )
    .pic_type(PictureType::CoverFront)
    .mime_type(MimeType::from_str(mime))
    .description("Cover art")
    .build();
    let mut tagged = Probe::open(audio_path)
        .map_err(|error| format!("Could not read downloaded MP3 tags: {error}"))?
        .read()
        .map_err(|error| format!("Could not read downloaded MP3 tags: {error}"))?;
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(TagType::Id3v2));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "Could not prepare MP3 artwork metadata.".to_owned())?;
    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(picture);
    tag.save_to_path(audio_path, WriteOptions::default())
        .map_err(|error| format!("Could not save MP3 artwork: {error}"))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedTrack {
    path: String,
    root_path: String,
    file_size: u64,
    modified_at: u64,
    track: Track,
    artwork_mime: Option<String>,
}

fn artwork_cache_path(storage_dir: &Path, key: &str, mime: &str) -> PathBuf {
    let extension = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    storage_dir
        .join("artwork")
        .join(format!("{key}.{extension}"))
}

fn copy_directory_missing(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_directory_missing(&source_path, &destination_path)?;
        } else if file_type.is_file() && !destination_path.exists() {
            let _ = fs::copy(source_path, destination_path);
        }
    }
    Ok(())
}

fn open_library_cache(storage_dir: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(storage_dir.join("library.sqlite"))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS tracks (
            path TEXT PRIMARY KEY NOT NULL,
            root_path TEXT NOT NULL,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            modified_at INTEGER NOT NULL,
            track_json TEXT NOT NULL,
            artwork_mime TEXT
        );
        CREATE INDEX IF NOT EXISTS tracks_by_root ON tracks(root_path);
        CREATE INDEX IF NOT EXISTS tracks_by_title ON tracks(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS tracks_by_artist ON tracks(artist COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS tracks_by_album ON tracks(album COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS tracks_by_folder ON tracks(folder_path);
        CREATE TABLE IF NOT EXISTS track_metadata_overrides (
            path TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT NOT NULL,
            release_date TEXT NOT NULL
        );",
    )?;
    Ok(connection)
}

fn load_metadata_overrides(storage_dir: &Path) -> HashMap<String, TrackMetadataEdit> {
    let Ok(connection) = open_library_cache(storage_dir) else {
        return HashMap::new();
    };
    let Ok(mut statement) = connection
        .prepare("SELECT path, title, artist, album, release_date FROM track_metadata_overrides")
    else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            TrackMetadataEdit {
                title: row.get(1)?,
                artist: row.get(2)?,
                album: row.get(3)?,
                release_date: row.get(4)?,
            },
        ))
    }) else {
        return HashMap::new();
    };
    rows.flatten().collect()
}

fn apply_metadata_edit(track: &mut Track, edit: &TrackMetadataEdit) {
    track.title = edit.title.clone();
    track.artist = edit.artist.clone();
    track.album = edit.album.clone();
    track.release_date = edit.release_date.clone();
}

fn load_library_cache(storage_dir: &Path) -> HashMap<String, CachedTrack> {
    let Ok(connection) = open_library_cache(storage_dir) else {
        return HashMap::new();
    };
    let row_count = connection
        .query_row("SELECT COUNT(*) FROM tracks", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or_default();
    if row_count == 0 {
        // Import the previous whole-file index once; keep it as a recovery copy.
        if let Ok(_cache_write) = LIBRARY_CACHE_WRITE_LOCK.lock() {
            let legacy_path = storage_dir.join("library-index.json");
            if let Ok(bytes) = fs::read(legacy_path) {
                if let Ok(entries) = serde_json::from_slice::<Vec<CachedTrack>>(&bytes) {
                    let roots = entries
                        .iter()
                        .map(|entry| PathBuf::from(&entry.root_path))
                        .collect::<HashSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>();
                    let _ = write_library_cache(storage_dir, &entries, &roots);
                }
            }
        }
    }
    let Ok(mut statement) = connection.prepare(
        "SELECT path, root_path, file_size, modified_at, track_json, artwork_mime FROM tracks",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    }) else {
        return HashMap::new();
    };
    rows.flatten()
        .filter_map(
            |(path, root_path, file_size, modified_at, track_json, artwork_mime)| {
                let mut track: Track = serde_json::from_str(&track_json).ok()?;
                if track.path.is_empty() {
                    track.path = path.clone();
                }
                Some((
                    path.clone(),
                    CachedTrack {
                        path,
                        root_path,
                        file_size: file_size.max(0) as u64,
                        modified_at: modified_at.max(0) as u64,
                        track,
                        artwork_mime,
                    },
                ))
            },
        )
        .collect()
}

fn write_library_cache(
    storage_dir: &Path,
    entries: &[CachedTrack],
    scanned_roots: &[PathBuf],
) -> rusqlite::Result<()> {
    let mut connection = open_library_cache(storage_dir)?;
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS scan_paths (path TEXT PRIMARY KEY NOT NULL);
        DELETE FROM scan_paths;",
    )?;
    {
        let mut scanned =
            transaction.prepare("INSERT OR IGNORE INTO scan_paths(path) VALUES (?1)")?;
        let mut existing = transaction
            .prepare("SELECT root_path, file_size, modified_at FROM tracks WHERE path = ?1")?;
        let mut upsert = transaction.prepare(
            "INSERT INTO tracks(path, root_path, title, artist, album, folder_path, file_size, modified_at, track_json, artwork_mime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(path) DO UPDATE SET
                 root_path = excluded.root_path,
                 title = excluded.title,
                 artist = excluded.artist,
                 album = excluded.album,
                 folder_path = excluded.folder_path,
                 file_size = excluded.file_size,
                 modified_at = excluded.modified_at,
                 track_json = excluded.track_json,
                 artwork_mime = excluded.artwork_mime
             WHERE tracks.root_path != excluded.root_path
                OR tracks.title != excluded.title
                OR tracks.artist != excluded.artist
                OR tracks.album != excluded.album
                OR tracks.folder_path != excluded.folder_path
                OR tracks.file_size != excluded.file_size
                OR tracks.modified_at != excluded.modified_at
                OR tracks.track_json != excluded.track_json
                OR tracks.artwork_mime IS NOT excluded.artwork_mime",
        )?;
        for entry in entries {
            scanned.execute([&entry.path])?;
            let cached_metadata = existing
                .query_row([&entry.path], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .optional()?;
            if cached_metadata.is_some_and(|(root, size, modified)| {
                root == entry.root_path
                    && size == entry.file_size.min(i64::MAX as u64) as i64
                    && modified == entry.modified_at.min(i64::MAX as u64) as i64
            }) {
                continue;
            }
            let track_json = serde_json::to_string(&entry.track)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            upsert.execute(params![
                entry.path,
                entry.root_path,
                entry.track.title,
                entry.track.artist,
                entry.track.album,
                entry.track.folder_path,
                entry.file_size.min(i64::MAX as u64) as i64,
                entry.modified_at.min(i64::MAX as u64) as i64,
                track_json,
                entry.artwork_mime,
            ])?;
        }
    }
    // Only reconcile roots that were successfully scanned. A disconnected drive
    // or an unreadable folder must not evict its cached tracks.
    {
        let mut delete_missing = transaction.prepare(
            "DELETE FROM tracks
             WHERE root_path = ?1
               AND NOT EXISTS (SELECT 1 FROM scan_paths WHERE scan_paths.path = tracks.path)",
        )?;
        for root in scanned_roots {
            delete_missing.execute([root.to_string_lossy().as_ref()])?;
        }
    }
    transaction.commit()
}

fn scan_roots_for_app(
    app: &AppHandle,
    roots: &[PathBuf],
    storage_dir: &Path,
) -> Result<Vec<LibraryTrack>, String> {
    LIBRARY_SCAN_CANCELLED.store(false, Ordering::Relaxed);
    let emit_progress = |phase: &str, processed: usize, total: usize| {
        let _ = app.emit(
            "library-scan-progress",
            serde_json::json!({ "phase": phase, "processed": processed, "total": total }),
        );
    };
    emit_progress("Finding audio files", 0, 0);
    let canonical_roots = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .filter(|root| root.is_dir())
        .collect::<Vec<_>>();
    let watch_enabled = fs::read(storage_dir.join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LibraryConfig>(&bytes).ok())
        .map(|config| config.watch_library)
        .unwrap_or(true);
    let watcher_was_ready = watch_enabled && ensure_library_watchers(&canonical_roots, storage_dir);
    if watcher_was_ready && !has_dirty_roots(&canonical_roots) {
        if let Some(cached_tracks) = cached_tracks_for_roots(storage_dir, &canonical_roots) {
            if !has_dirty_roots(&canonical_roots) {
                emit_progress(
                    "Library is up to date",
                    cached_tracks.len(),
                    cached_tracks.len(),
                );
                let _ = app.emit(
                    "library-scan-progress",
                    serde_json::json!({ "phase": "Complete", "processed": cached_tracks.len(), "total": cached_tracks.len() }),
                );
                return Ok(cached_tracks);
            }
        }
    }
    clear_dirty_roots(&canonical_roots);
    let result = scan_roots_with_progress(roots, storage_dir, emit_progress);
    let phase = if LIBRARY_SCAN_CANCELLED.load(Ordering::Relaxed) {
        "Cancelled"
    } else if result.is_ok() {
        "Complete"
    } else {
        "Failed"
    };
    let _ = app.emit(
        "library-scan-progress",
        serde_json::json!({ "phase": phase, "processed": 0, "total": 0 }),
    );
    result
}

fn ensure_library_watchers(roots: &[PathBuf], storage_dir: &Path) -> bool {
    let watchers = LIBRARY_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut watchers) = watchers.lock() else {
        return false;
    };
    watchers.retain(|root, _| roots.contains(root));
    let ready_before_scan =
        !roots.is_empty() && roots.iter().all(|root| watchers.contains_key(root));
    for root in roots {
        if watchers.contains_key(root) {
            continue;
        }
        let dirty_root = root.clone();
        let ignored_storage = storage_dir.to_path_buf();
        let Ok(mut watcher) =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else {
                    return;
                };
                if matches!(event.kind, EventKind::Access(_))
                    || !event
                        .paths
                        .iter()
                        .any(|path| !path.starts_with(&ignored_storage))
                {
                    return;
                }
                if let Ok(mut dirty_roots) = LIBRARY_DIRTY_ROOTS
                    .get_or_init(|| Mutex::new(HashSet::new()))
                    .lock()
                {
                    dirty_roots.insert(dirty_root.clone());
                }
            })
        else {
            continue;
        };
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
            watchers.insert(root.clone(), watcher);
        }
    }
    ready_before_scan && roots.iter().all(|root| watchers.contains_key(root))
}

fn has_dirty_roots(roots: &[PathBuf]) -> bool {
    LIBRARY_DIRTY_ROOTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|dirty| roots.iter().any(|root| dirty.contains(root)))
        .unwrap_or(true)
}

fn clear_dirty_roots(roots: &[PathBuf]) {
    if let Ok(mut dirty) = LIBRARY_DIRTY_ROOTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        for root in roots {
            dirty.remove(root);
        }
    }
}

fn cached_tracks_for_roots(storage_dir: &Path, roots: &[PathBuf]) -> Option<Vec<LibraryTrack>> {
    let cached = load_library_cache(storage_dir);
    if cached.is_empty() {
        return None;
    }
    let expected_roots = roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect::<HashSet<_>>();
    let cached_roots = cached
        .values()
        .map(|entry| entry.root_path.clone())
        .collect::<HashSet<_>>();
    if expected_roots != cached_roots {
        return None;
    }
    let mut entries = cached.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut artworks = HashMap::<String, Arc<Artwork>>::new();
    entries
        .into_iter()
        .map(|entry| {
            let artwork = match (&entry.track.artwork_key, &entry.artwork_mime) {
                (Some(key), Some(mime)) => {
                    if let Some(artwork) = artworks.get(key) {
                        Some(artwork.clone())
                    } else {
                        let data = fs::read(artwork_cache_path(storage_dir, key, mime)).ok()?;
                        let artwork = Arc::new(Artwork {
                            mime: mime.clone(),
                            data,
                        });
                        artworks.insert(key.clone(), artwork.clone());
                        Some(artwork)
                    }
                }
                (None, _) => None,
                _ => return None,
            };
            Some(LibraryTrack {
                track: entry.track,
                path: PathBuf::from(entry.path),
                artwork,
            })
        })
        .collect()
}

#[tauri::command]
fn library_cancel_scan() {
    LIBRARY_SCAN_CANCELLED.store(true, Ordering::Relaxed);
}

#[cfg(test)]
fn scan_roots(roots: &[PathBuf], storage_dir: &Path) -> Result<Vec<LibraryTrack>, String> {
    scan_roots_with_progress(roots, storage_dir, |_, _, _| {})
}

fn scan_roots_with_progress<F>(
    roots: &[PathBuf],
    storage_dir: &Path,
    mut progress: F,
) -> Result<Vec<LibraryTrack>, String>
where
    F: FnMut(&str, usize, usize),
{
    let cache_available = fs::create_dir_all(storage_dir.join("artwork")).is_ok();
    let cached = cache_available
        .then(|| load_library_cache(storage_dir))
        .unwrap_or_default();

    let canonical_roots = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .filter(|root| root.is_dir())
        .collect::<Vec<_>>();
    let mut paths = Vec::new();
    let mut visited = 0usize;
    for root in &canonical_roots {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !is_protected_android_storage_dir(entry.path()))
        {
            if LIBRARY_SCAN_CANCELLED.load(Ordering::Relaxed) {
                return Err("Library scan cancelled.".to_owned());
            }
            let entry = entry.map_err(|_| {
                format!(
                    "MichoPlay couldn’t finish scanning “{}”. The previous index was kept.",
                    root.display()
                )
            })?;
            visited += 1;
            if entry.file_type().is_file() && supported_audio(entry.path()) {
                if let Ok(path) = entry.path().canonicalize() {
                    paths.push(path);
                }
            }
            if visited % 128 == 0 {
                progress("Finding audio files", paths.len(), 0);
            }
        }
    }
    paths.sort();
    paths.dedup();
    progress("Checking file metadata", 0, paths.len());

    let mut folder_art = HashMap::new();
    let mut cached_artwork = HashMap::<String, Arc<Artwork>>::new();
    let mut file_metadata = HashMap::<PathBuf, (u64, u64)>::with_capacity(paths.len());
    let mut result = (0..paths.len())
        .map(|_| None)
        .collect::<Vec<Option<LibraryTrack>>>();
    let mut jobs = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if LIBRARY_SCAN_CANCELLED.load(Ordering::Relaxed) {
            return Err("Library scan cancelled.".to_owned());
        }
        if index % 128 == 0 {
            progress("Checking file metadata", index, paths.len());
        }
        let Some(root) = canonical_roots
            .iter()
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.components().count())
        else {
            continue;
        };
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        let file_size = metadata.len();
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or_default();
        file_metadata.insert(path.clone(), (file_size, modified_at));
        let path_key = path.to_string_lossy().into_owned();

        if let Some(entry) = cached.get(&path_key).filter(|entry| {
            entry.file_size == file_size
                && entry.modified_at == modified_at
                && entry.root_path == root.to_string_lossy()
        }) {
            let artwork = match (&entry.track.artwork_key, &entry.artwork_mime) {
                (Some(key), Some(mime)) => cached_artwork.get(key).cloned().or_else(|| {
                    let data = fs::read(artwork_cache_path(storage_dir, key, mime)).ok()?;
                    let artwork = Arc::new(Artwork {
                        mime: mime.clone(),
                        data,
                    });
                    cached_artwork.insert(key.clone(), artwork.clone());
                    Some(artwork)
                }),
                _ => None,
            };
            if entry.track.artwork_key.is_none() || artwork.is_some() {
                result[index] = Some(LibraryTrack {
                    track: entry.track.clone(),
                    path: path.clone(),
                    artwork,
                });
                continue;
            }
        }

        let parent = path.parent().unwrap_or(root).to_owned();
        let sidecar = folder_art
            .entry(parent.clone())
            .or_insert_with(|| read_folder_art(&parent))
            .clone();
        jobs.push((index, path.clone(), root.clone(), sidecar));
    }

    // Keep metadata work off the UI thread and bound CPU and disk contention.
    let automatic_workers = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .clamp(1, 4);
    let configured_workers = fs::read(storage_dir.join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LibraryConfig>(&bytes).ok())
        .and_then(|config| config.scan_workers)
        .filter(|workers| (1..=8).contains(workers))
        .unwrap_or(automatic_workers);
    let worker_count = configured_workers.min(jobs.len().max(1));
    progress("Reading audio tags", 0, jobs.len());
    let chunk_size = jobs.len().div_ceil(worker_count);
    thread::scope(|scope| {
        let mut workers = Vec::new();
        for chunk in jobs.chunks(chunk_size.max(1)) {
            workers.push(scope.spawn(move || {
                chunk
                    .iter()
                    .map(|(index, path, root, art)| {
                        let mut hasher = std::collections::hash_map::DefaultHasher::new();
                        path.hash(&mut hasher);
                        // IPC numbers must survive JavaScript's 53-bit integer representation exactly.
                        let id = hasher.finish() & ((1u64 << 53) - 1);
                        (*index, read_track(path, id, root, art.clone()))
                    })
                    .collect::<Vec<_>>()
            }));
        }
        let mut completed = 0usize;
        for worker in workers {
            if let Ok(items) = worker.join() {
                completed += items.len();
                for (index, track) in items {
                    result[index] = Some(track);
                }
                progress("Reading audio tags", completed, jobs.len());
            }
        }
    });

    if LIBRARY_SCAN_CANCELLED.load(Ordering::Relaxed) {
        return Err("Library scan cancelled.".to_owned());
    }
    progress("Finishing library index", jobs.len(), jobs.len());

    let mut result = result.into_iter().flatten().collect::<Vec<_>>();
    let metadata_overrides = load_metadata_overrides(storage_dir);
    for item in &mut result {
        if let Some(edit) = metadata_overrides.get(&item.track.path) {
            apply_metadata_edit(&mut item.track, edit);
        }
    }
    let mut shared_artwork = HashMap::<String, Arc<Artwork>>::new();
    for item in &mut result {
        if let (Some(key), Some(artwork)) = (&item.track.artwork_key, &item.artwork) {
            let shared = shared_artwork
                .entry(key.clone())
                .or_insert_with(|| artwork.clone())
                .clone();
            item.artwork = Some(shared);
        }
    }
    let mut index_entries = Vec::with_capacity(result.len());
    let mut live_artwork = HashSet::new();
    for item in &result {
        let (file_size, modified_at) = file_metadata.get(&item.path).copied().unwrap_or_default();
        let artwork_mime = item.artwork.as_ref().map(|art| art.mime.clone());
        if let (Some(key), Some(art)) = (&item.track.artwork_key, &item.artwork) {
            live_artwork.insert(key.clone());
            if cache_available {
                let art_path = artwork_cache_path(storage_dir, key, &art.mime);
                if !art_path.exists() {
                    let _ = fs::write(&art_path, &art.data);
                }
            }
        }
        index_entries.push(CachedTrack {
            path: item.path.to_string_lossy().into_owned(),
            root_path: item.track.root_path.clone(),
            file_size,
            modified_at,
            track: item.track.clone(),
            artwork_mime,
        });
    }
    if cache_available {
        let Ok(_cache_write) = LIBRARY_CACHE_WRITE_LOCK.lock() else {
            return Ok(result);
        };
        let _ = write_library_cache(storage_dir, &index_entries, &canonical_roots);
        prune_artwork_cache(&storage_dir.join("artwork"), &live_artwork);
    }
    Ok(result)
}

fn is_protected_android_storage_dir(path: &Path) -> bool {
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components.windows(2).any(|pair| {
        pair[0].eq_ignore_ascii_case("Android")
            && (pair[1].eq_ignore_ascii_case("data") || pair[1].eq_ignore_ascii_case("obb"))
    })
}

fn prune_artwork_cache(directory: &Path, live_keys: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_stem()?.to_str()?.to_owned();
            let metadata = path.metadata().ok()?;
            Some((path, name, metadata.len(), metadata.modified().ok()))
        })
        .collect::<Vec<_>>();
    for (path, key, _, _) in &files {
        if !live_keys.contains(key) {
            let _ = fs::remove_file(path);
        }
    }
    files.retain(|(_, key, _, _)| live_keys.contains(key));
    let mut total = files.iter().map(|(_, _, size, _)| *size).sum::<u64>();
    if total <= 256 * 1024 * 1024 {
        return;
    }
    files.sort_by_key(|(_, _, _, modified)| *modified);
    for (path, _, size, _) in files {
        if total <= 256 * 1024 * 1024 {
            break;
        }
        let _ = fs::remove_file(path);
        total = total.saturating_sub(size);
    }
}

impl PlayerCore {
    #[cfg(target_os = "android")]
    fn android_media_revision(&self) -> (Option<u64>, bool, bool, u64) {
        (
            self.current_queue_index
                .and_then(|index| self.queue.get(index))
                .copied(),
            self.is_playing,
            self.resume_after_interruption,
            self.audio_focus_generation,
        )
    }

    // On Android, commands that lock PlayerCore run on Tauri's worker pool:
    // the main thread must remain available to grant focus while this lock is held.
    fn ensure_playback_focus(&mut self) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            #[derive(Deserialize)]
            struct FocusResponse {
                granted: bool,
                generation: u64,
            }
            let plugin = self.android_media.as_ref().ok_or_else(|| {
                "Android media services are still starting. Try again shortly.".to_owned()
            })?;
            let response = match plugin.run_mobile_plugin::<FocusResponse>("requestAudioFocus", ())
            {
                Ok(response) => response,
                Err(error) => {
                    self.set_playing(false)?;
                    return Err(format!("Android could not start playback: {error}"));
                }
            };
            self.audio_focus_generation = response.generation;
            if !response.granted {
                self.set_playing(false)?;
                return Err(
                    "Another app is using audio. Try playing again when it finishes.".to_owned(),
                );
            }
        }
        Ok(())
    }

    fn set_playing(&mut self, playing: bool) -> Result<(), String> {
        self.discard_failed_output();
        self.resume_after_interruption = false;
        if !playing {
            if let Some(sink) = &self.sink {
                sink.pause();
            }
            self.is_playing = false;
            return Ok(());
        }
        let Some(index) = self.current_queue_index else {
            let first = self
                .queue
                .first()
                .copied()
                .ok_or_else(|| "Add a music folder first.".to_owned())?;
            return self.play_track(first);
        };
        if self.sink.as_ref().map_or(true, Sink::empty) {
            return self.play_queue_index(index);
        }
        self.ensure_playback_focus()?;
        if let Some(sink) = &self.sink {
            sink.play();
        }
        self.is_playing = true;
        Ok(())
    }

    fn discard_failed_output(&mut self) {
        if self.output_failed.swap(false, Ordering::AcqRel) {
            self.is_playing = false;
            self.resume_after_interruption = false;
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
        self.track_indices = self
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.track.id, index))
            .collect();
        self.artwork_by_key.clear();
        for track in &self.tracks {
            if let (Some(key), Some(artwork)) = (&track.track.artwork_key, &track.artwork) {
                self.artwork_by_key
                    .entry(key.clone())
                    .or_insert_with(|| artwork.clone());
            }
        }
        let valid = self
            .tracks
            .iter()
            .map(|track| track.track.id)
            .collect::<HashSet<_>>();
        self.queue.retain(|id| valid.contains(id));
        self.priority_queue.retain(|id| valid.contains(id));
        self.current_queue_index =
            current_id.and_then(|id| self.queue.iter().position(|queued| *queued == id));
        if !self.storage_dir.as_os_str().is_empty() {
            let config = LibraryConfig {
                version: 1,
                roots: self
                    .roots
                    .iter()
                    .map(|root| root.to_string_lossy().into_owned())
                    .collect(),
                scan_workers: self.scan_workers,
                watch_library: self.watch_library,
            };
            if let (Ok(bytes), Ok(())) = (
                serde_json::to_vec(&config),
                fs::create_dir_all(&self.storage_dir),
            ) {
                let temporary = self.storage_dir.join("config.json.tmp");
                let destination = self.storage_dir.join("config.json");
                if fs::write(&temporary, bytes).is_ok() {
                    let _ = fs::rename(&temporary, &destination).or_else(|_| {
                        let _ = fs::remove_file(&destination);
                        fs::rename(&temporary, &destination)
                    });
                }
            }
        }
        if self.current_queue_index.is_none() {
            self.resume_after_interruption = false;
            self.is_playing = false;
            if let Some(sink) = &self.sink {
                sink.stop();
            }
        }
        views
    }

    fn shuffle_upcoming(&mut self) {
        let start = self
            .current_queue_index
            .map(|index| index + 1)
            .unwrap_or(0)
            .min(self.queue.len());
        if self.queue.len().saturating_sub(start) < 2 {
            self.priority_queue.clear();
            return;
        }

        let original = self.queue[start..].to_vec();
        let mut state = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        if state == 0 {
            state = 0x9e37_79b9_7f4a_7c15;
        }
        for index in (start + 1..self.queue.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let swap_index = start + (state as usize % (index - start + 1));
            self.queue.swap(index, swap_index);
        }
        if self.queue[start..] == original[..] {
            self.queue[start..].rotate_left(1);
        }
        self.priority_queue.clear();
    }

    fn next_index(&self, current: usize) -> Option<usize> {
        if let Some(id) = self.priority_queue.first() {
            if let Some(index) = self.queue.iter().position(|queued| queued == id) {
                return Some(index);
            }
        }
        if current + 1 < self.queue.len() {
            Some(current + 1)
        } else if self.repeat_mode == "all" {
            Some(0)
        } else {
            None
        }
    }

    fn remove_unplayable_queue_item(&mut self, index: usize) {
        if let Some(id) = self.queue.get(index).copied() {
            self.queue.remove(index);
            self.priority_queue.retain(|queued| *queued != id);
            if let Some(current) = self.current_queue_index {
                if index < current {
                    self.current_queue_index = Some(current - 1);
                } else if index == current {
                    self.current_queue_index = None;
                }
            }
        }
    }

    fn play_next_available(&mut self) -> Result<(), String> {
        let mut remaining_attempts = self.queue.len();
        while remaining_attempts > 0 {
            remaining_attempts -= 1;
            let next = match self.current_queue_index {
                Some(current) => self.next_index(current),
                None if !self.queue.is_empty() => Some(0),
                None => None,
            };
            let Some(next) = next else {
                self.is_playing = false;
                if let Some(sink) = &self.sink {
                    sink.stop();
                }
                return Ok(());
            };
            match self.play_queue_index(next) {
                Ok(()) => return Ok(()),
                Err(error)
                    if error == "This music file can’t be opened."
                        || error == "This audio format could not be decoded." =>
                {
                    self.remove_unplayable_queue_item(next);
                }
                Err(error) => return Err(error),
            }
        }
        self.is_playing = false;
        if let Some(sink) = &self.sink {
            sink.stop();
        }
        Ok(())
    }

    fn find_track_index(&self, id: u64) -> Result<usize, String> {
        self.track_indices.get(&id).copied().ok_or_else(|| {
            "That song is no longer in the library. Refresh the folder and try again.".to_owned()
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

        self.ensure_playback_focus()?;
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
        self.resume_after_interruption = false;
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
            match self.play_queue_index(self.queue.len() - 1) {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.queue.pop();
                    Err(error)
                }
            }
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
            self.resume_after_interruption = false;
            self.sleep_timer_deadline = None;
            self.sleep_timer_at_track_end = false;
        } else if track_ended {
            let current = self.current_queue_index.unwrap_or(0);
            if self.repeat_mode == "one" && self.priority_queue.is_empty() {
                if self.play_queue_index(current).is_err() {
                    self.is_playing = false;
                }
            } else {
                if self.autoplay || !self.priority_queue.is_empty() {
                    if self.next_index(current).is_some() {
                        if self.play_next_available().is_err() {
                            self.is_playing = false;
                        }
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
    app: AppHandle,
) -> Result<Vec<Track>, String> {
    let path = PathBuf::from(folder);
    let canonical = path
        .canonicalize()
        .map_err(|_| "The selected music folder can’t be accessed.".to_owned())?;
    if !canonical.is_dir() {
        return Err("The selected path is not a folder.".to_owned());
    }

    let (mut roots, storage_dir) = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        (core.roots.clone(), core.storage_dir.clone())
    };
    if !roots.contains(&canonical) {
        roots.push(canonical.clone());
    }
    let scan_roots_copy = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_for_app(&app, &scan_roots_copy, &storage_dir)
    })
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
    let mut prepared = Vec::with_capacity(files.len());
    for file in files {
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
        prepared.push((name, bytes));
    }

    // Validate the complete batch before touching the music directory, then
    // stage all files and roll back if any write or rename fails.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging_dir = data_dir.join(format!(".import-{stamp}"));
    std::fs::create_dir(&staging_dir)
        .map_err(|_| "The selected audio files couldn’t be staged.".to_owned())?;
    let result = (|| {
        let mut staged = Vec::with_capacity(prepared.len());
        for (index, (name, bytes)) in prepared.into_iter().enumerate() {
            let staged_path = staging_dir.join(format!("{index}.audio"));
            std::fs::write(&staged_path, bytes)
                .map_err(|_| format!("“{name}” couldn’t be saved to app storage."))?;
            staged.push((
                staged_path,
                data_dir.join(format!("{stamp}-{index}-{name}")),
                name,
            ));
        }
        let mut committed = Vec::with_capacity(staged.len());
        for (staged_path, destination, name) in staged {
            if let Err(_) = std::fs::rename(&staged_path, &destination) {
                for path in committed {
                    let _ = std::fs::remove_file(path);
                }
                return Err(format!("“{name}” couldn’t be saved to app storage."));
            }
            committed.push(destination);
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging_dir);
    result?;
    Ok(data_dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn library_import_and_play_audio_files(
    files: Vec<ImportedAudioFile>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Track>, String> {
    let scan_app = app.clone();
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
    let (mut roots, storage_dir) = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        (core.roots.clone(), core.storage_dir.clone())
    };
    if !roots.contains(&folder) {
        roots.push(folder.clone());
    }
    let roots_to_scan = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_for_app(&scan_app, &roots_to_scan, &storage_dir)
    })
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

#[derive(Deserialize)]
#[cfg(target_os = "android")]
struct YoutubeMusicDirectory {
    path: String,
}

#[cfg(not(target_os = "android"))]
fn desktop_youtube_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let music_directory = app
        .path()
        .audio_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Music")))
        .map_err(|_| "The Music folder couldn’t be located.".to_owned())?;
    let directory = music_directory.join("MichoPlay");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "MichoPlay couldn’t create its folder in Music.".to_owned())?;
    directory
        .canonicalize()
        .map_err(|_| "The MichoPlay music folder couldn’t be located.".to_owned())
}

#[cfg(not(target_os = "android"))]
fn safe_youtube_folder_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(120)
        .collect::<String>();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "Playlist".to_owned()
    } else if matches!(
        cleaned.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        format!("_{cleaned}")
    } else {
        cleaned.to_owned()
    }
}

#[tauri::command]
async fn youtube_music_directory(
    bridge: State<'_, MediaBridge>,
    app: AppHandle,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        let plugin = android_media_plugin(&bridge)?;
        let directory: YoutubeMusicDirectory =
            call_android_media(plugin, "youtubeMusicDirectory", serde_json::json!({})).await?;
        return Ok(directory.path);
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        let directory = desktop_youtube_directory(&app)?;
        Ok(directory.to_string_lossy().into_owned())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeSearchResult {
    id: String,
    title: String,
    url: String,
    thumbnail: Option<String>,
    duration_seconds: Option<f64>,
    is_playlist: bool,
    has_lyrics: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeDownloadPlaylist {
    id: String,
    title: String,
    index: u32,
    total: u32,
}

#[cfg(not(target_os = "android"))]
fn youtube_entry_has_lyrics(entry: &serde_json::Value) -> bool {
    ["subtitles", "automatic_captions"].iter().any(|field| {
        entry
            .get(field)
            .and_then(serde_json::Value::as_object)
            .is_some_and(|captions| {
                captions.iter().any(|(language, formats)| {
                    language.to_ascii_lowercase().starts_with("en")
                        && formats.as_array().is_some_and(|formats| {
                            formats.iter().any(|format| {
                                format.get("ext").and_then(serde_json::Value::as_str) == Some("vtt")
                            })
                        })
                })
            })
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedMusicFolder {
    path: String,
    count: usize,
    name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeDownloadItem {
    id: String,
    title: String,
    url: String,
    thumbnail: Option<String>,
    is_playlist: bool,
    #[serde(default)]
    playlist: Option<YoutubeDownloadPlaylist>,
    status: String,
    #[serde(default)]
    phase: String,
    percent: Option<f32>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    #[serde(default)]
    total_bytes_estimated: bool,
    #[serde(default)]
    speed_bytes_per_second: Option<u64>,
    #[serde(default)]
    eta_seconds: Option<u64>,
    message: String,
    #[serde(default)]
    file_paths: Vec<String>,
}

#[cfg(not(target_os = "android"))]
struct YoutubeDownloadTask {
    item: YoutubeDownloadItem,
    process_id: Option<u32>,
    in_flight: bool,
}

#[derive(Default)]
struct YoutubeDownloadManager {
    #[cfg(not(target_os = "android"))]
    tasks: Vec<YoutubeDownloadTask>,
    #[cfg(not(target_os = "android"))]
    next_id: u64,
    #[cfg(not(target_os = "android"))]
    active_workers: usize,
    #[cfg(not(target_os = "android"))]
    last_progress_emit: Option<std::time::Instant>,
    #[cfg(not(target_os = "android"))]
    storage_path: Option<PathBuf>,
    #[cfg(not(target_os = "android"))]
    last_persist: Option<std::time::Instant>,
    #[cfg(not(target_os = "android"))]
    last_persisted_states: Vec<(String, String, String)>,
}

#[cfg(not(target_os = "android"))]
const MAX_CONCURRENT_YOUTUBE_DOWNLOADS: usize = 3;

#[derive(Default)]
#[cfg_attr(target_os = "android", allow(dead_code))]
struct YoutubeDownloadState(Mutex<YoutubeDownloadManager>);

#[cfg(not(target_os = "android"))]
impl YoutubeDownloadManager {
    fn snapshot(&self) -> Vec<YoutubeDownloadItem> {
        self.tasks.iter().map(|task| task.item.clone()).collect()
    }
}

#[cfg(not(target_os = "android"))]
fn emit_youtube_downloads(app: &AppHandle) {
    let _persist_guard = YOUTUBE_DOWNLOAD_PERSIST_LOCK.lock().ok();
    let (items, persistence) = app
        .state::<YoutubeDownloadState>()
        .0
        .lock()
        .map(|mut manager| {
            let items = manager.snapshot();
            let states = items
                .iter()
                .map(|item| (item.id.clone(), item.status.clone(), item.phase.clone()))
                .collect::<Vec<_>>();
            let should_persist = states != manager.last_persisted_states
                || manager
                    .last_persist
                    .is_none_or(|last| last.elapsed() >= Duration::from_secs(1));
            let persistence = if should_persist {
                manager.storage_path.clone()
            } else {
                None
            };
            if persistence.is_some() {
                manager.last_persist = Some(std::time::Instant::now());
                manager.last_persisted_states = states;
            }
            (items, persistence)
        })
        .unwrap_or_default();
    if let Some(path) = persistence {
        if let Ok(bytes) = serde_json::to_vec(&items) {
            let temporary = path.with_extension("json.tmp");
            if fs::write(&temporary, &bytes).is_ok() {
                if fs::rename(&temporary, &path).is_err() {
                    // Windows does not replace an existing destination with rename.
                    if fs::write(&path, &bytes).is_ok() {
                        let _ = fs::remove_file(&temporary);
                    }
                }
            }
        }
    }
    let _ = app.emit("youtube-downloads-updated", items);
}

#[cfg(not(target_os = "android"))]
fn youtube_progress_size(raw: &str) -> Option<u64> {
    let mut parts = raw
        .trim_start()
        .trim_start_matches('~')
        .trim_start()
        .split_whitespace();
    let first = parts.next()?;
    let unit_start = first
        .find(|character: char| character.is_ascii_alphabetic())
        .unwrap_or(first.len());
    let amount = first[..unit_start].parse::<f64>().ok()?;
    let unit = if unit_start == first.len() {
        parts.next()?
    } else {
        &first[unit_start..]
    };
    let scale = match unit.to_ascii_lowercase().as_str() {
        "b" => 1.0,
        "kb" => 1000.0,
        "mb" => 1000.0_f64.powi(2),
        "gb" => 1000.0_f64.powi(3),
        "kib" => 1024.0,
        "mib" => 1024.0_f64.powi(2),
        "gib" => 1024.0_f64.powi(3),
        _ => return None,
    };
    Some((amount * scale) as u64)
}

#[cfg(not(target_os = "android"))]
fn parse_youtube_eta(raw: &str) -> Option<u64> {
    let parts = raw
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    match parts.as_slice() {
        [minutes, seconds] => minutes.checked_mul(60)?.checked_add(*seconds),
        [hours, minutes, seconds] => hours
            .checked_mul(3600)?
            .checked_add(minutes.checked_mul(60)?)
            .and_then(|value| value.checked_add(*seconds)),
        _ => None,
    }
}

#[cfg(not(target_os = "android"))]
fn set_youtube_download_phase(app: &AppHandle, id: &str, phase: &str, message: &str) {
    let mut changed = false;
    if let Ok(mut manager) = app.state::<YoutubeDownloadState>().0.lock() {
        if let Some(task) = manager
            .tasks
            .iter_mut()
            .find(|task| task.item.id == id && task.item.status == "downloading")
        {
            if task.item.phase != phase || task.item.message != message {
                task.item.phase = phase.to_owned();
                task.item.message = message.to_owned();
                changed = true;
            }
        }
    }
    if changed {
        emit_youtube_downloads(app);
    }
}

#[cfg(not(target_os = "android"))]
fn report_youtube_progress(
    app: &AppHandle,
    id: &str,
    line: &str,
    is_audio_transfer: bool,
    playlist_position: Option<(usize, usize)>,
) -> bool {
    let line = line.trim();
    let custom_fields = line
        .strip_prefix("__MICHOPLAY_PROGRESS__")
        .map(|value| value.split('|').collect::<Vec<_>>());
    let legacy = line.strip_prefix("[download]").map(str::trim);
    if custom_fields.is_none() && legacy.is_none() {
        return false;
    }
    let field = |index: usize| {
        custom_fields
            .as_ref()
            .and_then(|fields| fields.get(index))
            .copied()
            .unwrap_or_default()
            .trim()
    };
    let legacy_progress = legacy.unwrap_or_default();
    let legacy_split = legacy_progress.split_once('%');
    let progress_is_audio = Path::new(field(7))
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "webm" | "m4a" | "mp3" | "opus" | "ogg" | "aac" | "flac" | "wav"
            )
        });
    let Some(percent) = custom_fields
        .as_ref()
        .and_then(|_| {
            field(0)
                .trim()
                .trim_end_matches('%')
                .trim()
                .parse::<f32>()
                .ok()
                .or_else(|| field(6).parse::<f32>().ok())
        })
        .or_else(|| legacy_split.and_then(|(value, _)| value.trim().parse::<f32>().ok()))
        .filter(|value| value.is_finite())
    else {
        return true;
    };
    if !is_audio_transfer && !progress_is_audio {
        return true;
    }
    // Completion is only reported after MP3 validation; this is transfer progress.
    let track_percent = percent.clamp(0.0, 100.0);
    let percent = playlist_position
        .filter(|(_, total)| *total > 0)
        .map(|(current, total)| {
            (((current.saturating_sub(1) as f32 + track_percent / 100.0) / total as f32) * 100.0)
                .clamp(0.0, 100.0)
        })
        .unwrap_or(track_percent);
    let legacy_remainder = legacy_split
        .map(|(_, remainder)| remainder)
        .unwrap_or_default();
    let total_bytes = field(2)
        .parse::<u64>()
        .ok()
        .or_else(|| field(3).parse::<u64>().ok())
        .or_else(|| {
            legacy_remainder
                .trim_start()
                .strip_prefix("of")
                .and_then(youtube_progress_size)
        });
    let downloaded_bytes = field(1).parse::<u64>().ok().or_else(|| {
        total_bytes.map(|total| (total as f64 * f64::from(track_percent) / 100.0) as u64)
    });
    let speed_bytes_per_second = field(4)
        .parse::<f64>()
        .ok()
        .map(|speed| speed as u64)
        .or_else(|| {
            legacy_remainder
                .split_once(" at ")
                .and_then(|(_, value)| youtube_progress_size(value.trim_start().split('/').next()?))
        });
    let eta_seconds = field(5).parse::<u64>().ok().or_else(|| {
        legacy_remainder
            .split_once("ETA ")
            .and_then(|(_, eta)| parse_youtube_eta(eta.trim()))
    });
    let mut should_emit = false;
    if let Ok(mut manager) = app.state::<YoutubeDownloadState>().0.lock() {
        let mut updated = false;
        let mut force_emit = false;
        if let Some(task) = manager
            .tasks
            .iter_mut()
            .find(|task| task.item.id == id && task.item.status == "downloading")
        {
            let previous_percent = task.item.percent;
            let percent = percent.max(task.item.percent.unwrap_or(0.0));
            task.item.percent = Some(percent);
            task.item.phase = "downloading".to_owned();
            if playlist_position.is_none() {
                if let Some(total) = total_bytes {
                    let estimated =
                        field(2).parse::<u64>().is_err() && field(3).parse::<u64>().is_ok();
                    if task
                        .item
                        .total_bytes
                        .map_or(true, |previous| total >= previous)
                    {
                        task.item.total_bytes = Some(total);
                        task.item.total_bytes_estimated = estimated;
                    }
                }
                if let Some(downloaded) = downloaded_bytes {
                    task.item.downloaded_bytes =
                        Some(downloaded.max(task.item.downloaded_bytes.unwrap_or(0)));
                    if !task.item.total_bytes_estimated {
                        if let Some(total) = task.item.total_bytes {
                            task.item.downloaded_bytes =
                                task.item.downloaded_bytes.map(|value| value.min(total));
                        }
                    }
                }
                task.item.speed_bytes_per_second = speed_bytes_per_second;
                task.item.eta_seconds = eta_seconds;
            } else {
                task.item.downloaded_bytes = None;
                task.item.total_bytes = None;
                task.item.speed_bytes_per_second = speed_bytes_per_second;
                task.item.eta_seconds = eta_seconds;
            }
            task.item.message = playlist_position
                .map(|(current, total)| {
                    format!("Track {current} of {total} · {track_percent:.1}% of this track")
                })
                .unwrap_or_else(|| "Downloading audio…".to_owned());
            updated = true;
            force_emit = previous_percent.is_none()
                || (percent >= 100.0 && previous_percent.is_some_and(|value| value < 100.0));
        }
        if updated {
            let now = std::time::Instant::now();
            if force_emit
                || manager.last_progress_emit.map_or(true, |last| {
                    now.duration_since(last) >= Duration::from_millis(250)
                })
            {
                manager.last_progress_emit = Some(now);
                should_emit = true;
            }
        }
    }
    if should_emit {
        emit_youtube_downloads(app);
    }
    true
}

#[cfg(not(target_os = "android"))]
fn bundled_desktop_tool(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let filename = if cfg!(target_os = "windows") {
        format!("michoplay-{name}.exe")
    } else {
        format!("michoplay-{name}")
    };
    let mut directories = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            directories.push(directory.to_path_buf());
            directories.push(directory.join("binaries"));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        directories.push(resources.clone());
        directories.push(resources.join("binaries"));
    }

    for directory in directories {
        let direct_path = directory.join(&filename);
        if direct_path.is_file() {
            return Ok(direct_path);
        }

        // Tauri keeps the target triple on externalBin filenames in the bundle.
        // Look for that packaged name as well as the unsuffixed development name.
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(candidate) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if candidate.starts_with(&format!("michoplay-{name}-"))
                    && (candidate.ends_with(".exe") == cfg!(target_os = "windows"))
                    && path.is_file()
                {
                    return Ok(path);
                }
            }
        }
    }

    Err(format!(
        "MichoPlay’s bundled {name} tool is missing. Reinstall the desktop app."
    ))
}

#[cfg(not(target_os = "android"))]
fn ffmpeg_supports_mp3(path: &Path) -> bool {
    let output = hidden_command(path)
        .args(["-hide_banner", "-encoders"])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let report = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    report
        .lines()
        .any(|line| line.split_whitespace().any(|field| field == "libmp3lame"))
}

#[cfg(not(target_os = "android"))]
fn desktop_mp3_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    // yt-dlp uses libmp3lame for MP3 extraction, so the encoder must be available.
    if let Ok(bundled) = bundled_desktop_tool(app, "ffmpeg") {
        if ffmpeg_supports_mp3(&bundled) {
            return Ok(bundled);
        }
    }
    let executable = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if let Some(system) = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(executable))
        .find(|path| path.is_file() && ffmpeg_supports_mp3(path))
    {
        return Ok(system);
    }
    Err("MichoPlay needs FFmpeg with MP3 encoding support to download audio. Install FFmpeg with libmp3lame enabled, then try again.".to_owned())
}

#[tauri::command]
async fn library_pick_music_folder(
    bridge: State<'_, MediaBridge>,
) -> Result<PickedMusicFolder, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(plugin, "chooseMusicFolder", serde_json::json!({})).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        Err("Choose a music folder from the Android app.".to_owned())
    }
}

#[tauri::command]
async fn library_discover_music_folders(
    bridge: State<'_, MediaBridge>,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(plugin, "discoverMusicFolders", serde_json::json!({})).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn media_share_text(
    title: String,
    text: String,
    url: String,
    bridge: State<'_, MediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_media_plugin(&bridge)?;
        let _: serde_json::Value = call_android_media(
            plugin,
            "shareText",
            serde_json::json!({ "title": title, "text": text, "url": url }),
        )
        .await?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (title, text, url, bridge);
        Err("Native Android sharing is unavailable on this platform.".to_owned())
    }
}

#[tauri::command]
async fn library_pick_audio_files(bridge: State<'_, MediaBridge>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(plugin, "chooseAudioFiles", serde_json::json!({})).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        Err("Choose audio files from the Android app.".to_owned())
    }
}

#[tauri::command]
async fn youtube_search(
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
    include_lyrics: Option<bool>,
    playlist_items: Option<bool>,
    bridge: State<'_, MediaBridge>,
    app: AppHandle,
) -> Result<Vec<YoutubeSearchResult>, String> {
    let playlist_items = playlist_items.unwrap_or(false);
    let limit = limit
        .unwrap_or(15)
        .clamp(1, if playlist_items { 100 } else { 30 });
    let offset = offset
        .unwrap_or(0)
        .min(if playlist_items { 5_000 } else { 50 });
    #[cfg(target_os = "android")]
    {
        let _ = app;
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeSearch",
            serde_json::json!({ "query": query, "limit": limit, "offset": offset, "includeLyrics": include_lyrics.unwrap_or(false), "playlistItems": playlist_items }),
        )
        .await
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        let search_end = offset
            .saturating_add(limit)
            .min(if playlist_items { 5_000 } else { 50 });
        let yt_dlp = bundled_desktop_tool(&app, "yt-dlp")?;
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
        tauri::async_runtime::spawn_blocking(move || {
            let search = if is_url {
                query
            } else {
                format!("ytsearch{search_end}:{query}")
            };
            let mut command = hidden_command(yt_dlp);
            command.arg("--ignore-config").arg("--no-warnings");
            if is_playlist_url || !include_lyrics.unwrap_or(false) {
                command.arg("--flat-playlist");
            }
            let output = command
                .arg("--dump-single-json")
                .arg("--playlist-end")
                .arg(search_end.to_string())
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
            if is_playlist_url && !playlist_items {
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
                    has_lyrics: false,
                }]);
            }
            let entries: Vec<&serde_json::Value> = document
                .get("entries")
                .and_then(serde_json::Value::as_array)
                .map(|entries| entries.iter().collect())
                .unwrap_or_else(|| vec![&document]);
            let results = entries
                .into_iter()
                .skip(offset)
                .take(limit)
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?.to_owned();
                    let title = entry.get("title")?.as_str()?.trim().to_owned();
                    if title.is_empty() {
                        return None;
                    }
                    let has_lyrics = youtube_entry_has_lyrics(entry);
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
                        has_lyrics,
                    })
                })
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
async fn youtube_downloads_state(
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<Vec<YoutubeDownloadItem>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = state;
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(plugin, "youtubeDownloadsState", serde_json::json!({})).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        Ok(state
            .0
            .lock()
            .map(|manager| manager.snapshot())
            .unwrap_or_default())
    }
}

#[tauri::command]
async fn youtube_download_enqueue(
    url: String,
    title: String,
    thumbnail: Option<String>,
    is_playlist: bool,
    playlist: Option<YoutubeDownloadPlaylist>,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<YoutubeDownloadItem, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeDownloadEnqueue",
            serde_json::json!({
                "url": url,
                "title": title,
                "thumbnail": thumbnail,
                "isPlaylist": is_playlist,
                "playlistId": playlist.as_ref().map(|value| value.id.as_str()),
                "playlistTitle": playlist.as_ref().map(|value| value.title.as_str()),
                "playlistIndex": playlist.as_ref().map(|value| value.index),
                "playlistTotal": playlist.as_ref().map(|value| value.total),
            }),
        )
        .await
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
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
                playlist,
                status: "queued".to_owned(),
                phase: "queued".to_owned(),
                percent: None,
                downloaded_bytes: None,
                total_bytes: None,
                total_bytes_estimated: false,
                speed_bytes_per_second: None,
                eta_seconds: None,
                message: "Waiting to download".to_owned(),
                file_paths: Vec::new(),
            };
            manager.tasks.push(YoutubeDownloadTask {
                item: item.clone(),
                process_id: None,
                in_flight: false,
            });
            item
        };
        emit_youtube_downloads(&app);
        start_youtube_download_workers(app.clone());
        Ok(item)
    }
}

#[tauri::command]
async fn youtube_download_pause(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeDownloadPause",
            serde_json::json!({ "id": id }),
        )
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
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
            task.item.phase = "paused".to_owned();
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
async fn youtube_download_resume(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeDownloadResume",
            serde_json::json!({ "id": id }),
        )
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
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
            task.item.phase = "queued".to_owned();
            task.item.message = "Waiting to resume".to_owned();
        }
        emit_youtube_downloads(&app);
        start_youtube_download_workers(app);
        Ok(())
    }
}

#[tauri::command]
async fn youtube_download_cancel(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeDownloadCancel",
            serde_json::json!({ "id": id }),
        )
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
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
            task.item.phase = "cancelled".to_owned();
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
async fn youtube_download_remove(
    id: String,
    app: AppHandle,
    state: State<'_, YoutubeDownloadState>,
    bridge: State<'_, MediaBridge>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        let plugin = android_media_plugin(&bridge)?;
        call_android_media(
            plugin,
            "youtubeDownloadRemove",
            serde_json::json!({ "id": id }),
        )
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bridge;
        let mut manager = state
            .0
            .lock()
            .map_err(|_| "The download manager is unavailable.".to_owned())?;
        manager.tasks.retain(|task| {
            task.item.id != id || task.item.status == "downloading" || task.item.status == "queued"
        });
        drop(manager);
        emit_youtube_downloads(&app);
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
fn start_youtube_download_workers(app: AppHandle) {
    let workers_to_start = app
        .state::<YoutubeDownloadState>()
        .0
        .lock()
        .map(|mut manager| {
            let queued = manager
                .tasks
                .iter()
                .filter(|task| task.item.status == "queued")
                .filter(|task| !task.in_flight)
                .count();
            let available = MAX_CONCURRENT_YOUTUBE_DOWNLOADS.saturating_sub(manager.active_workers);
            let count = queued.min(available);
            manager.active_workers += count;
            count
        })
        .unwrap_or(0);
    for _ in 0..workers_to_start {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || youtube_download_worker(worker_app));
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
                .find(|task| task.item.status == "queued" && !task.in_flight)
            {
                task.in_flight = true;
                task.item.status = "downloading".to_owned();
                task.item.phase = "preparing".to_owned();
                task.item.percent = None;
                task.item.downloaded_bytes = None;
                task.item.total_bytes = None;
                task.item.total_bytes_estimated = false;
                task.item.speed_bytes_per_second = None;
                task.item.eta_seconds = None;
                task.item.message = "Starting download…".to_owned();
                Some((task.item.id.clone(), task.item.url.clone()))
            } else {
                manager.active_workers = manager.active_workers.saturating_sub(1);
                None
            }
        };
        let Some((id, url)) = next else {
            emit_youtube_downloads(&app);
            return;
        };
        emit_youtube_downloads(&app);
        let (title, playlist_title, is_playlist) = app
            .state::<YoutubeDownloadState>()
            .0
            .lock()
            .ok()
            .and_then(|manager| {
                manager
                    .tasks
                    .iter()
                    .find(|task| task.item.id == id)
                    .map(|task| {
                        (
                            task.item.title.clone(),
                            task.item
                                .playlist
                                .as_ref()
                                .map(|playlist| playlist.title.clone()),
                            task.item.is_playlist,
                        )
                    })
            })
            .unwrap_or_else(|| ("YouTube audio".to_owned(), None, false));
        let result = run_youtube_download(
            &app,
            &id,
            &url,
            &title,
            playlist_title.as_deref(),
            is_playlist,
        );
        {
            let state = app.state::<YoutubeDownloadState>();
            if let Ok(mut manager) = state.0.lock() {
                if let Some(task) = manager.tasks.iter_mut().find(|task| task.item.id == id) {
                    task.process_id = None;
                    task.in_flight = false;
                    if task.item.status == "downloading" {
                        match result {
                            Ok((final_bytes, file_paths)) => {
                                task.item.status = "completed".to_owned();
                                task.item.phase = "completed".to_owned();
                                task.item.percent = Some(100.0);
                                task.item.speed_bytes_per_second = None;
                                task.item.eta_seconds = None;
                                task.item.file_paths = file_paths;
                                if let Some(bytes) = final_bytes {
                                    task.item.downloaded_bytes = Some(bytes);
                                    task.item.total_bytes = Some(bytes);
                                }
                                task.item.message = "Completed".to_owned();
                            }
                            Err(error) => {
                                task.item.status = "failed".to_owned();
                                task.item.phase = "failed".to_owned();
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
fn youtube_download_file_error(error: std::io::Error) -> String {
    use std::io::ErrorKind;

    match error.kind() {
        ErrorKind::NotFound => {
            "The downloaded song is missing from Music/MichoPlay. Try downloading it again."
        }
        ErrorKind::PermissionDenied => {
            "MichoPlay doesn't have permission to read the downloaded song. Allow access to your Music folder and try again."
        }
        ErrorKind::NotADirectory => {
            "The downloaded song's folder is no longer available. Restore the folder or download the song again."
        }
        ErrorKind::TimedOut => {
            "Your Music folder took too long to respond. Check that the drive is connected and try again."
        }
        _ => {
            "MichoPlay couldn't read the downloaded song. Check that your Music folder is accessible and try again."
        }
    }
    .to_owned()
}

#[cfg(not(target_os = "android"))]
fn youtube_download_file_path(line: &str) -> Result<Option<PathBuf>, String> {
    let Some(json) = line.strip_prefix("__MICHOPLAY_FILE__") else {
        return Ok(None);
    };
    let path: String = serde_json::from_str(json).map_err(|_| {
        "MichoPlay couldn't read where the song was saved. Try downloading it again.".to_owned()
    })?;
    if path.is_empty() {
        return Err(
            "The download finished without a saved song location. Try downloading it again."
                .to_owned(),
        );
    }
    Ok(Some(PathBuf::from(path)))
}

#[cfg(not(target_os = "android"))]
fn youtube_download_file_size(path: &Path) -> Result<u64, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
    {
        return Err("The saved download isn't an MP3 file. Try downloading it again.".to_owned());
    }
    let metadata = std::fs::metadata(path).map_err(youtube_download_file_error)?;
    if !metadata.is_file() {
        return Err("The saved download isn't a song file. Try downloading it again.".to_owned());
    }
    if metadata.len() == 0 {
        return Err("The downloaded song is empty. Try downloading it again.".to_owned());
    }
    let audio = Probe::open(path)
        .and_then(|probe| probe.read())
        .map_err(|_| {
            "The downloaded audio couldn't be read. Try downloading it again.".to_owned()
        })?;
    if audio.properties().duration().is_zero() {
        return Err("The downloaded audio couldn't be read. Try downloading it again.".to_owned());
    }
    Ok(metadata.len())
}

#[cfg(not(target_os = "android"))]
fn youtube_download_is_active(app: &AppHandle, id: &str) -> bool {
    app.state::<YoutubeDownloadState>()
        .0
        .lock()
        .ok()
        .and_then(|manager| {
            manager
                .tasks
                .iter()
                .find(|task| task.item.id == id)
                .map(|task| task.item.status == "downloading")
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "android"))]
fn run_youtube_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    title: &str,
    playlist_title: Option<&str>,
    is_playlist: bool,
) -> Result<(Option<u64>, Vec<String>), String> {
    let directory = desktop_youtube_directory(app)?;
    let yt_dlp = bundled_desktop_tool(app, "yt-dlp")?;
    let ffmpeg = desktop_mp3_ffmpeg(app)?;
    let deno = bundled_desktop_tool(app, "deno")?;
    let output_directory = if is_playlist || playlist_title.is_some() {
        let playlist_directory =
            directory.join(safe_youtube_folder_name(playlist_title.unwrap_or(title)));
        std::fs::create_dir_all(&playlist_directory).map_err(|_| {
            "MichoPlay couldn’t create the playlist folder in Music/MichoPlay.".to_owned()
        })?;
        playlist_directory
    } else {
        directory
    };
    let output_template = output_directory.join("%(title).160B [%(id)s].%(ext)s");
    let mut command = hidden_command(yt_dlp);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .arg("--ignore-config")
        .arg("--encoding")
        .arg("utf-8")
        .arg("--ignore-errors")
        .arg("--no-colors")
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-template")
        .arg("download:__MICHOPLAY_PROGRESS__%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent)s|%(progress.filename)s")
        .arg("--continue")
        .arg(if is_playlist {
            "--yes-playlist"
        } else {
            "--no-playlist"
        })
        .arg("--format")
        // Download an audio-only input for MP3 extraction.
        .arg("bestaudio[acodec!=none]/bestaudio")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--audio-quality")
        .arg("0")
        .arg("--write-thumbnail")
        .arg("--write-subs")
        .arg("--write-auto-subs")
        .arg("--sub-langs")
        .arg("en.*")
        .arg("--sub-format")
        .arg("vtt")
        .arg("--ffmpeg-location")
        .arg(ffmpeg)
        .arg("--js-runtimes")
        .arg(format!("deno:{}", deno.to_string_lossy()))
        .arg("--embed-metadata")
        // --embed-metadata also enables chapters. The audio-only FFmpeg bundle
        // has no ffmetadata demuxer, so chapter sidecars make post-processing fail.
        .arg("--no-embed-chapters")
        // Existing MP3s may contain attached pictures. The audio-only FFmpeg
        // cannot probe their dimensions and fails when copying them to the MP3
        // output. Reattach the downloaded cover with Lofty after tagging.
        .arg("--postprocessor-args")
        .arg("Metadata+ffmpeg_o:-vn")
        .arg("--print")
        // JSON escapes preserve Unicode, backslashes, and line breaks even
        // when the desktop's default output encoding cannot represent them.
        .arg("after_move:__MICHOPLAY_FILE__%(filepath)j")
        .arg("--output")
        .arg(output_template)
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Couldn't start this download. Restart MichoPlay and try again.".to_owned())?;
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
    let stderr = child.stderr.take().ok_or_else(|| {
        "MichoPlay couldn't read the download status. Restart the app and try again.".to_owned()
    })?;
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail = stderr_tail.clone();
    let app_for_stderr = app.clone();
    let task_id = id.to_owned();
    let audio_transfer = Arc::new(AtomicBool::new(false));
    let audio_transfer_stderr = audio_transfer.clone();
    let stderr_reader = std::thread::spawn(move || {
        let mut playlist_position = None;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(position) = line.split_once("Downloading item").map(|(_, value)| value) {
                let mut fields = position.split_whitespace();
                let current = fields.next().and_then(|value| value.parse::<usize>().ok());
                let is_of = fields.next() == Some("of");
                let total = fields.next().and_then(|value| value.parse::<usize>().ok());
                if is_of {
                    playlist_position = current.zip(total).filter(|(_, total)| *total > 0);
                }
            }
            if let Some(destination) = line.trim().strip_prefix("[download] Destination:") {
                let extension = Path::new(destination.trim())
                    .extension()
                    .and_then(std::ffi::OsStr::to_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let current_is_audio = matches!(
                    extension.as_str(),
                    "webm" | "m4a" | "mp3" | "opus" | "ogg" | "aac" | "flac" | "wav"
                );
                audio_transfer_stderr.store(current_is_audio, Ordering::Relaxed);
                if current_is_audio {
                    set_youtube_download_phase(
                        &app_for_stderr,
                        &task_id,
                        "downloading",
                        "Downloading audio…",
                    );
                } else if extension == "vtt" {
                    set_youtube_download_phase(
                        &app_for_stderr,
                        &task_id,
                        "lyrics",
                        "Fetching synced lyrics…",
                    );
                }
            } else if line.starts_with("[youtube]") {
                set_youtube_download_phase(
                    &app_for_stderr,
                    &task_id,
                    "fetching",
                    "Getting song information…",
                );
            } else if line.contains("[ExtractAudio]") {
                set_youtube_download_phase(
                    &app_for_stderr,
                    &task_id,
                    "processing",
                    "Processing audio…",
                );
            } else if line.contains("[Metadata]") || line.contains("[EmbedThumbnail]") {
                set_youtube_download_phase(
                    &app_for_stderr,
                    &task_id,
                    "metadata",
                    "Adding artwork and metadata…",
                );
            }
            if !report_youtube_progress(
                &app_for_stderr,
                &task_id,
                &line,
                audio_transfer_stderr.load(Ordering::Relaxed),
                playlist_position,
            ) {
                if let Ok(mut lines) = tail.lock() {
                    lines.push(line);
                    if lines.len() > 100 {
                        lines.remove(0);
                    }
                }
            }
        }
    });
    let mut output_paths = Vec::<PathBuf>::new();
    let mut output_error = None;
    let mut playlist_position = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => {
                    output_error.get_or_insert_with(|| {
                        "MichoPlay couldn't read where the song was saved. Try downloading it again.".to_owned()
                    });
                    break;
                }
            };
            if let Some(destination) = line.trim().strip_prefix("[download] Destination:") {
                let extension = Path::new(destination.trim())
                    .extension()
                    .and_then(std::ffi::OsStr::to_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                audio_transfer.store(
                    matches!(
                        extension.as_str(),
                        "webm" | "m4a" | "mp3" | "opus" | "ogg" | "aac" | "flac" | "wav"
                    ),
                    Ordering::Relaxed,
                );
            }
            if let Some(position) = line.split_once("Downloading item").map(|(_, value)| value) {
                let mut fields = position.split_whitespace();
                let current = fields.next().and_then(|value| value.parse::<usize>().ok());
                let is_of = fields.next() == Some("of");
                let total = fields.next().and_then(|value| value.parse::<usize>().ok());
                if is_of {
                    playlist_position = current.zip(total).filter(|(_, total)| *total > 0);
                }
            }
            let _ = report_youtube_progress(
                app,
                id,
                &line,
                audio_transfer.load(Ordering::Relaxed),
                playlist_position,
            );
            match youtube_download_file_path(&line) {
                Ok(Some(path)) => output_paths.push(path),
                Ok(None) => {
                    // stdout carries the saved-file marker; transfer progress is read from stderr.
                }
                Err(error) => {
                    output_error.get_or_insert(error);
                }
            }
        }
    }
    let status = child.wait().map_err(|_| {
        "MichoPlay couldn't confirm whether the download finished. Try again.".to_owned()
    })?;
    let _ = stderr_reader.join();
    if status.success() {
        if !youtube_download_is_active(app, id) {
            return Err("The download was stopped.".to_owned());
        }
        set_youtube_download_phase(app, id, "verifying", "Verifying downloaded MP3…");
        if let Some(error) = output_error {
            return Err(error);
        }
        if output_paths.is_empty() {
            return Err(
                "The download finished without a saved song location. Try downloading it again."
                    .to_owned(),
            );
        }
        let mut final_bytes = 0_u64;
        for path in &output_paths {
            if !youtube_download_is_active(app, id) {
                return Err("The download was stopped.".to_owned());
            }
            // Verify the audio before optional artwork work so a bad path or
            // inaccessible file is reported without attempting to rewrite it.
            youtube_download_file_size(path)?;
            if has_downloaded_lyrics(path) {
                set_youtube_download_phase(app, id, "lyrics", "Fetching and embedding lyrics…");
            }
            attach_downloaded_lyrics(path);
            if let Some(thumbnail) = thumbnail_for_audio(path) {
                set_youtube_download_phase(
                    app,
                    id,
                    "metadata",
                    "Adding artwork and song information…",
                );
                if embed_thumbnail_in_mp3(path, &thumbnail).is_ok() {
                    let _ = std::fs::remove_file(thumbnail);
                }
            }
            set_youtube_download_phase(app, id, "saving", "Adding song to your library…");
            if !youtube_download_is_active(app, id) {
                return Err("The download was stopped.".to_owned());
            }
            final_bytes = final_bytes.saturating_add(youtube_download_file_size(path)?);
        }
        return Ok((
            Some(final_bytes),
            output_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ));
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
        return Ok((None, Vec::new()));
    }
    let details = stderr_tail
        .lock()
        .map(|lines| {
            lines
                .iter()
                .rev()
                .take(40)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if details.trim().is_empty() {
        Err("The download stopped before it could finish. Try again.".to_owned())
    } else {
        Err(details)
    }
}

#[cfg(all(unix, not(target_os = "android")))]
fn stop_download_process(pid: u32) {
    let _ = hidden_command("kill")
        .arg("-TERM")
        .arg("--")
        .arg(format!("-{pid}"))
        .status();
}

#[cfg(windows)]
fn stop_download_process(pid: u32) {
    let _ = hidden_command("taskkill")
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
    app: AppHandle,
) -> Result<Vec<Track>, String> {
    let path = PathBuf::from(folder);
    let target = path.canonicalize().unwrap_or(path);
    let (mut roots, storage_dir) = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        (core.roots.clone(), core.storage_dir.clone())
    };
    roots.retain(|root| root != &target);
    let roots_to_scan = roots.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_for_app(&app, &roots_to_scan, &storage_dir)
    })
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
    app: AppHandle,
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
    let storage_dir = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .storage_dir
        .clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_for_app(&app, &roots_to_scan, &storage_dir)
    })
    .await
    .map_err(|_| "The library scan could not be completed.".to_owned())??;
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    Ok(core.replace_library(roots, tracks))
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn library_saved_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    Ok(core
        .roots
        .iter()
        .filter(|root| {
            !root
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("Android"))
        })
        .map(|root| root.to_string_lossy().into_owned())
        .collect())
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn library_cached_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let storage_dir = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .storage_dir
        .clone();
    if !storage_dir.join("library.sqlite").exists() {
        if let Ok(bytes) = fs::read(storage_dir.join("library-index.json")) {
            if let Ok(entries) = serde_json::from_slice::<Vec<CachedTrack>>(&bytes) {
                let roots = entries
                    .iter()
                    .map(|entry| PathBuf::from(&entry.root_path))
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                let _ = write_library_cache(&storage_dir, &entries, &roots);
                return Ok(entries
                    .into_iter()
                    .map(|entry| {
                        let mut track = entry.track;
                        if track.path.is_empty() {
                            track.path = entry.path;
                        }
                        track
                    })
                    .collect());
            }
        }
        return Ok(Vec::new());
    }
    let connection = Connection::open(storage_dir.join("library.sqlite"))
        .map_err(|_| "MichoPlay’s saved library index could not be opened.".to_owned())?;
    let mut statement = connection
        .prepare("SELECT path, track_json FROM tracks ORDER BY path")
        .map_err(|_| "MichoPlay’s saved library index could not be read.".to_owned())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "MichoPlay’s saved library index could not be read.".to_owned())?;
    rows.map(|row| {
        row.map_err(|_| "MichoPlay’s saved library index could not be read.".to_owned())
            .and_then(|(path, json)| {
                let mut track: Track = serde_json::from_str(&json).map_err(|_| {
                    "MichoPlay’s saved library index contains invalid data.".to_owned()
                })?;
                if track.path.is_empty() {
                    track.path = path;
                }
                Ok(track)
            })
    })
    .collect()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackMetadataEdit {
    title: String,
    artist: String,
    album: String,
    release_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackMetadataUpdateResult {
    track: Track,
    saved_to_file: bool,
    write_error: Option<String>,
}

#[tauri::command]
async fn library_update_track_metadata(
    track_id: u64,
    metadata: TrackMetadataEdit,
    state: State<'_, AppState>,
    bridge: State<'_, MediaBridge>,
) -> Result<TrackMetadataUpdateResult, String> {
    let title = metadata.title.trim();
    let artist = metadata.artist.trim();
    let album = metadata.album.trim();
    let release_date = metadata.release_date.trim();
    if title.is_empty() || artist.is_empty() || album.is_empty() {
        return Err("Title, artist, and album are required.".to_owned());
    }
    if [title, artist, album, release_date]
        .iter()
        .any(|value| value.len() > 500 || value.chars().any(char::is_control))
    {
        return Err("Metadata contains unsupported characters or is too long.".to_owned());
    }
    let metadata = TrackMetadataEdit {
        title: title.to_owned(),
        artist: artist.to_owned(),
        album: album.to_owned(),
        release_date: release_date.to_owned(),
    };

    #[cfg(target_os = "android")]
    {
        let path = {
            let core = state.0.lock().map_err(|_| "The library is unavailable.")?;
            core.tracks
                .get(core.find_track_index(track_id)?)
                .map(|track| track.path.to_string_lossy().into_owned())
                .ok_or_else(|| "The song is no longer in the library.".to_owned())?
        };
        let plugin = android_media_plugin(&bridge)?;
        let _: serde_json::Value = call_android_media(
            plugin,
            "requestMetadataWriteAccess",
            serde_json::json!({ "path": path }),
        )
        .await?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = &bridge;

    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    let index = core.find_track_index(track_id)?;
    let existing = &core.tracks[index];
    let path = existing.path.clone();
    if !path.is_file() {
        return Err("This song's file is unavailable for editing.".to_owned());
    }
    let root = PathBuf::from(&existing.track.root_path);
    let previous_added_at = existing.track.added_at;
    let previous_artwork = existing.artwork.clone();
    let mut tagged = Probe::open(&path)
        .and_then(|probe| probe.read())
        .map_err(|error| format!("Could not read song metadata: {error}"))?;
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tagged.primary_tag_type()));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or("This audio format does not support editable tags.")?;
    tag.insert_text(ItemKey::TrackTitle, title.to_owned());
    tag.insert_text(ItemKey::TrackArtist, artist.to_owned());
    tag.insert_text(ItemKey::AlbumTitle, album.to_owned());
    tag.remove_key(ItemKey::ReleaseDate);
    tag.remove_key(ItemKey::RecordingDate);
    if !release_date.is_empty() {
        tag.insert_text(ItemKey::ReleaseDate, release_date.to_owned());
    }
    #[cfg(target_os = "android")]
    let mut write_error = None;
    #[cfg(not(target_os = "android"))]
    let write_error: Option<String> = None;
    #[cfg(target_os = "android")]
    let saved_to_file = match tag.save_to_path(&path, WriteOptions::default()) {
        Ok(()) => true,
        Err(_direct_write_error) => {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("audio");
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let temp_path = core.storage_dir.join(format!(
                ".michoplay-metadata-{track_id}-{stamp}.{extension}"
            ));
            let prepared = (|| -> Result<(), String> {
                fs::copy(&path, &temp_path)
                    .map_err(|error| format!("Could not prepare the song file: {error}"))?;
                tag.save_to_path(&temp_path, WriteOptions::default())
                    .map_err(|error| format!("Could not edit song metadata: {error}"))?;
                let plugin = android_media_plugin(&bridge)?;
                plugin
                    .run_mobile_plugin::<()>(
                        "writeMetadataFile",
                        serde_json::json!({ "path": path, "tempPath": temp_path }),
                    )
                    .map_err(|error| error.to_string())
            })();
            let _ = fs::remove_file(&temp_path);
            match prepared {
                Ok(()) => true,
                Err(error) => {
                    write_error = Some(error);
                    false
                }
            }
        }
    };
    #[cfg(not(target_os = "android"))]
    let saved_to_file = {
        let _ = &bridge;
        tag.save_to_path(&path, WriteOptions::default())
            .map_err(|error| format!("Could not save song metadata: {error}"))?;
        true
    };

    let mut refreshed = if saved_to_file {
        read_track(&path, track_id, &root, previous_artwork)
    } else {
        existing.clone()
    };
    if !saved_to_file {
        apply_metadata_edit(&mut refreshed.track, &metadata);
    }
    refreshed.track.added_at = previous_added_at;
    let track = refreshed.track.clone();
    let file_metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect edited song: {error}"))?;
    let modified_at = file_metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default();
    let artwork_mime = refreshed.artwork.as_ref().map(|art| art.mime.clone());
    let track_json = serde_json::to_string(&track).map_err(|error| error.to_string())?;
    let _cache_write = LIBRARY_CACHE_WRITE_LOCK
        .lock()
        .map_err(|_| "The library cache is unavailable.".to_owned())?;
    let mut connection = open_library_cache(&core.storage_dir)
        .map_err(|error| format!("Could not update the library cache: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not update the library cache: {error}"))?;
    if saved_to_file {
        transaction
            .execute(
                "DELETE FROM track_metadata_overrides WHERE path = ?1",
                [&track.path],
            )
            .map_err(|error| format!("Could not update the library cache: {error}"))?;
    } else {
        transaction
            .execute(
                "INSERT INTO track_metadata_overrides(path, title, artist, album, release_date)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET title = excluded.title, artist = excluded.artist,
               album = excluded.album, release_date = excluded.release_date",
                params![
                    track.path,
                    track.title,
                    track.artist,
                    track.album,
                    track.release_date
                ],
            )
            .map_err(|error| format!("Could not save metadata in MichoPlay: {error}"))?;
    }
    transaction.execute(
        "INSERT INTO tracks(path, root_path, title, artist, album, folder_path, file_size, modified_at, track_json, artwork_mime)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title, artist = excluded.artist,
           album = excluded.album, file_size = excluded.file_size, modified_at = excluded.modified_at,
           track_json = excluded.track_json, artwork_mime = excluded.artwork_mime",
        params![track.path, track.root_path, track.title, track.artist, track.album,
            track.folder_path, file_metadata.len().min(i64::MAX as u64) as i64,
            modified_at, track_json, artwork_mime],
    ).map_err(|error| format!("Could not update the library cache: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not update the library cache: {error}"))?;
    if let (Some(key), Some(artwork)) = (&track.artwork_key, &refreshed.artwork) {
        core.artwork_by_key.insert(key.clone(), artwork.clone());
    }
    core.tracks[index] = refreshed;
    Ok(TrackMetadataUpdateResult {
        track,
        saved_to_file,
        write_error,
    })
}

#[tauri::command]
async fn library_delete_track(
    track_id: u64,
    state: State<'_, AppState>,
    bridge: State<'_, MediaBridge>,
) -> Result<Vec<Track>, String> {
    let (path, roots, storage_dir) = {
        let core = state
            .0
            .lock()
            .map_err(|_| "The library is unavailable.".to_owned())?;
        let item = &core.tracks[core.find_track_index(track_id)?];
        (
            item.path.clone(),
            core.roots.clone(),
            core.storage_dir.clone(),
        )
    };
    if !path.is_file() {
        return Err("This song's file is no longer available.".to_owned());
    }

    #[cfg(target_os = "android")]
    {
        let plugin = android_media_plugin(&bridge)?;
        let _: serde_json::Value = call_android_media(
            plugin,
            "deleteAudioFile",
            serde_json::json!({ "path": path.to_string_lossy() }),
        )
        .await?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &bridge;
        fs::remove_file(&path)
            .map_err(|error| format!("Could not delete the song file: {error}"))?;
    }

    let scan_roots = roots.clone();
    let scan_storage = storage_dir.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        scan_roots_with_progress(&scan_roots, &scan_storage, |_, _, _| {})
    })
    .await
    .map_err(|_| "The library scan could not be completed.".to_owned())??;

    let mut core = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?;
    let playing_track = core
        .current_queue_index
        .and_then(|index| core.queue.get(index))
        .copied();
    if playing_track == Some(track_id) {
        if let Some(sink) = core.sink.take() {
            sink.stop();
        }
        core.output = None;
        core.is_playing = false;
        core.resume_after_interruption = false;
        core.current_queue_index = None;
    }
    Ok(core.replace_library(roots, tracks))
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_play_track(track_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?
        .play_track(track_id)
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_queue_add(track_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.queue_add(track_id)
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn library_artwork(
    artwork_key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let art = state
        .0
        .lock()
        .map_err(|_| "The library is unavailable.".to_owned())?
        .artwork_by_key
        .get(&artwork_key)
        .cloned();
    Ok(art.map(|art| format!("data:{};base64,{}", art.mime, STANDARD.encode(&art.data))))
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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
    let previous_queue = std::mem::replace(&mut core.queue, track_ids);
    let previous_priority_queue = std::mem::take(&mut core.priority_queue);
    if let Err(error) = core.play_queue_index(start) {
        core.queue = previous_queue;
        core.priority_queue = previous_priority_queue;
        return Err(error);
    }
    if core.shuffle {
        core.shuffle_upcoming();
    }
    Ok(())
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_queue_remove(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.queue_remove(index)
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_set_autoplay(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?
        .autoplay = enabled;
    Ok(())
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_toggle(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    let playing = !core.is_playing;
    core.set_playing(playing)
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_set_playing(is_playing: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    core.set_playing(is_playing)
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_next(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if core.queue.is_empty() {
        return Err("Add a music folder first.".to_owned());
    }
    core.play_next_available()
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
fn player_toggle_shuffle(state: State<'_, AppState>) -> Result<(), String> {
    let mut core = state
        .0
        .lock()
        .map_err(|_| "The player is unavailable.".to_owned())?;
    if !core.shuffle {
        core.shuffle_upcoming();
    }
    core.shuffle = !core.shuffle;
    Ok(())
}

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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

#[cfg_attr(target_os = "android", tauri::command(async))]
#[cfg_attr(not(target_os = "android"), tauri::command)]
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
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.manage(DesktopMediaBridge(Mutex::new(None)));
    #[cfg(any(target_os = "android", target_os = "ios"))]
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
            watch_library: true,
            equalizer_enabled: Arc::new(AtomicBool::new(false)),
            ..PlayerCore::default()
        })))
        .manage(YoutubeDownloadState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MediaBridge(Mutex::new(None)))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("michoplay-media")
                .setup(|app, api| {
                    #[cfg(target_os = "android")]
                    {
                        let handle =
                            api.register_android_plugin("app.michoplay.desktop", "MediaPlugin")?;
                        app.state::<AppState>().0.lock()
                            .map_err(|_| "The player is unavailable.")?.android_media = Some(handle.clone());
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
            // Desktop keeps the user-visible config at ~/.michoplay. Android and iOS
            // must use their app-local data directories because their home path may
            // resolve to shared storage that the app cannot write under scoped storage.
            let storage_dir = {
                #[cfg(any(target_os = "android", target_os = "ios"))]
                {
                    app.path().app_local_data_dir()?.join(".michoplay")
                }
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                {
                    app.path().home_dir()?.join(".michoplay")
                }
            };
            fs::create_dir_all(&storage_dir)?;
            #[cfg(not(target_os = "android"))]
            {
                let downloads_path = storage_dir.join("downloads.json");
                let recovered = fs::read(&downloads_path).ok()
                    .and_then(|bytes| serde_json::from_slice::<Vec<YoutubeDownloadItem>>(&bytes).ok())
                    .unwrap_or_default();
                if let Ok(mut manager) = app.state::<YoutubeDownloadState>().0.lock() {
                    manager.storage_path = Some(downloads_path);
                    for mut item in recovered {
                        manager.next_id = manager.next_id.max(item.id.strip_prefix("youtube-")
                            .and_then(|id| id.parse::<u64>().ok()).unwrap_or(0));
                        if item.status == "downloading" {
                            item.status = "queued".to_owned();
                            item.phase = "queued".to_owned();
                            item.message = "Resuming interrupted download…".to_owned();
                        }
                        manager.tasks.push(YoutubeDownloadTask { item, process_id: None, in_flight: false });
                    }
                }
            }
            // Preserve saved roots and reusable cache data from the previous app-data location.
            let config_path = storage_dir.join("config.json");
            if let Ok(previous_dir) = app.path().app_local_data_dir() {
                let previous_storage = previous_dir.join(".michoplay");
                if previous_storage != storage_dir {
                    let previous_config = previous_storage.join("config.json");
                    if !config_path.exists() && previous_config.is_file() {
                        let _ = fs::copy(previous_config, &config_path);
                    }
                    let previous_index = previous_storage.join("library-index.json");
                    let library_index = storage_dir.join("library-index.json");
                    if !storage_dir.join("library.sqlite").exists()
                        && !library_index.exists()
                        && previous_index.is_file()
                    {
                        let _ = fs::copy(previous_index, library_index);
                    }
                    let previous_artwork = previous_storage.join("artwork");
                    if previous_artwork.is_dir() {
                        let _ =
                            copy_directory_missing(&previous_artwork, &storage_dir.join("artwork"));
                    }
                }
            }
            if let Ok(mut core) = app.state::<AppState>().0.lock() {
                core.storage_dir = storage_dir.clone();
                if let Ok(bytes) = fs::read(&config_path) {
                    if let Ok(config) = serde_json::from_slice::<LibraryConfig>(&bytes) {
                        if config.version == 1 {
                            core.roots = config.roots.into_iter().map(PathBuf::from).collect();
                            core.scan_workers = config
                                .scan_workers
                                .filter(|workers| (1..=8).contains(workers));
                            core.watch_library = config.watch_library;
                        }
                    }
                }
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                #[cfg(target_os = "windows")]
                let app_icon = tauri::image::Image::from_app_icon_resource(32)
                    .ok()
                    .or_else(|| app.default_window_icon().cloned());
                #[cfg(not(target_os = "windows"))]
                let app_icon = app.default_window_icon().cloned();
                if let (Some(window), Some(icon)) = (app.get_webview_window("main"), app_icon) {
                    let _ = window.set_icon(icon);
                }
                #[cfg(target_os = "windows")]
                let controls = app
                    .get_webview_window("main")
                    .and_then(|window| window.hwnd().ok())
                    .and_then(|hwnd| {
                        MediaControls::new(PlatformConfig {
                            dbus_name: "michoplay",
                            display_name: "MichoPlay",
                            hwnd: Some(hwnd.0 as *mut std::ffi::c_void),
                        })
                        .ok()
                    });
                #[cfg(not(target_os = "windows"))]
                let controls = MediaControls::new(PlatformConfig {
                    dbus_name: "michoplay",
                    display_name: "MichoPlay",
                    hwnd: None,
                })
                .ok();
                if let Some(mut controls) = controls {
                    let handle = app.handle().clone();
                    if controls
                        .attach(move |event| {
                            let action = match event {
                                souvlaki::MediaControlEvent::Play => "play".to_owned(),
                                souvlaki::MediaControlEvent::Pause
                                | souvlaki::MediaControlEvent::Stop => "pause".to_owned(),
                                souvlaki::MediaControlEvent::Toggle => "toggle".to_owned(),
                                souvlaki::MediaControlEvent::Next => "next".to_owned(),
                                souvlaki::MediaControlEvent::Previous => "previous".to_owned(),
                                souvlaki::MediaControlEvent::SetPosition(position) => {
                                    format!("seek:{}", position.0.as_millis())
                                }
                                souvlaki::MediaControlEvent::Seek(direction) => {
                                    let delta = match direction {
                                        souvlaki::SeekDirection::Forward => 10_000_i64,
                                        souvlaki::SeekDirection::Backward => -10_000_i64,
                                    };
                                    format!("seek-by:{delta}")
                                }
                                souvlaki::MediaControlEvent::SeekBy(direction, amount) => {
                                    let delta = match direction {
                                        souvlaki::SeekDirection::Forward => {
                                            amount.as_millis() as i64
                                        }
                                        souvlaki::SeekDirection::Backward => {
                                            -(amount.as_millis() as i64)
                                        }
                                    };
                                    format!("seek-by:{delta}")
                                }
                                souvlaki::MediaControlEvent::Raise => "raise".to_owned(),
                                _ => return,
                            };
                            if action == "raise" {
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            } else {
                                let _ = handle.emit("system-media-control", action);
                            }
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
                tauri::async_runtime::spawn_blocking::<_, ()>(move || {
                    let mut last_media_signature = None;
                    let mut last_media_update = std::time::Instant::now();
                    let mut favorite_ids = HashSet::new();
                    let mut last_favorite_refresh = std::time::Instant::now() - Duration::from_secs(2);
                    let mut retry_after = None;
                    loop {
                        std::thread::sleep(Duration::from_millis(250));
                        let plugin = handle.state::<MediaBridge>().0.lock().ok()
                            .and_then(|bridge| bridge.clone());
                        let Some(plugin) = plugin else { continue };
                        let actions = match plugin.run_mobile_plugin::<PendingMediaActions>("takePendingActions", ()) {
                            Ok(response) => response.actions,
                            Err(error) => {
                                eprintln!("Android media action delivery failed: {error}");
                                continue;
                            }
                        };
                        let received_action = !actions.is_empty();
                        for action in actions {
                            if let Some(request) = action.strip_prefix("favorite:") {
                                if let Some((generation, track_id)) = request.split_once(':') {
                                    if let (Ok(generation), Ok(track_id)) =
                                        (generation.parse::<u64>(), track_id.parse::<u64>())
                                    {
                                        let current = handle.state::<AppState>().0.lock().ok().map(|mut core| {
                                            (core.audio_focus_generation, core.snapshot().current_track_id)
                                        });
                                        if current == Some((generation, Some(track_id))) {
                                            match app_data::toggle_favorite(&handle, track_id) {
                                                Ok(ids) => { let _ = handle.emit("android-favorites-changed", ids); }
                                                Err(error) => eprintln!("Android favorite action failed: {error}"),
                                            }
                                        }
                                    }
                                }
                                continue;
                            }
                            if let Ok(mut core) = handle.state::<AppState>().0.lock() {
                                if let Err(error) = apply_android_media_action(&mut core, &action) {
                                    eprintln!("Android media action {action} failed: {error}");
                                }
                            }
                        }
                        if received_action || last_favorite_refresh.elapsed() >= Duration::from_secs(2) {
                            if let Ok(ids) = app_data::favorite_ids(&handle) {
                                favorite_ids = ids.into_iter().collect();
                                last_favorite_refresh = std::time::Instant::now();
                            }
                        }
                        let (revision, media) = {
                            let state = handle.state::<AppState>();
                            let Ok(mut core) = state.0.lock() else { continue };
                            let snapshot = core.snapshot();
                            let media = snapshot.current_track_id.and_then(|id| {
                                core.track_indices.get(&id).and_then(|index| core.tracks.get(*index))
                                    .map(|track| {
                                        let artwork = track.track.artwork_key.as_ref()
                                            .zip(track.artwork.as_ref())
                                            .map(|(key, art)| (artwork_cache_path(&core.storage_dir, key, &art.mime), art.clone()));
                                        let payload = serde_json::json!({
                                            "title": track.track.title,
                                            "artist": track.track.artist,
                                            "trackId": id,
                                            "isFavorite": favorite_ids.contains(&id),
                                            "isPlaying": snapshot.is_playing,
                                            "interrupted": core.resume_after_interruption,
                                            "focusGeneration": core.audio_focus_generation,
                                            "durationMs": snapshot.duration_ms,
                                            "positionMs": snapshot.position_ms,
                                            "artworkPath": artwork.as_ref().map(|(path, _)| path.to_string_lossy()),
                                        });
                                        (payload, artwork)
                                    })
                            });
                            (core.android_media_revision(), media)
                        };
                        let mut signature = media.as_ref().map(|(payload, _)| payload.clone())
                            .unwrap_or(serde_json::Value::Null);
                        // Publish position corrections without sending updates on every audio tick.
                        if let Some(position) = signature.get_mut("positionMs") {
                            *position = serde_json::json!(position.as_u64().unwrap_or(0) / 2000);
                        }
                        let changed = last_media_signature.as_ref() != Some(&signature);
                        if changed || received_action {
                            let _ = handle.emit("android-player-state", ());
                        }
                        if retry_after.is_some_and(|deadline| std::time::Instant::now() < deadline) {
                            continue;
                        }
                        if changed || received_action || last_media_update.elapsed() >= Duration::from_secs(5) {
                            // Materialize missing artwork before locking the player for delivery.
                            if let Some((_, Some((path, art)))) = &media {
                                if !path.is_file() {
                                    let saved = path.parent().map(fs::create_dir_all)
                                        .transpose().and_then(|_| fs::write(path, &art.data));
                                    if let Err(error) = saved {
                                        eprintln!("Android notification artwork cache failed: {error}");
                                    }
                                }
                            }
                            let state = handle.state::<AppState>();
                            let Ok(core) = state.0.lock() else { continue };
                            if core.android_media_revision() != revision { continue; }
                            // Serialize delivery with engine changes. Android commands that
                            // acquire this lock run off the main thread, leaving the service free
                            // to acknowledge updates without a main-thread/engine-lock deadlock.
                            let result = if let Some((payload, _)) = media {
                                plugin.run_mobile_plugin::<()>("update", payload)
                            } else {
                                plugin.run_mobile_plugin::<()>("stop", ())
                            };
                            drop(core);
                            match result {
                                Ok(()) => {
                                    last_media_signature = Some(signature);
                                    last_media_update = std::time::Instant::now();
                                    retry_after = None;
                                }
                                Err(error) => {
                                    // Keep the old signature so delivery is retried, not marked successful.
                                    eprintln!("Android media state update failed: {error}");
                                    retry_after = Some(std::time::Instant::now() + Duration::from_secs(1));
                                }
                            }
                        }
                    }
                });
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let _ = app;
            #[cfg(not(target_os = "android"))]
            start_youtube_download_workers(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_import_audio_files,
            library_import_and_play_audio_files,
            library_import_directory,
            library_pick_music_folder,
            library_discover_music_folders,
            library_pick_audio_files,
            media_share_text,
            youtube_music_directory,
            youtube_search,
            youtube_downloads_state,
            youtube_download_enqueue,
            youtube_download_pause,
            youtube_download_resume,
            youtube_download_cancel,
            youtube_download_remove,
            library_scan_folder,
            lyrics_read,
            embed_downloaded_lyrics,
            library_cancel_scan,
            library_refresh,
            library_saved_roots,
            app_data_load,
            app_data_migrate,
            app_data_save,
            library_cached_tracks,
            library_update_track_metadata,
            library_delete_track,
            library_remove_folder,
            library_artwork,
            take_pending_audio_opens,
            library_open_audio_files,
            system_set_default_player,
            media_take_opened_audio,
            media_take_pending_actions,
            player_play_collection,
            player_queue_move,
            player_queue_remove,
            player_play_track,
            player_queue_add,
            player_set_autoplay,
            player_set_sleep_timer,
            player_toggle,
            player_set_playing,
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

    #[test]
    fn downloaded_lyrics_are_embedded_and_read_from_mp3() {
        let root = std::env::temp_dir().join(format!(
            "michoplay-lyrics-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let audio = root.join("song.mp3");
        let sidecar = root.join("song.en.lrc");
        let lyrics = "[00:01.20]First line\n[00:03.40]Second line\n";
        fs::write(&audio, include_bytes!("../fixtures/silence.mp3")).unwrap();
        fs::write(&sidecar, lyrics).unwrap();

        attach_downloaded_lyrics(&audio);
        assert!(!sidecar.exists());
        assert!(track_has_lyrics(&audio));
        assert_eq!(embedded_lyrics(&audio).as_deref(), Some(lyrics));

        let pending = pending_lyrics_path(&audio);
        fs::write(&pending, "[00:05.00]Updated line\n").unwrap();
        assert_eq!(
            embed_downloaded_lyrics(vec![audio.to_string_lossy().into_owned()]),
            vec![audio.to_string_lossy().into_owned()]
        );
        assert!(!pending.exists());
        assert_eq!(
            embedded_lyrics(&audio).as_deref(),
            Some("[00:05.00]Updated line\n")
        );

        let vtt_audio = root.join("captions.mp3");
        let vtt_sidecar = root.join("captions.en.vtt");
        fs::write(&vtt_audio, include_bytes!("../fixtures/silence.mp3")).unwrap();
        fs::write(&vtt_sidecar, "WEBVTT\n\n00:00:01.042 --> 00:00:04.045\n<c>First &amp; second</c>\nline\n\n00:00:07.257 --> 00:00:12.846\nNext line\n").unwrap();
        attach_downloaded_lyrics(&vtt_audio);
        assert!(!vtt_sidecar.exists());
        assert_eq!(
            embedded_lyrics(&vtt_audio).as_deref(),
            Some("[00:01.04]First & second line\n[00:07.25]Next line\n")
        );

        let invalid_audio = root.join("invalid.mp3");
        let retained_sidecar = root.join("invalid.en.lrc");
        fs::write(&invalid_audio, b"not an MP3").unwrap();
        fs::write(&retained_sidecar, lyrics).unwrap();
        attach_downloaded_lyrics(&invalid_audio);
        assert!(retained_sidecar.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn youtube_download_paths_preserve_escaped_unicode_and_windows_separators() {
        let reports = [
            (
                r#"__MICHOPLAY_FILE__"C:\\Users\\Ren\u00e9\\Music\\YouTube\\Comfort \ud83c\udfb5.mp3""#,
                "C:\\Users\\René\\Music\\YouTube\\Comfort 🎵.mp3",
            ),
            (
                r#"__MICHOPLAY_FILE__"/music/100% \"Comfort\"\nVisualizer.mp3""#,
                "/music/100% \"Comfort\"\nVisualizer.mp3",
            ),
        ];
        for (line, expected) in reports {
            assert_eq!(
                youtube_download_file_path(line).unwrap(),
                Some(PathBuf::from(expected))
            );
        }
        assert_eq!(
            youtube_download_file_path("[download] 100% of 2.4MiB").unwrap(),
            None
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn youtube_download_paths_reject_malformed_or_empty_reports() {
        for report in ["", "null", "[]", "\"\"", "\"unterminated", "plain-path.mp3"] {
            assert!(youtube_download_file_path(&format!("__MICHOPLAY_FILE__{report}")).is_err());
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn youtube_download_verification_finds_the_original_unicode_file() {
        let root = std::env::temp_dir().join(format!(
            "michoplay-download-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let actual = root.join("Café 🎵 100% (Visualizer).MP3");
        // The path handoff must preserve Unicode even if validation rejects bad audio.
        std::fs::write(&actual, b"audio fixture").unwrap();
        let json = serde_json::to_string(&actual.to_string_lossy())
            .unwrap()
            .replace('é', "\\u00e9")
            .replace('🎵', "\\ud83c\\udfb5");
        let reported = youtube_download_file_path(&format!("__MICHOPLAY_FILE__{json}"))
            .unwrap()
            .unwrap();
        assert_eq!(reported, actual);
        assert_eq!(
            youtube_download_file_size(&reported).unwrap_err(),
            "The downloaded audio couldn't be read. Try downloading it again."
        );

        // The old plain-text protocol could silently lose these characters.
        assert!(youtube_download_file_size(&root.join("Caf  100% (Visualizer).mp3")).is_err());
        let missing = root.join("missing.mp3");
        assert_eq!(
            youtube_download_file_size(&missing).unwrap_err(),
            "The downloaded song is missing from Music/MichoPlay. Try downloading it again."
        );
        let empty = root.join("empty.mp3");
        std::fs::write(&empty, []).unwrap();
        assert_eq!(
            youtube_download_file_size(&empty).unwrap_err(),
            "The downloaded song is empty. Try downloading it again."
        );
        let unfinished = root.join("unfinished.webm");
        std::fs::write(&unfinished, b"not yet converted").unwrap();
        assert_eq!(
            youtube_download_file_size(&unfinished).unwrap_err(),
            "The saved download isn't an MP3 file. Try downloading it again."
        );
        let directory = root.join("folder.mp3");
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(
            youtube_download_file_size(&directory).unwrap_err(),
            "The saved download isn't a song file. Try downloading it again."
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn youtube_download_file_errors_distinguish_access_failures() {
        use std::io::ErrorKind;

        for (kind, expected) in [
            (
                ErrorKind::NotFound,
                "The downloaded song is missing from Music/MichoPlay. Try downloading it again.",
            ),
            (
                ErrorKind::PermissionDenied,
                "MichoPlay doesn't have permission to read the downloaded song. Allow access to your Music folder and try again.",
            ),
            (
                ErrorKind::TimedOut,
                "Your Music folder took too long to respond. Check that the drive is connected and try again.",
            ),
        ] {
            let error = std::io::Error::new(kind, "private technical details");
            assert_eq!(youtube_download_file_error(error), expected);
        }
    }

    fn library() -> PlayerCore {
        let tracks = (1..=4)
            .map(|id| LibraryTrack {
                track: Track {
                    id,
                    path: format!("/music/{id}.wav"),
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
                    has_lyrics: false,
                },
                path: PathBuf::from(format!("/music/{id}.wav")),
                artwork: None,
            })
            .collect();
        PlayerCore {
            tracks,
            track_indices: (1..=4).enumerate().map(|(index, id)| (id, index)).collect(),
            queue: vec![1, 2, 3, 4],
            current_queue_index: Some(0),
            ..PlayerCore::default()
        }
    }

    fn playing_without_audio_device() -> (PlayerCore, rodio::queue::SourcesQueueOutput) {
        let mut core = library();
        let (sink, output) = Sink::new();
        sink.append(rodio::source::SineWave::new(440.0).take_duration(Duration::from_secs(10)));
        sink.play();
        core.sink = Some(sink);
        core.is_playing = true;
        core.audio_focus_generation = 7;
        (core, output)
    }

    #[test]
    fn interruption_transient_pauses_and_resumes_the_same_song() {
        let (mut core, _output) = playing_without_audio_device();
        let queue = core.queue.clone();
        apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
        assert!(!core.is_playing);
        assert!(core.sink.as_ref().unwrap().is_paused());
        assert!(core.resume_after_interruption);
        // A second late snapshot of the interruption must preserve resume intent.
        apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
        assert!(core.resume_after_interruption);
        apply_android_media_action(&mut core, "focus-gain:7").unwrap();
        assert!(core.is_playing);
        assert!(!core.sink.as_ref().unwrap().is_paused());
        assert!(!core.resume_after_interruption);
        assert_eq!(core.queue, queue);
        assert_eq!(core.current_queue_index, Some(0));
    }

    #[test]
    fn interruption_manual_pause_cancels_automatic_resume() {
        let (mut core, _output) = playing_without_audio_device();
        apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
        core.set_playing(false).unwrap();
        apply_android_media_action(&mut core, "focus-gain:7").unwrap();
        assert!(!core.is_playing);
        assert!(core.sink.as_ref().unwrap().is_paused());
        assert!(!core.resume_after_interruption);
    }

    #[test]
    fn interruption_permanent_loss_and_disconnection_require_manual_play() {
        for event in ["focus-loss:7", "becoming-noisy:7", "service-stopped:7"] {
            let (mut core, _output) = playing_without_audio_device();
            apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
            apply_android_media_action(&mut core, event).unwrap();
            apply_android_media_action(&mut core, "focus-gain:7").unwrap();
            assert!(!core.is_playing, "Unexpected resume after {event}");
            assert!(core.sink.as_ref().unwrap().is_paused());
            assert!(!core.resume_after_interruption);
        }
    }

    #[test]
    fn interruption_events_from_old_focus_do_not_pause_new_playback() {
        let (mut core, _output) = playing_without_audio_device();
        for event in [
            "focus-loss:6",
            "focus-loss-transient:6",
            "becoming-noisy:6",
            "service-stopped:6",
        ] {
            apply_android_media_action(&mut core, event).unwrap();
            assert!(core.is_playing);
            assert!(!core.sink.as_ref().unwrap().is_paused());
        }
        apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
        apply_android_media_action(&mut core, "focus-gain:6").unwrap();
        assert!(!core.is_playing);
        assert!(core.resume_after_interruption);
    }

    #[test]
    fn interruption_sleep_timer_cancels_automatic_resume() {
        let (mut core, _output) = playing_without_audio_device();
        apply_android_media_action(&mut core, "focus-loss-transient:7").unwrap();
        core.sleep_timer_deadline = Some(SystemTime::now() - Duration::from_secs(1));
        assert!(!core.snapshot().is_playing);
        apply_android_media_action(&mut core, "focus-gain:7").unwrap();
        assert!(!core.is_playing);
        assert!(!core.resume_after_interruption);
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
        let cache = root.with_extension("michoplay-cache");
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
        let first = scan_roots(&[root.clone(), root.join("unavailable")], &cache).unwrap();
        let second = scan_roots(&[root.clone(), leaf.clone()], &cache).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].track.title, "Silent");
        assert_eq!(first[0].track.folders.len(), 3);
        assert_eq!(first[0].track.folder_name, "Album");
        assert!(first[0].track.id < (1u64 << 53));
        assert_eq!(first[0].track.id, second[0].track.id);
        assert_eq!(first[0].artwork.as_ref().unwrap().data, png);
        assert!(first[0].track.artwork_key.is_some());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(cache).unwrap();
    }
}
