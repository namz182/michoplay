import { invoke } from "@tauri-apps/api/core";

export type Folder = { path: string; name: string };
export type Track = {
  id: number; title: string; artist: string; album: string; releaseDate: string; addedAt: number; durationMs: number;
  folderPath: string; folderName: string; rootPath: string; folders: Folder[]; artworkKey: string | null;
};
export type PlayerSnapshot = {
  currentTrackId: number | null; isPlaying: boolean; positionMs: number; durationMs: number;
  volume: number; shuffle: boolean; repeatMode: "off" | "all" | "one";
  queue: number[]; priorityQueue: number[]; autoplay: boolean;
  sleepTimerRemainingMs: number | null; sleepTimerAtTrackEnd: boolean;
  equalizerBands: number[]; equalizerEnabled: boolean;
};
export type YoutubeSearchResult = { id: string; title: string; url: string; thumbnail: string | null; durationSeconds: number | null; isPlaylist: boolean };
export type YoutubeDownload = { id: string; title: string; url: string; thumbnail: string | null; isPlaylist: boolean; status: "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled"; percent: number | null; downloadedBytes: number | null; totalBytes: number | null; message: string };
export const api = {
  scanFolder: (folder: string) => invoke<Track[]>("library_scan_folder", { folder }),
  cancelScan: () => invoke<void>("library_cancel_scan"),
  openAudioFiles: (paths: string[]) => invoke<Track[]>("library_open_audio_files", { paths, play: true }),
  addAudioFiles: (paths: string[]) => invoke<Track[]>("library_open_audio_files", { paths, play: false }),
  takePendingAudioOpens: () => invoke<string[]>("take_pending_audio_opens"),
  takeOpenedAudio: () => invoke<string[]>("media_take_opened_audio"),
  setDefaultPlayer: () => invoke<void>("system_set_default_player"),
  importFiles: (files: { name: string; dataBase64: string }[]) => invoke<string>("library_import_audio_files", { files }),
  importAndPlayFiles: (files: { name: string; dataBase64: string }[]) => invoke<Track[]>("library_import_and_play_audio_files", { files }),
  importDirectory: () => invoke<string>("library_import_directory"),
  discoverMusicFolders: () => invoke<string[]>("library_discover_music_folders"),
  pickAudioFiles: () => invoke<string[]>("library_pick_audio_files"),
  shareText: (title: string, text: string, url: string) => invoke<void>("media_share_text", { title, text, url }),
  youtubeMusicDirectory: () => invoke<string>("youtube_music_directory"),
  pickMusicFolder: () => invoke<{ path: string; count: number; name: string }>("library_pick_music_folder"),
  youtubeSearch: (query: string, limit = 15, offset = 0) => invoke<YoutubeSearchResult[]>("youtube_search", { query, limit, offset }),
  youtubeDownloadsState: () => invoke<YoutubeDownload[]>("youtube_downloads_state"),
  youtubeDownloadEnqueue: (url: string, title: string, thumbnail: string | null, isPlaylist: boolean) => invoke<YoutubeDownload>("youtube_download_enqueue", { url, title, thumbnail, isPlaylist }),
  youtubeDownloadPause: (id: string) => invoke<void>("youtube_download_pause", { id }),
  youtubeDownloadResume: (id: string) => invoke<void>("youtube_download_resume", { id }),
  youtubeDownloadCancel: (id: string) => invoke<void>("youtube_download_cancel", { id }),
  youtubeDownloadRemove: (id: string) => invoke<void>("youtube_download_remove", { id }),
  mediaUpdate: (track: { title: string; artist: string } | null, isPlaying: boolean, durationMs: number, positionMs: number, artworkDataUrl?: string | null) => invoke<void>("media_update", {
    title: track?.title ?? null,
    artist: track?.artist ?? null,
    isPlaying,
    durationMs,
    positionMs,
    artworkDataUrl: artworkDataUrl ?? null,
  }),
  mediaStop: () => invoke<void>("media_stop"),
  mediaTakePendingActions: () => invoke<string[]>("media_take_pending_actions"),
  refresh: (folders: string[]) => invoke<Track[]>("library_refresh", { folders }),
  librarySavedRoots: () => invoke<string[]>("library_saved_roots"),
  cachedTracks: () => invoke<Track[]>("library_cached_tracks"),
  removeFolder: (folder: string) => invoke<Track[]>("library_remove_folder", { folder }),
  artwork: (artworkKey: string) => invoke<string | null>("library_artwork", { artworkKey }),
  state: () => invoke<PlayerSnapshot>("player_state"),
  play: (trackId: number) => invoke<void>("player_play_track", { trackId }),
  playCollection: (trackIds: number[], startId: number) => invoke<void>("player_play_collection", { trackIds, startId }),
  toggle: () => invoke<void>("player_toggle"),
  setPlaying: (isPlaying: boolean) => invoke<void>("player_set_playing", { isPlaying }),
  previous: () => invoke<void>("player_previous"),
  next: () => invoke<void>("player_next"),
  shuffle: () => invoke<void>("player_toggle_shuffle"),
  repeat: () => invoke<void>("player_toggle_repeat"),
  seek: (positionMs: number) => invoke<void>("player_seek", { positionMs }),
  volume: (volume: number) => invoke<void>("player_set_volume", { volume }),
  equalizer: (bands: number[], enabled: boolean) => invoke<void>("player_set_equalizer_bands", { bands, enabled }),
  autoplay: (enabled: boolean) => invoke<void>("player_set_autoplay", { enabled }),
  sleepTimer: (durationMinutes: number | null, atTrackEnd: boolean) => invoke<void>("player_set_sleep_timer", { durationMinutes, atTrackEnd }),
  queueAdd: (trackId: number) => invoke<void>("player_queue_add", { trackId }),
  queueMove: (fromIndex: number, toIndex: number) => invoke<void>("player_queue_move", { fromIndex, toIndex }),
  queueRemove: (index: number) => invoke<void>("player_queue_remove", { index }),
};
