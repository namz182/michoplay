import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  AudioLines, Disc3, Heart, Home, ListMusic, Music2, Play, Plus, Search, Shuffle,
  SkipBack, SkipForward, Volume2, VolumeX, Settings2, MoreHorizontal, FolderOpen, Pause,
  Trash2, X, PanelRightClose, PanelRightOpen, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, GripVertical, RefreshCw, Pencil, Clock3, Youtube,
  ListFilter, List, AlignJustify, Check, Library, Timer, Share2, Download,
  Maximize2, Minimize2,
} from "lucide-react";
import { api } from "../lib/api";
import type { PlayerSnapshot, Track, YoutubeDownload, YoutubeSearchResult } from "../lib/api";
import { Cover, useArtwork } from "./Artwork";
import packageInfo from "../../package.json";

type Section = "Home" | "Songs" | "Albums" | "Artists" | "Playlists" | "Favorites" | "Recently Played" | "Settings";
type Detail = { kind: "folder" | "album" | "artist" | "playlist"; key: string; title: string };
type Page = { section: Section; detail?: Detail };
type Playlist = { id: string; name: string; trackIds: number[] };
type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type TrackMenu = { track: Track; x: number; y: number };
type ListeningRecord = { trackId: number; lastPlayedAt: number; playCount: number; positionMs: number; durationMs: number };
type GlobalSearchResult = { type: "Song" | "Folder" | "Album" | "Artist" | "Playlist"; title: string; subtitle: string; artworkKey: string | null; trackId?: number; page?: Page };
type TrackSort = "custom" | "title" | "artist" | "album" | "recentlyAdded" | "releaseDate" | "duration";
const trackSortOptions: { key: TrackSort; label: string }[] = [
  { key: "custom", label: "Custom order" }, { key: "title", label: "Title" }, { key: "artist", label: "Artist" },
  { key: "album", label: "Album" }, { key: "recentlyAdded", label: "Recently added" },
  { key: "releaseDate", label: "Release date" }, { key: "duration", label: "Duration" },
];
const keyboardShortcuts: { action: string; keys: string[] }[] = [
  { action: "Play or pause", keys: ["Space"] },
  { action: "Seek back or forward 5 seconds", keys: ["←", "→"] },
  { action: "Previous or next song", keys: ["Ctrl / ⌘", "← / →"] },
  { action: "Toggle shuffle", keys: ["Ctrl / ⌘", "Shift", "S"] },
  { action: "Change repeat mode", keys: ["Ctrl / ⌘", "R"] },
  { action: "Focus music search", keys: ["Ctrl / ⌘", "K"] },
  { action: "Zoom out, in, or reset", keys: ["Ctrl / ⌘", "− / + / 0"] },
];
const navigation: { label: Section; icon: typeof Home }[] = [
  { label: "Home", icon: Home }, { label: "Songs", icon: Music2 },
  { label: "Playlists", icon: ListMusic }, { label: "Favorites", icon: Heart },
];
const initialPlayer: PlayerSnapshot = { currentTrackId: null, isPlaying: false, positionMs: 0, durationMs: 0, volume: 0.75, shuffle: false, repeatMode: "off", queue: [], priorityQueue: [], autoplay: true, sleepTimerRemainingMs: null, sleepTimerAtTrackEnd: false, equalizerBands: Array(6).fill(0), equalizerEnabled: true };
const equalizerFrequencies = ["60Hz", "150Hz", "400Hz", "1KHz", "2.4KHz", "15KHz"];
function stored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`michoplay-${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
function time(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function sleepTimerLabel(ms: number) { const seconds = Math.ceil(Math.max(0, ms) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`; }
function durationLabel(seconds: number) { const safeSeconds = Math.max(0, Math.floor(seconds)); return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`; }
function youtubePreviewUrl(result: YoutubeSearchResult) {
  const parsed = new URL(result.url);
  const playlist = parsed.searchParams.get("list");
  return playlist
    ? `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(playlist)}`
    : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(result.id)}?autoplay=1&rel=0`;
}
function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
function youtubeResultSize(result: YoutubeSearchResult) {
  if (result.isPlaylist) return "Size varies";
  if (result.durationSeconds === null) return "Size unavailable";
  return `~${formatFileSize(Math.round(result.durationSeconds * 16_000))} est.`;
}
function normalizeZoom(value: number) { return Math.max(70, Math.min(130, Math.round(value / 10) * 10)); }
function SleepTimerControl({ player, onSet, placement }: { player: PlayerSnapshot; onSet: (minutes: number | null, atTrackEnd: boolean) => void; placement: "bar" | "full-mode" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = player.sleepTimerAtTrackEnd || player.sleepTimerRemainingMs !== null;
  const currentMinutes = player.sleepTimerRemainingMs === null ? null : Math.ceil(player.sleepTimerRemainingMs / 900_000) * 15;
  const label = player.sleepTimerAtTrackEnd ? "Track end" : player.sleepTimerRemainingMs !== null ? sleepTimerLabel(player.sleepTimerRemainingMs) : "Sleep";
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);
  useEffect(() => { if (placement === "bar" && player.sleepTimerRemainingMs === null) setOpen(false); }, [placement, player.sleepTimerRemainingMs]);
  if (placement === "bar" && player.sleepTimerRemainingMs === null) return null;
  const choose = (minutes: number | null, atTrackEnd = false) => { onSet(minutes, atTrackEnd); setOpen(false); };
  return <div className={`sleep-timer-control ${placement}`} ref={root}>
    <button className={`sleep-timer-trigger ${active ? "active" : ""}`} aria-label={active ? `Sleep timer: ${label}` : "Set sleep timer"} aria-haspopup="menu" aria-expanded={open} title={active ? `Sleep timer: ${label}` : "Set sleep timer"} onClick={() => setOpen((value) => !value)}><Timer size={15}/><span>{label}</span></button>
    {open && <div className="sleep-timer-menu" role="menu" aria-label="Sleep timer options"><strong>{active ? `Sleep in ${label}` : "Stop playback"}</strong><button role="menuitemradio" aria-checked={!active} onClick={() => choose(null)}>Off</button>{[[15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"]].map(([minutes, text]) => <button key={minutes} role="menuitemradio" aria-checked={!player.sleepTimerAtTrackEnd && currentMinutes === minutes} onClick={() => choose(Number(minutes))}>{text}</button>)}<button role="menuitemradio" aria-checked={player.sleepTimerAtTrackEnd} disabled={!player.currentTrackId} onClick={() => choose(null, true)}>End of current song</button></div>}
  </div>;
}
function matches(track: Track, query: string) { return `${track.title} ${track.artist} ${track.album} ${track.folderName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); }
function albumKey(track: Track) { return `${track.album}\u0000${track.artist}`; }
const coverKeys = (tracks: Track[]) => tracks.map((track) => track.artworkKey);
function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const value = String(reader.result ?? ""); const comma = value.indexOf(","); resolve(comma < 0 ? value : value.slice(comma + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [history, setHistory] = useState({ entries: [{ section: "Home" } as Page], index: 0 });
  const page = history.entries[history.index];
  const [roots, setRoots] = useState<string[]>(() => stored("library-roots", []));
  const [tracks, setTracks] = useState<Track[]>([]);
  const [player, setPlayer] = useState<PlayerSnapshot>(initialPlayer);
  const lastAudibleVolume = useRef(Math.max(0.01, stored("volume", 0.75)));
  const [fullMode, setFullMode] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(packageInfo.version);
  const [fullPanelTab, setFullPanelTab] = useState<"queue" | "recent">("queue");
  const [keepScreenAwake, setKeepScreenAwake] = useState(() => stored("keep-screen-awake-in-full-mode", true));
  const [equalizerBands, setEqualizerBands] = useState<number[]>(() => {
    const saved = stored<number[]>("equalizer-bands", Array(6).fill(0));
    if (!Array.isArray(saved)) return Array(6).fill(0);
    const migrated = saved.length === 10 ? [saved[1], (saved[2] + saved[3]) / 2, saved[4], saved[5], (saved[6] + saved[7]) / 2, saved[9]] : saved;
    return migrated.length === 6 ? migrated.map((value) => Math.max(-12, Math.min(12, Number(value) || 0))) : Array(6).fill(0);
  });
  const [equalizerEnabled, setEqualizerEnabled] = useState(() => stored("equalizer-enabled", true));
  const [favorites, setFavorites] = useState<number[]>(() => stored("favorites", []));
  const [playlists, setPlaylists] = useState<Playlist[]>(() => stored("playlists", []));
  const [listeningHistory, setListeningHistory] = useState<ListeningRecord[]>(() => stored("listening-history", []));
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    const saved = stored<unknown>("recent-searches", []);
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string").slice(0, 8) : [];
  });
  const [inlineSearch, setInlineSearch] = useState("");
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [menu, setMenu] = useState<TrackMenu | null>(null);
  const [playlistSubmenu, setPlaylistSubmenu] = useState(false);
  const [playlistSearch, setPlaylistSearch] = useState("");
  const [appMenu, setAppMenu] = useState(false);
  const [dialog, setDialog] = useState<{ target?: Track; playlist?: Playlist } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; label: string; confirm: () => void } | null>(null);
  const [playlistName, setPlaylistName] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(184, Math.min(360, stored<number>("sidebar-width", 248))));
  const [panelWidth, setPanelWidth] = useState(() => Math.max(250, Math.min(460, stored<number>("panel-width", 320))));
  const [showPanel, setShowPanel] = useState(() => stored("show-now-playing", true));
  const [panelView, setPanelView] = useState<"now-playing" | "downloads">("now-playing");
  const [compact, setCompact] = useState(() => stored("compact", false));
  const [sortBy, setSortBy] = useState<TrackSort>(() => {
    const saved = stored<string>("collection-sort", "custom");
    return trackSortOptions.some((option) => option.key === saved) ? saved as TrackSort : "custom";
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"home" | "search" | "library">("home");
  const [mobileHomeFilter, setMobileHomeFilter] = useState<"All" | "Folders" | "Albums">("All");
  const [mobileLibraryFilter, setMobileLibraryFilter] = useState<"All" | "Playlists" | "Folders" | "Albums" | "Artists" | "Songs">("All");
  const [sidebarLibrarySearch, setSidebarLibrarySearch] = useState("");
  const [sidebarLibrarySort, setSidebarLibrarySort] = useState<"recent" | "az">("recent");
  const [mobilePlayerOpen, setMobilePlayerOpen] = useState(false);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const [mobileQueueEditing, setMobileQueueEditing] = useState(false);
  const [youtubeDirectory, setYoutubeDirectory] = useState("");
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeSearching, setYoutubeSearching] = useState(false);
  const [youtubeSearchError, setYoutubeSearchError] = useState("");
  const [youtubeResults, setYoutubeResults] = useState<YoutubeSearchResult[]>([]);
  const [youtubePreview, setYoutubePreview] = useState<YoutubeSearchResult | null>(null);
  const [youtubeDownloads, setYoutubeDownloads] = useState<YoutubeDownload[]>([]);
  const [zoomLevel, setZoomLevel] = useState(() => normalizeZoom(stored<number>("zoom-level", 100)));
  const [draggedQueue, setDraggedQueue] = useState<number | null>(null);
  const [queueDrop, setQueueDrop] = useState<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const lastStartedTrack = useRef<number | null>(null);
  const youtubeSearchVersion = useRef(0);
  const youtubeSearchCache = useRef(new Map<string, { results: YoutubeSearchResult[]; savedAt: number }>());
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const completedYoutubeDownloads = useRef(new Set<string>());
  const isAndroid = useMemo(() => /android/i.test(navigator.userAgent), []);
  const selectedPlaylist = page.detail?.kind === "playlist" ? playlists.find((item) => item.id === page.detail?.key) : undefined;
  const youtubePlaylist = playlists.find((item) => item.name.trim().toLocaleLowerCase() === "youtube");
  const isYoutubePlaylist = !isAndroid && selectedPlaylist?.name.trim().toLocaleLowerCase() === "youtube";

  const navigate = useCallback((next: Page) => {
    setHistory((prior) => ({ entries: [...prior.entries.slice(0, prior.index + 1), next], index: prior.index + 1 }));
    setInlineSearch(""); setMenu(null); setAppMenu(false); setSortMenuOpen(false); setSearchOpen(false);
  }, []);
  function travel(delta: number) {
    setHistory((prior) => ({ ...prior, index: Math.max(0, Math.min(prior.entries.length - 1, prior.index + delta)) }));
    setInlineSearch(""); setMenu(null); setAppMenu(false); setSortMenuOpen(false); setSearchOpen(false);
  }
  const run = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); setPlayer(await api.state()); setMessage(""); }
    catch (error) { setMessage(String(error)); }
  }, []);
  useEffect(() => { if (player.volume > 0) lastAudibleVolume.current = player.volume; }, [player.volume]);
  function setVolume(volume: number) {
    localStorage.setItem("michoplay-volume", JSON.stringify(volume));
    void run(() => api.volume(volume));
  }
  function toggleMute() {
    const volume = player.volume > 0 ? 0 : lastAudibleVolume.current;
    setVolume(volume);
  }
  async function commitSeek(positionMs: number) {
    const target = Math.max(0, Math.min(player.durationMs, positionMs));
    setSeekPreviewMs(target);
    try {
      await api.seek(target);
      setPlayer(await api.state());
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSeekPreviewMs(null);
    }
  }
  function toggleFullMode() {
    if (fullMode) {
      setFullMode(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      return;
    }
    setFullMode(true);
    if (document.documentElement.requestFullscreen) void document.documentElement.requestFullscreen().catch(() => {});
  }
  const refresh = useCallback(async (folders: string[] = roots) => {
    if (!isTauri()) { setMessage("Open the desktop app to load local music."); return; }
    setScanning(true); setMessage("");
    try { setTracks(await api.refresh(folders)); setPlayer(await api.state()); }
    catch (error) { setMessage(String(error)); }
    finally { setScanning(false); }
  }, [roots]);
  const syncYoutubeLibrary = useCallback(async () => {
    if (!isTauri() || !youtubeDirectory) return;
    const nextRoots = [...new Set([...roots, youtubeDirectory])];
    const knownIds = new Set(tracks.filter((track) => track.rootPath === youtubeDirectory).map((track) => track.id));
    setScanning(true);
    try {
      const scanned = await api.refresh(nextRoots);
      setRoots(nextRoots); setTracks(scanned); setPlayer(await api.state());
      const newIds = scanned.filter((track) => track.rootPath === youtubeDirectory && !knownIds.has(track.id)).map((track) => track.id);
      if (newIds.length) setPlaylists((prior) => {
        const existing = prior.find((item) => item.name.trim().toLocaleLowerCase() === "youtube");
        if (!existing) return [{ id: "michoplay-youtube", name: "YouTube", trackIds: newIds }, ...prior];
        return prior.map((item) => item.id === existing.id
          ? { ...item, trackIds: [...item.trackIds, ...newIds.filter((id) => !item.trackIds.includes(id))] }
          : item);
      });
      if (newIds.length) setMessage(`Saved ${newIds.length} ${newIds.length === 1 ? "song" : "songs"} to Music/YouTube`);
    } catch (error) { setMessage(String(error)); }
    finally { setScanning(false); }
  }, [youtubeDirectory, roots, tracks]);
  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    if (isAndroid) void refresh(roots);
    void api.volume(stored("volume", 0.75));
    void api.autoplay(stored("autoplay", true));
    void api.equalizer(equalizerBands, equalizerEnabled);
    // Restore library and playback preferences once on launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!isTauri() || isAndroid) return;
    let active = true;
    void api.youtubeMusicDirectory().then(async (directory) => {
      if (!active) return;
      setYoutubeDirectory(directory);
      const nextRoots = [...new Set([...roots, directory])];
      setRoots(nextRoots);
      setPlaylists((prior) => prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube")
        ? prior
        : [{ id: "michoplay-youtube", name: "YouTube", trackIds: [] }, ...prior]);
      try {
        const scanned = await api.refresh(nextRoots);
        if (!active) return;
        setTracks(scanned);
        setPlayer(await api.state());
      } catch (error) {
        if (active) setMessage(String(error));
      }
    }).catch((error) => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, [isAndroid]);
  useEffect(() => {
    if (!isTauri() || isAndroid) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void api.youtubeDownloadsState().then((items) => {
      if (!active) return;
      setYoutubeDownloads(items);
      completedYoutubeDownloads.current = new Set(items.filter((item) => item.status === "completed").map((item) => item.id));
    }).catch(() => {});
    void listen<YoutubeDownload[]>("youtube-downloads-updated", ({ payload }) => {
      if (!active) return;
      setYoutubeDownloads(payload);
      const newlyCompleted = payload.some((item) => item.status === "completed" && !completedYoutubeDownloads.current.has(item.id));
      payload.filter((item) => item.status === "completed").forEach((item) => completedYoutubeDownloads.current.add(item.id));
      if (newlyCompleted) void syncYoutubeLibrary();
    }).then((dispose) => { unlisten = dispose; });
    return () => { active = false; unlisten?.(); };
  }, [isAndroid, syncYoutubeLibrary]);
  useEffect(() => {
    if (!isYoutubePlaylist) return;
    const query = youtubeQuery.trim();
    const version = ++youtubeSearchVersion.current;
    if (!query) {
      setYoutubeResults([]); setYoutubeSearchError(""); setYoutubeSearching(false);
      return;
    }
    const cached = youtubeSearchCache.current.get(query.toLocaleLowerCase());
    if (cached && Date.now() - cached.savedAt < 60_000) {
      setYoutubeResults(cached.results); setYoutubeSearchError(""); setYoutubeSearching(false);
      return;
    }
    setYoutubeSearching(true); setYoutubeSearchError(""); setYoutubeResults([]);
    const timer = window.setTimeout(() => {
      void api.youtubeSearch(query).then((results) => {
        if (youtubeSearchVersion.current !== version) return;
        setYoutubeResults(results);
        youtubeSearchCache.current.set(query.toLocaleLowerCase(), { results, savedAt: Date.now() });
      }).catch((error) => {
        if (youtubeSearchVersion.current === version) { setYoutubeResults([]); setYoutubeSearchError(String(error)); }
      }).finally(() => { if (youtubeSearchVersion.current === version) setYoutubeSearching(false); });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [youtubeQuery, isYoutubePlaylist]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const openDesktopFiles = async (paths: string[]) => {
      if (!paths.length || !active) return;
      setScanning(true); setMessage("");
      try {
        const scanned = await api.openAudioFiles(paths);
        if (!active) return;
        setTracks(scanned); setPlayer(await api.state());
        const folders = paths.map((path) => path.replace(/[\\/][^\\/]+$/, ""));
        setRoots((prior) => [...new Set([...prior, ...folders])]);
        setMessage("");
      } catch (error) { if (active) setMessage(String(error)); }
      finally { if (active) setScanning(false); }
    };
    const drainDesktopFiles = () => api.takePendingAudioOpens().then((paths) => openDesktopFiles(paths)).catch((error) => setMessage(String(error)));
    void listen("open-audio-files-ready", () => { void drainDesktopFiles(); }).then((stop) => {
      unlisten = stop;
      if (!isAndroid) void drainDesktopFiles();
      else void api.takeOpenedAudio().then((files) => { if (files.length && active) void importAudioPayloads(files, true); }).catch((error) => setMessage(String(error)));
    });
    return () => { active = false; unlisten?.(); };
    // The file-open bridge should only be installed once per app launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], button, a")) return;
      const key = event.key.toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      if (modified && !event.altKey && !event.shiftKey && key === "arrowleft") {
        event.preventDefault(); if (tracks.length) void run(api.previous);
      } else if (modified && !event.altKey && !event.shiftKey && key === "arrowright") {
        event.preventDefault(); if (tracks.length) void run(api.next);
      } else if (modified && !event.altKey && event.shiftKey && key === "s") {
        event.preventDefault(); if (tracks.length) void run(api.shuffle);
      } else if (modified && !event.altKey && !event.shiftKey && key === "r") {
        event.preventDefault(); if (tracks.length) void run(api.repeat);
      } else if (modified && !event.altKey && !event.shiftKey && key === "k") {
        event.preventDefault(); setSearchOpen(true); document.querySelector<HTMLInputElement>(".search-box input")?.focus();
      } else if (!modified && !event.altKey && !event.shiftKey && event.code === "Space") {
        event.preventDefault(); if (player.currentTrackId !== null) void run(api.toggle);
      } else if (!modified && !event.altKey && !event.shiftKey && (key === "arrowleft" || key === "arrowright")) {
        if (player.currentTrackId === null || !player.durationMs) return;
        event.preventDefault();
        const offset = key === "arrowleft" ? -5000 : 5000;
        void run(() => api.seek(Math.max(0, Math.min(player.durationMs, player.positionMs + offset))));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [player.currentTrackId, player.durationMs, player.positionMs, run, tracks.length]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const tick = () => { void api.state().then((state) => { if (active) setPlayer(state); }).catch(() => {}); };
    tick(); const timer = window.setInterval(tick, 400);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { localStorage.setItem("michoplay-library-roots", JSON.stringify(roots)); }, [roots]);
  useEffect(() => {
    if (!sortMenuOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".sort-control")) setSortMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSortMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [sortMenuOpen]);
  useEffect(() => {
    localStorage.setItem("michoplay-zoom-level", JSON.stringify(zoomLevel));
    const applyZoom = () => {
      const scale = zoomLevel / 100;
      document.documentElement.style.setProperty("--app-zoom", String(scale));
      document.documentElement.style.setProperty("--app-frame-width", `${window.innerWidth / scale}px`);
      document.documentElement.style.setProperty("--app-frame-height", `${window.innerHeight / scale}px`);
      document.documentElement.style.setProperty("--app-frame-min-height", `${500 / scale}px`);
    };
    applyZoom();
    window.addEventListener("resize", applyZoom);
    return () => window.removeEventListener("resize", applyZoom);
  }, [zoomLevel]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (["-", "_", "Subtract", "NumpadSubtract"].includes(event.key)) {
        event.preventDefault(); setZoomLevel((value) => normalizeZoom(value - 10));
      } else if (["+", "=", "Add", "NumpadAdd"].includes(event.key)) {
        event.preventDefault(); setZoomLevel((value) => normalizeZoom(value + 10));
      } else if (event.key === "0") {
        event.preventDefault(); setZoomLevel(100);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { localStorage.setItem("michoplay-favorites", JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { localStorage.setItem("michoplay-playlists", JSON.stringify(playlists)); }, [playlists]);
  useEffect(() => { localStorage.setItem("michoplay-listening-history", JSON.stringify(listeningHistory)); }, [listeningHistory]);
  useEffect(() => { localStorage.setItem("michoplay-recent-searches", JSON.stringify(recentSearches)); }, [recentSearches]);
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".global-search")) setSearchOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSearchOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [searchOpen]);
  useEffect(() => {
    const trackId = player.currentTrackId;
    if (trackId === null) { lastStartedTrack.current = null; return; }
    if (lastStartedTrack.current === trackId) return;
    lastStartedTrack.current = trackId;
    setListeningHistory((prior) => {
      const now = Date.now();
      const current = tracks.find((track) => track.id === trackId);
      const existing = prior.find((entry) => entry.trackId === trackId);
      const entry: ListeningRecord = { trackId, lastPlayedAt: now, playCount: (existing?.playCount ?? 0) + 1, positionMs: 0, durationMs: current?.durationMs ?? existing?.durationMs ?? 0 };
      return [entry, ...prior.filter((item) => item.trackId !== trackId)].slice(0, 500);
    });
  }, [player.currentTrackId, tracks]);
  useEffect(() => {
    if (player.currentTrackId === null || player.positionMs < 1000) return;
    setListeningHistory((prior) => {
      const entry = prior.find((item) => item.trackId === player.currentTrackId);
      if (!entry || (player.isPlaying && Math.abs(player.positionMs - entry.positionMs) < 5000)) return prior;
      return prior.map((item) => item.trackId === player.currentTrackId ? { ...item, positionMs: player.positionMs, durationMs: player.durationMs || item.durationMs } : item);
    });
  }, [player.currentTrackId, player.positionMs, player.durationMs, player.isPlaying]);
  useEffect(() => { localStorage.setItem("michoplay-sidebar-width", JSON.stringify(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem("michoplay-panel-width", JSON.stringify(panelWidth)); }, [panelWidth]);
  useEffect(() => { localStorage.setItem("michoplay-show-now-playing", JSON.stringify(showPanel)); }, [showPanel]);
  useEffect(() => { localStorage.setItem("michoplay-keep-screen-awake-in-full-mode", JSON.stringify(keepScreenAwake)); }, [keepScreenAwake]);
  useEffect(() => {
    let active = true;
    type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener?: (type: "release", listener: () => void) => void };
    type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };
    const requestWakeLock = async () => {
      if (!fullMode || !keepScreenAwake || document.visibilityState !== "visible" || wakeLockRef.current) return;
      try {
        const wakeLock = await (navigator as WakeLockNavigator).wakeLock?.request("screen");
        if (!wakeLock) return;
        if (!active) await wakeLock.release();
        else {
          wakeLockRef.current = wakeLock;
          wakeLock.addEventListener?.("release", () => { if (wakeLockRef.current === wakeLock) wakeLockRef.current = null; });
        }
      } catch { /* Screen wake lock is optional on unsupported desktop webviews. */ }
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void requestWakeLock(); };
    const onFullscreenChange = () => { if (!document.fullscreenElement && fullMode) setFullMode(false); };
    void requestWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock) void lock.release();
    };
  }, [fullMode, keepScreenAwake]);
  useEffect(() => { localStorage.setItem("michoplay-compact", JSON.stringify(compact)); }, [compact]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".action-menu, .menu-trigger")) { setMenu(null); setAppMenu(false); }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(null); setAppMenu(false); setDialog(null); setConfirmation(null); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, []);

  async function chooseFolder() {
    if (!isTauri()) { setMessage("Open the desktop app to choose music folders."); return; }
    try {
      const selected = await open({ directory: true, multiple: false, title: "Choose a music folder" });
      if (typeof selected !== "string") return;
      setScanning(true); setMessage("");
      const scanned = await api.scanFolder(selected);
      setTracks(scanned); setPlayer(await api.state());
      const canonical = scanned.find((track) => track.rootPath === selected)?.rootPath ?? selected;
      setRoots((prior) => prior.includes(canonical) ? prior : [...prior, canonical]);
    } catch (error) { setMessage(String(error)); } finally { setScanning(false); }
  }
  async function importAudioPayloads(payloads: { name: string; dataBase64: string }[], playImported = false) {
    if (!isTauri()) { setMessage("Open MichoPlay to import local audio."); return; }
    const supported = payloads.filter((file) => /\.(mp3|flac|wav|ogg|opus|m4a|aac|aiff|aif)$/i.test(file.name));
    if (!supported.length) { setMessage("Choose one or more supported audio files."); return; }
    if (supported.length > 100) { setMessage("Choose no more than 100 audio files at a time."); return; }
    setScanning(true); setMessage("");
    try {
      if (playImported) {
        const scanned = await api.importAndPlayFiles(supported);
        setTracks(scanned); setPlayer(await api.state());
        setRoots((prior) => [...new Set([...prior, ...scanned.map((track) => track.rootPath)])]);
        setMessage(`Opened ${supported.length} ${supported.length === 1 ? "song" : "songs"}.`);
        return;
      }
      let imported = 0;
      const failures: string[] = [];
      for (const [index, file] of supported.entries()) {
        setMessage(`Importing ${index + 1} of ${supported.length}…`);
        try {
          await api.importFiles([file]);
          imported++;
        } catch (error) { failures.push(`${file.name}: ${String(error)}`); }
      }
      if (!imported) throw new Error(failures[0] ?? "No selected audio files could be imported.");
      const musicDirectory = await api.importDirectory();
      const scanned = await api.scanFolder(musicDirectory);
      setTracks(scanned); setPlayer(await api.state());
      setRoots((prior) => prior.includes(musicDirectory) ? prior : [...prior, musicDirectory]);
      setMessage(`Imported ${imported} ${imported === 1 ? "song" : "songs"}.${failures.length ? ` ${failures.length} file${failures.length === 1 ? "" : "s"} skipped.` : ""}`);
    } catch (error) { setMessage(`Music import failed: ${String(error)}`); }
    finally { setScanning(false); }
  }
  async function importAudioFiles(files: File[]) {
    const supported = files.filter((file) => file.type.startsWith("audio/") || /\.(mp3|flac|wav|ogg|opus|m4a|aac|aiff|aif)$/i.test(file.name));
    if (!supported.length) { setMessage("Choose one or more supported audio files."); return; }
    if (supported.some((file) => file.size > 256 * 1024 * 1024)) { setMessage("Each audio file must be 256 MB or smaller."); return; }
    const payloads = await Promise.all(supported.map(async (file) => ({ name: file.name, dataBase64: await fileToBase64(file) })));
    await importAudioPayloads(payloads);
  }
  async function queueYoutubeDownload(selected: YoutubeSearchResult) {
    setMessage("");
    try {
      const item = await api.youtubeDownloadEnqueue(selected.url, selected.title, selected.thumbnail, selected.isPlaylist);
      setYoutubeDownloads((prior) => prior.some((download) => download.id === item.id) ? prior : [...prior, item]);
      setPanelView("downloads"); setShowPanel(true);
    } catch (error) { setMessage(String(error)); }
  }
  async function controlYoutubeDownload(id: string, action: "pause" | "resume" | "cancel" | "remove") {
    try {
      if (action === "pause") await api.youtubeDownloadPause(id);
      else if (action === "resume") await api.youtubeDownloadResume(id);
      else if (action === "cancel") await api.youtubeDownloadCancel(id);
      else await api.youtubeDownloadRemove(id);
    } catch (error) { setMessage(String(error)); }
  }
  function chooseLibrarySource() {
    if (isAndroid) importInput.current?.click();
    else void chooseFolder();
  }
  async function removeFolder(folder: string) {
    try { setTracks(await api.removeFolder(folder)); setRoots((prior) => prior.filter((root) => root !== folder)); setPlayer(await api.state()); setMessage(""); }
    catch (error) { setMessage(String(error)); }
  }
  function confirmRemoveFolder(folder: string) {
    setConfirmation({ title: "Remove music folder?", message: `“${folder}” will be removed from your library. The files on disk will stay untouched.`, label: "Remove folder", confirm: () => { void removeFolder(folder); } });
  }
  function confirmDeletePlaylist(playlist: Playlist) {
    setConfirmation({ title: "Delete playlist?", message: `“${playlist.name}” and its song list will be removed. Your music files will stay untouched.`, label: "Delete playlist", confirm: () => { setPlaylists((prior) => prior.filter((item) => item.id !== playlist.id)); setHistory((prior) => ({ entries: [...prior.entries.slice(0, prior.index + 1), { section: "Playlists" }], index: prior.index + 1 })); setConfirmation(null); } });
  }
  function confirmRemovePlaylistTrack(playlist: Playlist, track: Track) {
    setConfirmation({ title: "Remove song from playlist?", message: `“${track.title}” will be removed from “${playlist.name}”.`, label: "Remove song", confirm: () => { setPlaylists((prior) => prior.map((item) => item.id === playlist.id ? { ...item, trackIds: item.trackIds.filter((id) => id !== track.id) } : item)); setConfirmation(null); setMenu(null); } });
  }
  function toggleFavorite(id: number) { setFavorites((prior) => prior.includes(id) ? prior.filter((item) => item !== id) : [...prior, id]); }
  function startResize(which: "sidebar" | "panel", event: ReactPointerEvent) {
    event.preventDefault(); const start = event.clientX; const width = which === "sidebar" ? sidebarWidth : panelWidth;
    const move = (next: globalThis.PointerEvent) => {
      if (which === "sidebar") setSidebarWidth(Math.max(184, Math.min(360, width + next.clientX - start)));
      else setPanelWidth(Math.max(250, Math.min(460, width - next.clientX + start)));
    };
    const done = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done); window.removeEventListener("pointercancel", done); document.body.classList.remove("resizing"); };
    document.body.classList.add("resizing"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", done); window.addEventListener("pointercancel", done);
  }

  const trackMap = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const current = player.currentTrackId === null ? null : trackMap.get(player.currentTrackId) ?? null;
  const recentTracks = useMemo(() => listeningHistory
    .slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .flatMap((entry) => trackMap.has(entry.trackId) ? [trackMap.get(entry.trackId)!] : []), [listeningHistory, trackMap]);
  const nowPlayingTrack = current ?? recentTracks[0] ?? null;
  const nowPlayingIsActive = current !== null && player.isPlaying;
  const footerTrack = current ?? nowPlayingTrack;
  const folders = useMemo(() => {
    const groups = new Map<string, Collection>();
    const rootsWithDirectSongs = new Set(tracks.filter((track) => track.folderPath === track.rootPath).map((track) => track.rootPath));
    for (const track of tracks) for (const folder of track.folders) {
      // Include roots only when they have direct songs, and include every music-bearing descendant.
      if (folder.path === track.rootPath && !rootsWithDirectSongs.has(track.rootPath)) continue;
      if (!groups.has(folder.path)) groups.set(folder.path, { key: folder.path, title: folder.name, subtitle: folder.path, tracks: [] });
      groups.get(folder.path)!.tracks.push(track);
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks]);
  const albums = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of tracks) { const key = albumKey(track); if (!groups.has(key)) groups.set(key, { key, title: track.album, subtitle: track.artist, tracks: [] }); groups.get(key)!.tracks.push(track); }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks]);
  const artists = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of tracks) { if (!groups.has(track.artist)) groups.set(track.artist, { key: track.artist, title: track.artist, subtitle: "", tracks: [] }); groups.get(track.artist)!.tracks.push(track); }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks]);
  const sidebarPlaylistItems = useMemo(() => { const items = playlists.filter((item) => item.name.trim().toLocaleLowerCase() !== "youtube" && item.name.toLocaleLowerCase().includes(sidebarLibrarySearch.trim().toLocaleLowerCase())); if (sidebarLibrarySort === "az") items.sort((a, b) => a.name.localeCompare(b.name)); return items; }, [playlists, sidebarLibrarySearch, sidebarLibrarySort]);
  const collectionTracks = useMemo(() => {
    const detail = page.detail;
    if (page.section === "Recently Played") return recentTracks;
    if (detail?.kind === "folder") return tracks.filter((track) => track.folders.some((folder) => folder.path === detail.key));
    if (detail?.kind === "album") return tracks.filter((track) => albumKey(track) === detail.key);
    if (detail?.kind === "artist") return tracks.filter((track) => track.artist === detail.key);
    if (detail?.kind === "playlist") return (selectedPlaylist?.trackIds ?? []).flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []);
    return page.section === "Favorites" ? tracks.filter((track) => favorites.includes(track.id)) : tracks;
  }, [page, tracks, selectedPlaylist, trackMap, favorites, recentTracks]);
  const visibleTracks = useMemo(() => collectionTracks.filter((track) => matches(track, inlineSearch)), [collectionTracks, inlineSearch]);
  const sortedVisibleTracks = useMemo(() => {
    const sorted = [...visibleTracks];
    if (sortBy === "title" || sortBy === "artist" || sortBy === "album") {
      sorted.sort((a, b) => a[sortBy].localeCompare(b[sortBy], undefined, { numeric: true, sensitivity: "base" }));
    } else if (sortBy === "recentlyAdded") sorted.sort((a, b) => b.addedAt - a.addedAt);
    else if (sortBy === "releaseDate") sorted.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "") || a.title.localeCompare(b.title));
    else if (sortBy === "duration") sorted.sort((a, b) => a.durationMs - b.durationMs || a.title.localeCompare(b.title));
    return sorted;
  }, [visibleTracks, sortBy]);
  const heading = selectedPlaylist?.name ?? page.detail?.title ?? page.section;
  const firstArt = collectionTracks.find((track) => track.artworkKey)?.artworkKey;
  const headingArt = useArtwork(firstArt);
  const listPage = Boolean(page.detail) || page.section === "Songs" || page.section === "Favorites" || page.section === "Recently Played";
  const buildSearchResults = useCallback((value: string): GlobalSearchResult[] => {
    const query = value.trim().toLocaleLowerCase();
    if (!query) return [];
    const tracksFound = tracks.filter((track) => matches(track, query)).slice(0, 4).map((track): GlobalSearchResult => ({
      type: "Song", title: track.title, subtitle: `Song · ${track.artist}`, artworkKey: track.artworkKey, trackId: track.id,
    }));
    const artistsFound = artists.filter((item) => item.title.toLocaleLowerCase().includes(query)).slice(0, 2).map((item): GlobalSearchResult => ({
      type: "Artist", title: item.title, subtitle: `Artist · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
      page: { section: "Artists", detail: { kind: "artist", key: item.key, title: item.title } },
    }));
    const albumsFound = albums.filter((item) => `${item.title} ${item.subtitle}`.toLocaleLowerCase().includes(query)).slice(0, 2).map((item): GlobalSearchResult => ({
      type: "Album", title: item.title, subtitle: `Album · ${item.subtitle}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
      page: { section: "Albums", detail: { kind: "album", key: item.key, title: item.title } },
    }));
    const foldersFound = folders.filter((item) => `${item.title} ${item.subtitle}`.toLocaleLowerCase().includes(query)).slice(0, 2).map((item): GlobalSearchResult => ({
      type: "Folder", title: item.title, subtitle: `Folder · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
      page: { section: "Home", detail: { kind: "folder", key: item.key, title: item.title } },
    }));
    const playlistsFound = playlists.filter((playlist) => {
      const playlistTracks = playlist.trackIds.flatMap((id) => trackMap.has(id) ? [trackMap.get(id)!] : []);
      return playlist.name.toLocaleLowerCase().includes(query) || playlistTracks.some((track) => matches(track, query));
    }).slice(0, 2).map((playlist): GlobalSearchResult => {
      const item: Collection = { key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => trackMap.has(id) ? [trackMap.get(id)!] : []) };
      return { type: "Playlist", title: item.title, subtitle: `Playlist · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null, page: { section: "Playlists", detail: { kind: "playlist", key: item.key, title: item.title } } };
    });
    return [...tracksFound, ...artistsFound, ...albumsFound, ...foldersFound, ...playlistsFound];
  }, [tracks, artists, albums, folders, playlists, trackMap]);
  const searchResults = useMemo(() => buildSearchResults(search), [buildSearchResults, search]);
  const recentSearchResults = useMemo(() => recentSearches.map((query) => ({ query, result: buildSearchResults(query)[0] ?? null })), [recentSearches, buildSearchResults]);

  useEffect(() => {
    if (!isAndroid && !isTauri()) return;
    let unlisten: (() => void) | undefined;
    const eventName = isAndroid ? "plugin:michoplay-media|action" : "system-media-control";
    void listen<{ action: string } | string>(eventName, ({ payload }) => {
      const action = typeof payload === "string" ? payload : payload.action;
      if (action.startsWith("seek:")) {
        const position = Number(action.slice(5));
        if (Number.isFinite(position)) void run(() => api.seek(position));
        return;
      }
      switch (action) {
        case "open-audio": void api.takeOpenedAudio().then((files) => importAudioPayloads(files, true)).catch((error) => setMessage(String(error))); break;
        case "toggle": void run(api.toggle); break;
        case "play": void run(async () => { if (!(await api.state()).isPlaying) await api.toggle(); }); break;
        case "pause": void run(async () => { if ((await api.state()).isPlaying) await api.toggle(); }); break;
        case "previous": void run(api.previous); break;
        case "next": void run(api.next); break;
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [isAndroid, run]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const update = async () => {
      if (!active) return;
      try {
        const state = await api.state();
        if (!active) return;
        if (isAndroid && !current) await api.mediaStop();
        else await api.mediaUpdate(current, state.isPlaying, state.durationMs, state.positionMs);
      } catch { /* The player can start before Android creates the service. */ }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, isAndroid ? 4000 : 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isAndroid, current?.id, current?.title, current?.artist, player.isPlaying]);
  const playCollection = (track: Track, items = sortedVisibleTracks) => {
    if (track.id === player.currentTrackId) { void run(api.toggle); return; }
    void run(() => api.playCollection(items.map((item) => item.id), track.id));
  };
  const playCardCollection = (item: Collection) => {
    if (!item.tracks.length) return;
    if (item.tracks.some((track) => track.id === player.currentTrackId)) void run(api.toggle);
    else void run(() => api.playCollection(item.tracks.map((track) => track.id), item.tracks[0].id));
  };
  function openTrackMenu(track: Track, event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ track, x: Math.max(8, Math.min(window.innerWidth - 235, rect.right - 225)), y: Math.max(8, Math.min(window.innerHeight - 390, rect.bottom + 5)) });
    setPlaylistSubmenu(false); setPlaylistSearch(""); setAppMenu(false);
  }
  function shareTrack(track: Track) {
    const details = { title: track.title, text: `${track.title} — ${track.artist}` };
    if (navigator.share) void navigator.share(details).catch(() => {});
    else void navigator.clipboard?.writeText(details.text).then(() => setMessage("Track details copied."), () => setMessage(details.text));
  }
  function newPlaylist(target?: Track, playlist?: Playlist) { setDialog({ target, playlist }); setPlaylistName(playlist?.name ?? ""); setMenu(null); }
  function savePlaylist() {
    const name = playlistName.trim(); if (!name || !dialog) return;
    if (dialog.playlist) setPlaylists((prior) => prior.map((item) => item.id === dialog.playlist!.id ? { ...item, name } : item));
    else {
      const playlist: Playlist = { id: crypto.randomUUID(), name, trackIds: dialog.target ? [dialog.target.id] : [] };
      setPlaylists((prior) => [...prior, playlist]);
      if (!dialog.target) { if (isAndroid) setMobileTab("home"); navigate({ section: "Playlists", detail: { kind: "playlist", key: playlist.id, title: name } }); }
    }
    setDialog(null);
  }
  function addToPlaylist(playlist: Playlist, track: Track) {
    setPlaylists((prior) => prior.map((item) => item.id === playlist.id && !item.trackIds.includes(track.id) ? { ...item, trackIds: [...item.trackIds, track.id] } : item));
    setMenu(null); setMessage(`Added to ${playlist.name}.`);
  }
  function openDetail(section: Section, kind: Detail["kind"], item: Collection) { if (isAndroid) setMobileTab("home"); navigate({ section, detail: { kind, key: item.key, title: item.title } }); }
  function rememberSearch(query: string) {
    const normalized = query.trim();
    if (!normalized) return;
    const next = [normalized, ...recentSearches.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase())].slice(0, 8);
    setRecentSearches(next);
    localStorage.setItem("michoplay-recent-searches", JSON.stringify(next));
  }
  function chooseSearchResult(result: GlobalSearchResult) {
    rememberSearch(search || result.title);
    setSearch(""); setSearchOpen(false);
    if (result.trackId !== undefined) {
      if (result.trackId === player.currentTrackId) void run(api.toggle);
      else void run(() => api.play(result.trackId!));
    }
    else if (result.page) { if (isAndroid) setMobileTab("home"); navigate(result.page); }
  }
  const playCounts = useMemo(() => new Map(listeningHistory.map((entry) => [entry.trackId, entry.playCount])), [listeningHistory]);
  const rows = (items: Track[], emptyTitle = "No songs here") => <TrackRows items={items} player={player} favorites={favorites} playCounts={playCounts} showPlayCount={page.section === "Recently Played"} onPlay={(track) => playCollection(track, items)} onFavorite={toggleFavorite} onMenu={openTrackMenu} emptyTitle={scanning ? "Scanning music…" : search || inlineSearch ? "No results" : emptyTitle} emptyMessage={scanning ? "Reading local audio and artwork." : search || inlineSearch ? "Try another search." : page.section === "Favorites" ? "Save songs with the heart in their action menu." : page.section === "Recently Played" ? "Songs will appear here after you play them." : page.detail?.kind === "playlist" ? "Add songs from the three-dot menu in your library." : "Add a music folder to get started."} />;

  return <main className={`app-frame ${compact ? "compact" : ""} ${isAndroid ? "android-app" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--panel-width": `${panelWidth}px` } as CSSProperties}>
    <svg className="mobile-svg-defs" aria-hidden="true" focusable="false"><defs><linearGradient id="michoplay-brand-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#f5c6be"/><stop offset="64%" stopColor="#cbc4de"/><stop offset="100%" stopColor="#d8eee4"/></linearGradient></defs></svg>
    <input ref={importInput} className="audio-import-input" type="file" accept="audio/*,.mp3,.flac,.wav,.ogg,.opus,.m4a,.aac,.aiff,.aif" multiple aria-label="Choose audio files" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importAudioFiles(files); }}/>
    <aside className="sidebar" aria-label="Main navigation">
      <button className="brand" onClick={() => navigate({ section: "Home" })}><span className="brand-mark"><AudioLines size={19}/></span><span>Micho<span className="brand-light">Play</span></span></button>
      <nav className="nav-list" aria-label="Library">{navigation.map(({ label, icon: Icon }) => <Fragment key={label}><button className={`nav-item ${page.section === label && !(label === "Playlists" && isYoutubePlaylist) ? "active" : ""}`} aria-label={label} title={label} aria-current={page.section === label && !(label === "Playlists" && isYoutubePlaylist) ? "page" : undefined} onClick={() => { setSearch(""); navigate({ section: label }); }}><Icon size={18}/><span>{label}</span></button>{label === "Favorites" && !isAndroid && <button className={`nav-item ${isYoutubePlaylist ? "active" : ""}`} aria-label="YouTube" title="YouTube" aria-current={isYoutubePlaylist ? "page" : undefined} onClick={() => { const youtube = youtubePlaylist ?? { id: "michoplay-youtube", name: "YouTube", trackIds: [] }; if (!youtubePlaylist) setPlaylists((prior) => prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube") ? prior : [youtube, ...prior]); setSearch(""); navigate({ section: "Playlists", detail: { kind: "playlist", key: youtube.id, title: youtube.name } }); }}><Youtube size={18}/><span>YouTube</span></button>}</Fragment>)}</nav>
      <div className="sidebar-rule"/><div className="library-heading"><span className="side-label">Your Library</span><div className="library-heading-actions"><button className="icon-button small" aria-label="Create playlist" title="Create playlist" onClick={() => newPlaylist()}><Plus size={15}/></button><button className="icon-button small" aria-label="Open playlists" title="Open playlists" onClick={() => navigate({ section: "Playlists" })}><Maximize2 size={12}/></button></div></div>
      <div className="library-tools"><label className="library-search"><Search size={16}/><input aria-label="Search your library" placeholder="Search" value={sidebarLibrarySearch} onChange={(event) => setSidebarLibrarySearch(event.target.value)}/>{sidebarLibrarySearch && <button aria-label="Clear library search" onClick={() => setSidebarLibrarySearch("")}><X size={13}/></button>}</label><button className="library-sort" aria-label={`Sort ${sidebarLibrarySort === "recent" ? "recently added" : "alphabetically"}; click to change`} title="Change sort order" onClick={() => setSidebarLibrarySort((value) => value === "recent" ? "az" : "recent")}><span>{sidebarLibrarySort === "recent" ? "Recents" : "A–Z"}</span><List size={16}/></button></div>
      <div className="sidebar-playlists" aria-live="polite">{sidebarPlaylistItems.map((playlist) => { const firstTrack = playlist.trackIds.map((id) => trackMap.get(id)).find((track): track is Track => Boolean(track)); const selected = selectedPlaylist?.id === playlist.id; return <button key={playlist.id} className={`library-item ${selected ? "selected" : ""}`} onClick={() => navigate({ section: "Playlists", detail: { kind: "playlist", key: playlist.id, title: playlist.name } })}>{firstTrack ? <Cover className="library-item-art" keys={[firstTrack.artworkKey]}/> : <span className="library-item-placeholder"><ListMusic size={20}/></span>}<span className="library-item-copy"><strong>{playlist.name}</strong><small><ListMusic size={12}/> Playlist · {playlist.trackIds.length} {playlist.trackIds.length === 1 ? "song" : "songs"}</small></span></button>})}{!sidebarPlaylistItems.length && <div className="library-empty">{sidebarLibrarySearch ? "No matching playlists" : "Create a playlist to keep songs together."}</div>}</div>
    </aside>
    <div className="resize-handle sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={(event) => startResize("sidebar", event)}/>
    <section className="workspace">
      {isAndroid && !mobilePlayerOpen && <header className="mobile-header">
        <div className="mobile-header-title">
          <span className="brand-mark"><AudioLines size={19}/></span>
          <h1>{page.section === "Settings" ? "Settings" : mobileTab === "home" ? (page.detail?.title ?? "MichoPlay") : mobileTab === "search" ? "Search" : "Your Library"}</h1>
        </div>
        <div className="mobile-header-actions">
          {mobileTab === "home" && <button className="mobile-icon-button" aria-label="Search music" onClick={() => { setMobileTab("search"); setSearch(""); }}><Search size={24}/></button>}
          {mobileTab === "library" && <button className="mobile-icon-button" aria-label="Import music" onClick={chooseLibrarySource}><Plus size={25}/></button>}
          <button className="mobile-icon-button" aria-label="Settings" onClick={() => { setMobileTab("home"); navigate({ section: "Settings" }); }}><Settings2 size={20}/></button>
        </div>
      </header>}
      <header className="topbar"><div className="history-nav"><div className="app-menu-anchor"><button className="icon-button menu-trigger" aria-label="Application menu" aria-expanded={appMenu} onClick={() => { setAppMenu(!appMenu); setMenu(null); }}><MoreHorizontal size={22}/></button>{appMenu && <div className="action-menu app-menu"><button onClick={() => { chooseLibrarySource(); setAppMenu(false); }}><Plus size={15}/>{isAndroid ? "Import audio files" : "Add music folder"}</button><button onClick={() => { void refresh(); setAppMenu(false); }}><RefreshCw size={15}/>Refresh library</button><button onClick={() => newPlaylist()}><ListMusic size={15}/>New playlist</button><div className="menu-separator"/><button onClick={() => navigate({ section: "Settings" })}><Settings2 size={15}/>Settings</button><button onClick={() => { setAboutOpen(true); setAppMenu(false); }}><AudioLines size={15}/>About MichoPlay</button></div>}</div><button className="icon-button" aria-label="Go back" disabled={history.index === 0} onClick={() => travel(-1)}><ChevronLeft size={24}/></button><button className="icon-button" aria-label="Go forward" disabled={history.index === history.entries.length - 1} onClick={() => travel(1)}><ChevronRight size={24}/></button></div><div className={`search-box global-search ${searchOpen ? "expanded" : ""}`} role="search"><Search size={17}/><input aria-label="Search all music" aria-expanded={searchOpen} aria-controls="global-search-results" placeholder="What do you want to play?" value={search} onFocus={() => setSearchOpen(true)} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); else if (event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLButtonElement>(".global-search-result")?.focus(); } else if (event.key === "Enter" && searchResults[0]) { event.preventDefault(); chooseSearchResult(searchResults[0]); } }}/>{search && <button className="icon-button" aria-label="Clear search" onClick={() => { setSearch(""); setSearchOpen(true); }}><X size={15}/></button>}{searchOpen && <div className="global-search-popover" id="global-search-results" role="listbox" aria-label="Search results">{search.trim() ? searchResults.length ? ["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => { const group = searchResults.filter((result) => result.type === type); return group.length ? <section className="global-search-group" key={type}><h2>{type === "Song" ? "Songs" : `${type}s`}</h2>{group.map((result) => <GlobalSearchResultButton key={`${result.type}-${result.title}-${result.subtitle}`} result={result} onClick={() => chooseSearchResult(result)} isPlaying={result.trackId === player.currentTrackId && player.isPlaying}/>)}</section> : null; }) : <div className="global-search-empty"><strong>No matches for “{search}”</strong><span>Try a song, artist, album, folder, or playlist name.</span></div> : recentSearchResults.length ? <section className="global-search-group"><div className="global-search-heading"><h2>Recent searches</h2><button onClick={() => { setRecentSearches([]); localStorage.removeItem("michoplay-recent-searches"); }}>Clear</button></div>{recentSearchResults.map(({ query, result }) => result ? <GlobalSearchResultButton key={query} result={result} onClick={() => { setSearch(query); setSearchOpen(true); }} showPlayHover={false}/ > : <button className="global-search-result recent-query" key={query} role="option" onClick={() => { setSearch(query); setSearchOpen(true); }}><span className="search-result-symbol"><Search size={17}/></span><span className="search-result-copy"><strong>{query}</strong><small>Recent search</small></span></button>)}</section> : <div className="global-search-empty"><strong>Search your library</strong><span>Find songs, artists, albums, folders, and playlists.</span></div>}</div>}</div><button className={`topbar-settings ${page.section === "Settings" ? "active" : ""}`} aria-label="Settings" title="Settings" onClick={() => navigate({ section: "Settings" })}><Settings2 size={18}/></button></header>
      <div className={`work-area ${showPanel ? "with-panel" : "without-panel"}`}>
        <section className="content-scroll" aria-label={heading}>
          {scanning && <div className="scan-banner" role="status"><span className="loading-indicator"/>Scanning music and artwork…</div>}
          {message && <div className="status-message" role="status"><span>{message.includes("Refresh the folder") ? <>{message.split("Refresh the folder")[0]}<button className="inline-link" onClick={() => void refresh()}>Refresh the folder</button>{message.split("Refresh the folder")[1]}</> : message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage("")}><X size={13}/></button></div>}
          {isAndroid && mobileTab === "search" ? <div className="mobile-search-view">
            <label className="mobile-search-input"><Search size={22}/><input aria-label="Search your library" placeholder="What do you want to listen to?" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchResults[0]) chooseSearchResult(searchResults[0]); }}/>{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={19}/></button>}</label>
            {search.trim() ? searchResults.length ? <div className="mobile-search-results">{["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => { const group = searchResults.filter((result) => result.type === type); return group.length ? <section className="mobile-result-group" key={type}><h2>{type === "Song" ? "Songs" : `${type}s`}</h2>{group.map((result) => <GlobalSearchResultButton key={`${result.type}-${result.title}-${result.subtitle}`} result={result} onClick={() => chooseSearchResult(result)} isPlaying={result.trackId === player.currentTrackId && player.isPlaying}/>)}</section> : null; })}</div> : <div className="mobile-search-empty"><strong>No matches for “{search}”</strong><span>Try a song, artist, album, folder, or playlist name.</span></div> : recentSearchResults.length ? <section className="mobile-result-group"><h2>Recent searches</h2>{recentSearchResults.map(({ query, result }) => result ? <GlobalSearchResultButton key={query} result={result} onClick={() => { setSearch(query); }} showPlayHover={false}/> : null)}</section> : <div className="mobile-search-empty"><strong>Search your music</strong><span>Find songs, artists, albums, folders, and playlists saved on this device.</span></div>}
          </div> : isAndroid && mobileTab === "library" ? <div className="mobile-library-view">
            <div className="mobile-filter-row library-filter-row" role="tablist" aria-label="Library filters">{(["All", "Playlists", "Folders", "Albums", "Artists", "Songs"] as const).map((filter) => <button key={filter} role="tab" aria-selected={mobileLibraryFilter === filter} className={mobileLibraryFilter === filter ? "selected" : ""} onClick={() => setMobileLibraryFilter(filter)}>{filter}</button>)}</div>
            {mobileLibraryFilter === "Songs" ? <div className="mobile-library-songs">{rows(tracks, "No songs in your library")}</div> : <div className="mobile-library-list">
              {(mobileLibraryFilter === "All" || mobileLibraryFilter === "Playlists") && <>
                <button className="mobile-library-row" onClick={() => { setMobileTab("home"); navigate({ section: "Favorites" }); }}><Cover className="mobile-library-cover liked-cover" keys={favorites.flatMap((id) => trackMap.get(id)?.artworkKey ?? [])} icon={<Heart size={23} fill="currentColor"/>}/><span><strong>Liked Songs</strong><small>{favorites.length} songs · Playlist</small></span></button>
                {playlists.map((playlist) => { const item: Collection = { key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) }; return <button className="mobile-library-row" key={playlist.id} onClick={() => { setMobileTab("home"); openDetail("Playlists", "playlist", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)} icon={<ListMusic size={23}/>}/><span><strong>{playlist.name}</strong><small>{item.tracks.length} songs · Playlist</small></span></button>; })}
              </>}
              {(mobileLibraryFilter === "All" || mobileLibraryFilter === "Folders") && folders.map((item) => <button className="mobile-library-row" key={item.key} onClick={() => { setMobileTab("home"); openDetail("Home", "folder", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)} icon={<FolderOpen size={22}/>}/><span><strong>{item.title}</strong><small>{item.tracks.length} songs · Folder</small></span></button>)}
              {(mobileLibraryFilter === "All" || mobileLibraryFilter === "Albums") && albums.map((item) => <button className="mobile-library-row" key={item.key} onClick={() => { setMobileTab("home"); openDetail("Albums", "album", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)}/><span><strong>{item.title}</strong><small>{item.subtitle} · Album</small></span></button>)}
              {(mobileLibraryFilter === "All" || mobileLibraryFilter === "Artists") && artists.map((item) => <button className="mobile-library-row" key={item.key} onClick={() => { setMobileTab("home"); openDetail("Artists", "artist", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)} icon={<AudioLines size={22}/>}/><span><strong>{item.title}</strong><small>{item.tracks.length} songs · Artist</small></span></button>)}
              {((mobileLibraryFilter === "All" && !playlists.length && !albums.length && !folders.length && !artists.length) || (mobileLibraryFilter === "Playlists" && !playlists.length) || (mobileLibraryFilter === "Folders" && !folders.length) || (mobileLibraryFilter === "Albums" && !albums.length) || (mobileLibraryFilter === "Artists" && !artists.length)) && <Empty title="Nothing here yet" description="Import music or add songs to your library to see them here." action={<button className="primary-button" onClick={chooseLibrarySource}><Plus size={15}/>Import audio</button>}/>}
            </div>}
          </div> : page.section === "Settings" ? <SettingsPage roots={roots} player={player} equalizerBands={equalizerBands} equalizerEnabled={equalizerEnabled} compact={compact} showPanel={showPanel} keepScreenAwake={keepScreenAwake} onKeepScreenAwake={setKeepScreenAwake} scanning={scanning} mobile={isAndroid} zoomLevel={zoomLevel} onZoom={setZoomLevel} onEqualizer={(bands) => { setEqualizerBands(bands); localStorage.setItem("michoplay-equalizer-bands", JSON.stringify(bands)); void run(() => api.equalizer(bands, equalizerEnabled)); }} onEqualizerToggle={(enabled) => { setEqualizerEnabled(enabled); localStorage.setItem("michoplay-equalizer-enabled", JSON.stringify(enabled)); void run(() => api.equalizer(equalizerBands, enabled)); }} onCompact={setCompact} onPanel={setShowPanel} onAdd={chooseLibrarySource} onRemove={confirmRemoveFolder} onRefresh={() => void refresh()} onVolume={(volume) => { localStorage.setItem("michoplay-volume", JSON.stringify(volume)); void run(() => api.volume(volume)); }} onAutoplay={(enabled) => { localStorage.setItem("michoplay-autoplay", JSON.stringify(enabled)); void run(() => api.autoplay(enabled)); }} onSleepTimer={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))} onDefaultPlayer={() => isAndroid ? setMessage("Open an audio file from your file manager, choose MichoPlay, then tap Always to make it the default.") : void run(() => api.setDefaultPlayer())} /> : <>
            <div className={`collection-heading ${listPage ? "detail-heading" : ""}`}>
              {headingArt && listPage && <div className="cover-backdrop" style={{ backgroundImage: `url("${headingArt}")` }}/>}<div className="heading-foreground">{page.detail && <Cover className="heading-cover" keys={coverKeys(collectionTracks)} icon={page.detail.kind === "folder" ? <FolderOpen size={40}/> : undefined}/>}<div className="heading-copy"><h1>{heading}</h1><p>{isYoutubePlaylist ? "Download audio from YouTube by searching or pasting a link." : listPage ? `${collectionTracks.length} songs · ${time(collectionTracks.reduce((sum, track) => sum + track.durationMs, 0))}` : page.section === "Home" ? `${folders.length} music folders` : page.section === "Albums" ? `${albums.length} albums` : page.section === "Artists" ? `${artists.length} artists` : `${playlists.length} playlists`}</p></div></div>
            </div>
          {listPage ? <>{isYoutubePlaylist && <section className="youtube-downloader" aria-label="Search YouTube audio">
            <div className="youtube-search-header">
            <form className="youtube-search-form" onSubmit={(event) => event.preventDefault()}>
              <label className="youtube-search-input"><Search size={16}/><input type="search" aria-label="Search YouTube" placeholder="Search songs or paste a YouTube link" value={youtubeQuery} onChange={(event) => setYoutubeQuery(event.target.value)}/>{youtubeQuery && <button type="button" aria-label="Clear YouTube search" onClick={() => setYoutubeQuery("")}><X size={15}/></button>}</label>
              {youtubeSearching && <span className="youtube-search-spinner" role="status">Searching</span>}
            </form>
            </div>
            {youtubeSearching ? <div className="youtube-search-grid" aria-label="Loading YouTube results">{Array.from({ length: 6 }, (_, index) => <div className="youtube-result-skeleton" key={index}><span/><div><i/><i/></div></div>)}</div>
              : youtubeSearchError ? <p className="youtube-search-empty" role="alert">{youtubeSearchError}</p>
              : youtubeQuery.trim() && youtubeResults.length ? <div className="youtube-search-grid" aria-label="YouTube search results">{youtubeResults.map((result) => <article className="youtube-result-card" key={result.id}>
                <button className="youtube-result-preview" aria-label={`Preview ${result.title}`} onClick={() => setYoutubePreview(result)}>
                  <span className="youtube-result-art">{result.thumbnail ? <img src={result.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/> : <Youtube size={24}/>}<span className="youtube-result-duration">{result.durationSeconds === null ? (result.isPlaylist ? "Playlist" : "YouTube") : durationLabel(result.durationSeconds)}</span><span className="youtube-result-preview-icon"><Play size={20} fill="currentColor"/></span></span>
                  <span className="youtube-result-copy"><strong>{result.title}</strong><small>{result.isPlaylist ? "Playlist · M4A audio" : `Video · M4A · ${youtubeResultSize(result)}`}</small></span>
                </button>
                <button className="youtube-result-download" aria-label={`Download ${result.title}`} onClick={() => void queueYoutubeDownload(result)}><Download size={14}/><span>Download</span></button>
              </article>)}</div>
              : youtubeQuery.trim() ? <p className="youtube-search-empty">No videos found. Try a different title or link.</p> : null}
          </section>}<div className="collection-tools"><div className="play-actions"><button className={`primary-play ${collectionTracks.some((track) => track.id === player.currentTrackId) ? "is-playing" : ""}`} aria-label={collectionTracks.some((track) => track.id === player.currentTrackId) && player.isPlaying ? `Pause ${heading}` : `Play ${heading}`} disabled={!visibleTracks.length} onClick={() => { if (collectionTracks.some((track) => track.id === player.currentTrackId)) void run(api.toggle); else if (sortedVisibleTracks[0]) playCollection(sortedVisibleTracks[0]); }}>{collectionTracks.some((track) => track.id === player.currentTrackId) && player.isPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button><button className={`round-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={!visibleTracks.length} onClick={() => void run(api.shuffle)}><Shuffle size={18}/></button>{selectedPlaylist && <><button className="text-action" onClick={() => newPlaylist(undefined, selectedPlaylist)}><Pencil size={14}/>Rename</button><button className="icon-button" aria-label="Delete playlist" onClick={() => confirmDeletePlaylist(selectedPlaylist)}><Trash2 size={16}/></button></>}</div><div className="collection-tools-right"><label className="collection-search"><Search size={15}/><input aria-label={`Search in ${heading}`} placeholder={`Search in ${heading}`} value={inlineSearch} onChange={(event) => setInlineSearch(event.target.value)}/>{inlineSearch && <button className="icon-button" aria-label="Clear collection search" onClick={() => setInlineSearch("")}><X size={14}/></button>}</label><div className="sort-control"><button className={`sort-trigger ${sortMenuOpen ? "open" : ""}`} aria-label={`Sort by ${trackSortOptions.find((option) => option.key === sortBy)?.label}`} aria-expanded={sortMenuOpen} onClick={() => setSortMenuOpen((open) => !open)}><span>{trackSortOptions.find((option) => option.key === sortBy)?.label}</span><ListFilter size={15}/></button>{sortMenuOpen && <div className="sort-menu" role="menu"><strong className="sort-menu-heading">Sort by</strong>{trackSortOptions.map((option) => <button key={option.key} role="menuitemradio" aria-checked={sortBy === option.key} className={`sort-menu-option ${sortBy === option.key ? "selected" : ""}`} onClick={() => { setSortBy(option.key); localStorage.setItem("michoplay-collection-sort", JSON.stringify(option.key)); setSortMenuOpen(false); }}><span>{option.label}</span>{sortBy === option.key && <Check size={15}/>}</button>)}<span className="sort-menu-divider"/><strong className="sort-menu-heading">View as</strong><button role="menuitemradio" aria-checked={!compact} className={`sort-menu-option view-option ${!compact ? "selected" : ""}`} onClick={() => { setCompact(false); setSortMenuOpen(false); }}><List size={15}/><span>List</span>{!compact && <Check size={15}/>}</button><button role="menuitemradio" aria-checked={compact} className={`sort-menu-option view-option ${compact ? "selected" : ""}`} onClick={() => { setCompact(true); setSortMenuOpen(false); }}><AlignJustify size={15}/><span>Compact</span>{compact && <Check size={15}/>}</button></div>}</div></div></div>{rows(sortedVisibleTracks, page.section === "Favorites" ? "No favorites yet" : page.section === "Recently Played" ? "No listening history yet" : "No songs here")}</> : page.section === "Home" ? <div className="home-section android-home">
            {isAndroid && <div className="mobile-filter-row home-filter-row" role="tablist" aria-label="Home content filters">{(["All", "Folders", "Albums"] as const).map((filter) => <button key={filter} role="tab" aria-selected={mobileHomeFilter === filter} className={mobileHomeFilter === filter ? "selected" : ""} onClick={() => setMobileHomeFilter(filter)}>{filter}</button>)}</div>}
            <div className="home-quick-grid home-library-links" aria-label="Library shortcuts">
              <button className="home-quick-card" onClick={() => navigate({ section: "Albums" })}><Cover className="home-quick-art" keys={albums[0] ? coverKeys(albums[0].tracks) : []} icon={<Disc3 size={21}/>}/><span><strong>Albums</strong><small>{albums.length} {albums.length === 1 ? "album" : "albums"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Artists" })}><Cover className="home-quick-art artist" keys={artists[0] ? coverKeys(artists[0].tracks) : []} icon={<AudioLines size={21}/>}/><span><strong>Artists</strong><small>{artists.length} {artists.length === 1 ? "artist" : "artists"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Recently Played" })}><Cover className="home-quick-art" keys={recentTracks[0] ? [recentTracks[0].artworkKey] : []} icon={<Clock3 size={21}/>}/><span><strong>Recently Played</strong><small>{recentTracks.length} {recentTracks.length === 1 ? "song" : "songs"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Playlists" })}><Cover className="home-quick-art" keys={playlists[0] ? playlists[0].trackIds.map((id) => trackMap.get(id)?.artworkKey ?? null) : []} icon={<ListMusic size={21}/>}/><span><strong>Playlists</strong><small>{playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}</small></span></button>
            </div>
            {mobileHomeFilter !== "Albums" && <><div className="section-title-row"><h2>Folders</h2><button className="text-action" disabled={scanning} onClick={chooseLibrarySource}><Plus size={15}/>{isAndroid ? "Import music" : "Add root folder"}</button></div><CollectionGrid collections={folders} kind="folder" onOpen={(item) => openDetail("Home", "folder", item)} onPlay={(item) => { if (item.tracks.some((track) => track.id === player.currentTrackId)) void run(api.toggle); else void run(() => api.playCollection(item.tracks.map((track) => track.id), item.tracks[0].id)); }} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!folders.length && <Empty title={scanning ? "Scanning music…" : "Your music starts here"} description="Import audio files to build your library on this device." action={<button className="primary-button" disabled={scanning} onClick={chooseLibrarySource}><Plus size={15}/>Import audio</button>}/>}</>}
          </div> : page.section === "Albums" ? <CollectionGrid collections={albums} kind="album" onOpen={(item) => openDetail("Albums", "album", item)}/> : page.section === "Artists" ? <CollectionGrid collections={artists} kind="artist" onOpen={(item) => openDetail("Artists", "artist", item)}/> : <div className="home-section"><div className="section-title-row"><h2>Your playlists</h2><button className="outline-button" onClick={() => newPlaylist()}><Plus size={15}/>Create playlist</button></div><CollectionGrid collections={playlists.map((item) => ({ key: item.id, title: item.name, subtitle: "", tracks: item.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) }))} kind="playlist" onOpen={(item) => openDetail("Playlists", "playlist", item)} onPlay={playCardCollection} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!playlists.length && <Empty title="No playlists yet" description="Create a playlist and add songs from their action menu."/>}</div>}
          </>}
        </section>
        {showPanel && <><div className="resize-handle panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" onPointerDown={(event) => startResize("panel", event)}/><aside className="now-panel" aria-label={panelView === "downloads" ? "Downloads" : "Now playing and queue"}>
          <div className="now-panel-head"><div className="side-panel-tabs" role="tablist" aria-label="Side panel"><button role="tab" aria-selected={panelView === "now-playing"} className={panelView === "now-playing" ? "selected" : ""} onClick={() => setPanelView("now-playing")}>Now playing</button><button role="tab" aria-selected={panelView === "downloads"} className={panelView === "downloads" ? "selected" : ""} onClick={() => setPanelView("downloads")}>Downloads{youtubeDownloads.some((item) => item.status === "downloading" || item.status === "queued") && <span className="download-tab-count">{youtubeDownloads.filter((item) => item.status === "downloading" || item.status === "queued").length}</span>}</button></div><button className="icon-button" aria-label="Hide side panel" onClick={() => setShowPanel(false)}><PanelRightClose size={16}/></button></div>
          {panelView === "downloads" ? <div className="download-manager" aria-live="polite">{youtubeDownloads.length ? youtubeDownloads.map((item) => <article className={`download-item status-${item.status}`} key={item.id}><div className="download-item-main"><span className="download-item-art">{item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/>}<Youtube size={17}/></span><div className="download-item-copy"><strong>{item.title}</strong><small>{item.status === "downloading" && item.percent !== null ? `${Math.round(item.percent)}% · ${item.message}` : item.message}</small>{item.downloadedBytes !== null && <small className="download-item-size">{formatFileSize(item.downloadedBytes)}{item.totalBytes !== null ? ` / ${formatFileSize(item.totalBytes)}` : " downloaded"}</small>}</div></div><div className="download-item-progress"><span style={{ width: `${item.percent ?? (item.status === "downloading" ? 5 : 0)}%` }}/></div><div className="download-item-actions"><span className={`download-status-label ${item.status}`}>{item.status}</span>{item.status === "downloading" || item.status === "queued" ? <button className="icon-button" aria-label={`Pause ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "pause")}><Pause size={14}/></button> : item.status === "paused" || item.status === "failed" ? <button className="icon-button" aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "resume")}><Play size={14}/></button> : null}{["queued", "downloading", "paused"].includes(item.status) ? <button className="icon-button" aria-label={`Cancel ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "cancel")}><X size={14}/></button> : <button className="icon-button" aria-label={`Remove ${item.title} from downloads`} onClick={() => void controlYoutubeDownload(item.id, "remove")}><X size={14}/></button>}</div></article>) : <div className="download-manager-empty"><Download size={27}/><strong>No downloads yet</strong><span>Choose a video from YouTube search to add it here.</span></div>}</div> : <>{nowPlayingTrack ? <div className={`now-track ${nowPlayingIsActive ? "is-active" : ""}`}><Cover className="now-cover" keys={[nowPlayingTrack.artworkKey]}/><div className="now-title"><div className="now-track-copy"><strong>{nowPlayingTrack.title}</strong><span>{nowPlayingTrack.artist}</span></div><button className={`row-action visible ${favorites.includes(nowPlayingTrack.id) ? "selected" : ""}`} aria-label="Toggle favorite" onClick={() => toggleFavorite(nowPlayingTrack.id)}><Heart size={17} fill={favorites.includes(nowPlayingTrack.id) ? "currentColor" : "none"}/></button></div></div> : <div className="now-empty"><strong>Nothing playing</strong><span>Choose a song from your library.</span></div>}<div className="queue-hint"><ListMusic size={16}/><span>Up next</span><span className="queue-empty">{player.queue.length} songs</span></div><div className="queue-list">{player.queue.map((id, index) => { const track = trackMap.get(id); return track ? <div key={id} draggable className={`queue-row ${draggedQueue === index ? "dragging" : ""} ${queueDrop === index ? "drop-target" : ""} ${player.priorityQueue.includes(id) ? "priority" : ""}`} onDragStart={(event) => { setDraggedQueue(index); event.dataTransfer.setData("application/michoplay-queue", String(index)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggedQueue !== null) { event.preventDefault(); setQueueDrop(index); } }} onDrop={(event) => { event.preventDefault(); if (draggedQueue !== null && draggedQueue !== index) void run(() => api.queueMove(draggedQueue, index)); setDraggedQueue(null); setQueueDrop(null); }} onDragEnd={() => { setDraggedQueue(null); setQueueDrop(null); }}><GripVertical className="queue-grip" size={13}/><button className="queue-song" onClick={() => void run(() => api.play(id))}><Cover className="queue-cover" keys={[track.artworkKey]}/><span><b>{track.title}</b><small>{track.artist}</small></span></button><div className="queue-actions"><button className="icon-button" aria-label={`Move ${track.title} up`} disabled={index === 0} onClick={() => void run(() => api.queueMove(index, index - 1))}><ChevronUp size={13}/></button><button className="icon-button" aria-label={`Move ${track.title} down`} disabled={index === player.queue.length - 1} onClick={() => void run(() => api.queueMove(index, index + 1))}><ChevronDown size={13}/></button><button className="icon-button" aria-label={`Remove ${track.title} from queue`} onClick={() => void run(() => api.queueRemove(index))}><X size={13}/></button></div></div> : null; })}</div>{!player.queue.length && <p className="queue-notice">Add songs to the queue from their action menu.</p>}</>}</aside></>}
      </div>
        <footer className="player-bar" aria-label="Playback controls"><div className="now-playing-mini">{footerTrack && <Cover className="mini-cover" keys={[footerTrack.artworkKey]}/>}<div className="track-copy"><span className="track-title">{footerTrack?.title ?? "Nothing playing"}</span><span className="track-artist">{footerTrack?.artist ?? ""}</span></div>{footerTrack && <button className={`row-action visible ${favorites.includes(footerTrack.id) ? "selected" : ""}`} aria-label="Toggle favorite" onClick={() => toggleFavorite(footerTrack.id)}><Heart size={15} fill={favorites.includes(footerTrack.id) ? "currentColor" : "none"}/></button>}</div><div className="transport"><div className="transport-buttons"><button className={`transport-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={!tracks.length} onClick={() => void run(api.shuffle)}><Shuffle size={15}/></button><button className="transport-button" aria-label="Previous track" disabled={!tracks.length} onClick={() => void run(api.previous)}><SkipBack size={17} fill="currentColor"/></button><button className={`play-button ${player.isPlaying ? "is-playing" : ""}`} aria-label={player.isPlaying ? "Pause" : "Play"} disabled={!tracks.length} onClick={() => void run(current ? api.toggle : footerTrack ? () => api.play(footerTrack.id) : api.toggle)}>{player.isPlaying ? <Pause size={16} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</button><button className="transport-button" aria-label="Next track" disabled={!tracks.length} onClick={() => void run(api.next)}><SkipForward size={17} fill="currentColor"/></button><button className={`transport-button repeat-button repeat-control ${player.repeatMode !== "off" ? "active" : ""}`} aria-label={`Repeat ${player.repeatMode}`} disabled={!tracks.length} onClick={() => void run(api.repeat)}>↻{player.repeatMode === "one" && <small>1</small>}</button></div><div className="seek-row"><span>{time(seekPreviewMs ?? player.positionMs)}</span><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => setSeekPreviewMs(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><span>{time(player.durationMs)}</span></div></div><div className="player-options"><SleepTimerControl player={player} onSet={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))} placement="bar"/><button className="icon-button" aria-label={showPanel ? "Hide now playing panel" : "Show now playing panel"} onClick={() => setShowPanel(!showPanel)}>{showPanel ? <PanelRightClose size={17}/> : <PanelRightOpen size={17}/>}</button><button className="volume-mute-button" aria-label={player.volume === 0 ? "Unmute" : "Mute"} title={player.volume === 0 ? "Unmute" : "Mute"} onClick={toggleMute}>{player.volume === 0 ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button><input type="range" min="0" max="1" step="0.01" value={player.volume} style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))}/><button className={`transport-button full-mode-trigger ${fullMode ? "active" : ""}`} aria-label={fullMode ? "Exit full mode" : "Open full mode"} title={fullMode ? "Exit full mode" : "Full mode"} onClick={toggleFullMode}>{fullMode ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div></footer>
      {fullMode && <section className="full-player-mode" aria-label="Full mode player">
        <div className="full-mode-backdrop">{footerTrack && <Cover className="full-mode-blur" keys={[footerTrack.artworkKey]}/>}</div>
        <header className="full-mode-top"><span><AudioLines size={18}/> MichoPlay</span><div className="full-mode-top-actions"><SleepTimerControl player={player} onSet={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))} placement="full-mode"/><button className="full-mode-exit" onClick={toggleFullMode}><Minimize2 size={17}/>Exit full mode</button></div></header>
        <div className="full-mode-layout">
          <div className="full-mode-main">
            <div className="full-mode-art-wrap">{footerTrack ? <Cover className="full-mode-art" keys={[footerTrack.artworkKey]}/> : <div className="full-mode-art full-mode-art-empty"><Music2 size={60}/></div>}</div>
            <div className="full-mode-song"><div><strong>{footerTrack?.title ?? "Nothing playing"}</strong><span>{footerTrack?.artist ?? "Choose a song from your library"}</span></div>{footerTrack && <button className={`full-mode-favorite ${favorites.includes(footerTrack.id) ? "active" : ""}`} aria-label={favorites.includes(footerTrack.id) ? "Remove from favorites" : "Add to favorites"} onClick={() => toggleFavorite(footerTrack.id)}><Heart size={22} fill={favorites.includes(footerTrack.id) ? "currentColor" : "none"}/></button>}</div>
            <div className="full-mode-controls"><div className="full-mode-transport">
              <button className={`full-mode-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" onClick={() => void run(api.shuffle)}><Shuffle size={19}/></button>
              <button className="full-mode-control" aria-label="Previous track" onClick={() => void run(api.previous)}><SkipBack size={22} fill="currentColor"/></button>
              <button className="full-mode-play" aria-label={player.isPlaying ? "Pause" : "Play"} onClick={() => void run(current ? api.toggle : footerTrack ? () => api.play(footerTrack.id) : api.toggle)}>{player.isPlaying ? <Pause size={23} fill="currentColor"/> : <Play size={23} fill="currentColor"/>}</button>
              <button className="full-mode-control" aria-label="Next track" onClick={() => void run(api.next)}><SkipForward size={22} fill="currentColor"/></button>
              <button className={`full-mode-control ${player.repeatMode !== "off" ? "active" : ""}`} aria-label={`Repeat ${player.repeatMode}`} onClick={() => void run(api.repeat)}>↻{player.repeatMode === "one" && <small>1</small>}</button>
            </div>
            <div className="full-mode-seek"><span>{time(seekPreviewMs ?? player.positionMs)}</span><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => setSeekPreviewMs(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><span>{time(player.durationMs)}</span></div>
            <div className="full-mode-volume"><button className="volume-mute-button" aria-label={player.volume === 0 ? "Unmute" : "Mute"} title={player.volume === 0 ? "Unmute" : "Mute"} onClick={toggleMute}>{player.volume === 0 ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button><input type="range" min="0" max="1" step="0.01" value={player.volume} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))}/></div></div>
          </div>
          <aside className="full-mode-side"><div className="full-mode-tabs" role="tablist" aria-label="Full mode side panel"><button role="tab" aria-selected={fullPanelTab === "queue"} className={fullPanelTab === "queue" ? "active" : ""} onClick={() => setFullPanelTab("queue")}>Queue</button><button role="tab" aria-selected={fullPanelTab === "recent"} className={fullPanelTab === "recent" ? "active" : ""} onClick={() => setFullPanelTab("recent")}>Recently played</button></div>
            {fullPanelTab === "queue" ? <div className="full-mode-list"><h2>Now playing</h2>{footerTrack && <button className="full-mode-track current" onClick={() => { if (current) void run(api.toggle); }}><Cover className="full-mode-track-cover" keys={[footerTrack.artworkKey]}/><span><strong>{footerTrack.title}</strong><small>{footerTrack.artist}</small></span></button>}<h2>Up next</h2>{player.queue.map((id) => { const track = trackMap.get(id); return track ? <button className="full-mode-track" key={id} onClick={() => void run(() => api.play(id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button> : null; })}{!player.queue.length && <p className="full-mode-empty">Nothing queued</p>}</div> : <div className="full-mode-list"><h2>Recently played</h2>{recentTracks.map((track) => <button className="full-mode-track" key={track.id} onClick={() => void run(() => api.play(track.id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>)}{!recentTracks.length && <p className="full-mode-empty">Your listening history will appear here.</p>}</div>}
          </aside>
        </div>
      </section>}
    </section>
    {isAndroid && !mobilePlayerOpen && <>
      <div className="mobile-mini-player">
        <button className="mobile-mini-track" onClick={() => setMobilePlayerOpen(true)} disabled={!footerTrack}>{footerTrack && <Cover className="mobile-mini-cover" keys={[footerTrack.artworkKey]}/>}<span><strong>{footerTrack?.title ?? "Nothing playing"}</strong><small>{footerTrack?.artist ?? "Choose a song to start"}</small></span></button>
        {footerTrack && <><button className="mobile-mini-action" aria-label="Add to queue" onClick={() => void run(() => api.queueAdd(footerTrack.id))}><Plus size={22}/></button><button className="mobile-mini-play" aria-label={player.isPlaying ? "Pause" : "Play"} onClick={() => void run(current ? api.toggle : () => api.play(footerTrack.id))}>{player.isPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button></>}
      </div>
      <nav className="mobile-bottom-nav" aria-label="Main navigation">
        <button className={mobileTab === "home" && page.section !== "Settings" ? "active" : ""} onClick={() => { setMobileTab("home"); if (page.section !== "Home" || page.detail) navigate({ section: "Home" }); }}><Home size={22}/><span>Home</span></button>
        <button className={mobileTab === "search" ? "active" : ""} onClick={() => { setMobileTab("search"); setSearch(""); }}><Search size={22}/><span>Search</span></button>
        <button className={mobileTab === "library" ? "active" : ""} onClick={() => setMobileTab("library")}><Library size={22}/><span>Your Library</span></button>
        <button onClick={() => newPlaylist()}><Plus size={25}/><span>Create</span></button>
      </nav>
    </>}
    {isAndroid && mobilePlayerOpen && <section className="mobile-player-screen" aria-label="Now playing">
      <header className="mobile-player-top"><button aria-label="Close player" onClick={() => setMobilePlayerOpen(false)}><ChevronDown size={27}/></button><div><small>Playing from {page.detail?.kind === "playlist" ? "Playlist" : page.detail?.kind ?? "Your library"}</small><strong>{page.detail?.title ?? "Now playing"}</strong></div><button aria-label="Open queue" onClick={() => setMobileQueueOpen(true)}><ListMusic size={21}/></button></header>
      {footerTrack ? <>
        <Cover className="mobile-player-cover" keys={[footerTrack.artworkKey]}/>
        <div className="mobile-player-track"><div><strong>{footerTrack.title}</strong><span>{footerTrack.artist}</span></div><button className={favorites.includes(footerTrack.id) ? "favorite" : ""} aria-label="Toggle favorite" onClick={() => toggleFavorite(footerTrack.id)}><Heart size={24} fill={favorites.includes(footerTrack.id) ? "url(#michoplay-brand-gradient)" : "none"}/></button></div>
        <div className="mobile-seek"><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => setSeekPreviewMs(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><div><span>{time(seekPreviewMs ?? player.positionMs)}</span><span>{time(player.durationMs)}</span></div></div>
        <div className="mobile-player-controls"><button className={player.shuffle ? "active" : ""} aria-label="Shuffle" onClick={() => void run(api.shuffle)}><Shuffle size={22}/></button><button aria-label="Previous track" onClick={() => void run(api.previous)}><SkipBack size={27} fill="currentColor"/></button><button className="mobile-big-play" aria-label={player.isPlaying ? "Pause" : "Play"} onClick={() => void run(current ? api.toggle : () => api.play(footerTrack.id))}>{player.isPlaying ? <Pause size={28} fill="currentColor"/> : <Play size={28} fill="currentColor"/>}</button><button aria-label="Next track" onClick={() => void run(api.next)}><SkipForward size={27} fill="currentColor"/></button><button className={player.repeatMode !== "off" ? "active" : ""} aria-label={`Repeat ${player.repeatMode}`} onClick={() => void run(api.repeat)}>↻</button></div>
        <div className="mobile-player-actions"><button aria-label="Show queue" onClick={() => setMobileQueueOpen(true)}><ListMusic size={22}/></button></div>
      </> : <div className="mobile-player-empty"><Music2 size={36}/><strong>Nothing playing</strong><span>Choose a song from your library.</span><button onClick={() => { setMobilePlayerOpen(false); setMobileTab("library"); }}>Open library</button></div>}
    </section>}
    {isAndroid && mobileQueueOpen && <div className="mobile-sheet-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileQueueOpen(false); }}>
      <section className="mobile-queue-sheet" role="dialog" aria-modal="true" aria-label="Playback queue">
        <div className="mobile-sheet-handle"/><div className="mobile-queue-heading"><div><h2>Queue</h2><p>Playing {page.detail?.title ?? "from your library"}</p></div><button className="mobile-edit-queue" onClick={() => setMobileQueueEditing((editing) => !editing)}>{mobileQueueEditing ? "Done" : "Edit"}</button></div>
        <div className="mobile-queue-list">{footerTrack && <div className="mobile-queue-row current"><Cover className="mobile-queue-cover" keys={[footerTrack.artworkKey]}/><span><strong>{footerTrack.title}</strong><small>{footerTrack.artist}</small></span><span className="mobile-queue-state">{current ? "Playing" : "Last played"}</span></div>}{player.queue.map((id, index) => { const track = trackMap.get(id); return track ? <div className="mobile-queue-row" key={`${id}-${index}`}><button className="mobile-queue-song" onClick={() => void run(() => api.play(id))}><Cover className="mobile-queue-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>{mobileQueueEditing && <div className="mobile-queue-order"><button aria-label={`Move ${track.title} up`} disabled={index === 0} onClick={() => void run(() => api.queueMove(index, index - 1))}><ChevronUp size={18}/></button><button aria-label={`Move ${track.title} down`} disabled={index === player.queue.length - 1} onClick={() => void run(() => api.queueMove(index, index + 1))}><ChevronDown size={18}/></button></div>}</div> : null; })}{!footerTrack && !player.queue.length && <p className="mobile-queue-empty">Your queue is empty.</p>}</div>
        <div className="mobile-queue-tools"><button className={player.shuffle ? "active" : ""} onClick={() => void run(api.shuffle)}><Shuffle size={22}/><span>Shuffle</span></button><button className={player.repeatMode !== "off" ? "active" : ""} onClick={() => void run(api.repeat)}><span className="repeat-symbol">↻</span><span>Repeat</span></button><button className={player.sleepTimerRemainingMs ? "active" : ""} onClick={() => void run(() => api.sleepTimer(player.sleepTimerRemainingMs ? null : 30, false))}><Timer size={22}/><span>{player.sleepTimerRemainingMs ? "Timer on" : "Timer"}</span></button></div>
      </section>
    </div>}
    {menu && <>{isAndroid && <button className="mobile-sheet-backdrop" aria-label="Close song actions" onClick={() => setMenu(null)}/>}<div className={`action-menu track-menu ${isAndroid ? "mobile-action-sheet" : ""}`} role="menu" style={{ left: menu.x, top: menu.y }}>
      {isAndroid && <div className="mobile-action-heading"><div className="mobile-sheet-handle"/><div className="mobile-action-track"><Cover className="mobile-queue-cover" keys={[menu.track.artworkKey]}/><span><strong>{menu.track.title}</strong><small>{menu.track.artist}</small></span></div></div>}
      <div className="playlist-menu-wrap" onMouseEnter={() => setPlaylistSubmenu(true)}><button role="menuitem" aria-expanded={playlistSubmenu} onClick={() => setPlaylistSubmenu(!playlistSubmenu)}><Plus size={15}/>Add to playlist<ChevronRight size={14} className="menu-arrow"/></button>{playlistSubmenu && <div className={`playlist-submenu ${menu.x < 250 ? "opens-right" : ""}`}><label className="playlist-find"><Search size={15}/><input autoFocus placeholder="Find a playlist" aria-label="Find a playlist" value={playlistSearch} onChange={(event) => setPlaylistSearch(event.target.value)}/></label><button onClick={() => newPlaylist(menu.track)}><Plus size={15}/>New playlist</button><div className="menu-separator"/><div className="playlist-options">{playlists.filter((item) => item.name.toLocaleLowerCase().includes(playlistSearch.toLocaleLowerCase())).map((item) => <button key={item.id} onClick={() => addToPlaylist(item, menu.track)}><ListMusic size={15}/>{item.name}</button>)}</div>{!playlists.length && <p>Create your first playlist above.</p>}</div>}</div>{!isAndroid && <button role="menuitem" onClick={() => { shareTrack(menu.track); setMenu(null); }}><Share2 size={15}/>Share</button>}{selectedPlaylist && <button role="menuitem" onClick={() => confirmRemovePlaylistTrack(selectedPlaylist, menu.track)}><Trash2 size={15}/>Remove from playlist</button>}<button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart size={15}/>{favorites.includes(menu.track.id) ? "Remove from favorites" : "Save to favorites"}</button><button role="menuitem" onClick={() => { void run(() => api.queueAdd(menu.track.id)); setMenu(null); }}><ListMusic size={15}/>Add to queue</button><button role="menuitem" onClick={() => { playCollection(menu.track); setMenu(null); }}><Play size={15}/>Play now</button><div className="menu-separator"/><button role="menuitem" onClick={() => navigate({ section: "Artists", detail: { kind: "artist", key: menu.track.artist, title: menu.track.artist } })}><AudioLines size={15}/>Go to artist</button><button role="menuitem" onClick={() => navigate({ section: "Albums", detail: { kind: "album", key: albumKey(menu.track), title: menu.track.album } })}><Disc3 size={15}/>Go to album</button>
    </div></>}
    {youtubePreview && <div className="dialog-overlay youtube-preview-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setYoutubePreview(null); }}><section className="youtube-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="youtube-preview-title"><div className="youtube-preview-heading"><div><span>Preview</span><h2 id="youtube-preview-title">{youtubePreview.title}</h2></div><button className="icon-button" aria-label="Close preview" onClick={() => setYoutubePreview(null)}><X size={18}/></button></div><div className="youtube-preview-frame"><iframe src={youtubePreviewUrl(youtubePreview)} title={`Preview ${youtubePreview.title}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen/></div><div className="youtube-preview-actions"><span>{youtubePreview.isPlaylist ? "YouTube playlist" : "YouTube video"} · M4A audio</span><button className="primary-button" onClick={() => { void queueYoutubeDownload(youtubePreview); setYoutubePreview(null); }}><Download size={15}/>Download audio</button></div></section></div>}
    {aboutOpen && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title"><div className="about-dialog-head"><div className="about-product"><span className="about-mark"><AudioLines size={21}/></span><strong id="about-title">MichoPlay</strong></div><button className="icon-button" aria-label="Close About" onClick={() => setAboutOpen(false)}><X size={19}/></button></div><p className="about-caption">Desktop music player</p><div className="about-version"><span>Current version</span><strong>{appVersion}</strong></div></section></div>}
    {dialog && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}><form className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title" onSubmit={(event) => { event.preventDefault(); savePlaylist(); }}><div className="dialog-title"><h2 id="playlist-dialog-title">{dialog.playlist ? "Rename playlist" : "Create playlist"}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18}/></button></div><label>Playlist name<input autoFocus required maxLength={120} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)}/></label>{dialog.target && <p>“{dialog.target.title}” will be added.</p>}<button className="primary-button" type="submit" disabled={!playlistName.trim()}>{dialog.playlist ? "Save" : "Create playlist"}</button></form></div>}
    {confirmation && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message"><div className="dialog-title"><h2 id="confirm-title">{confirmation.title}</h2><button className="icon-button" aria-label="Cancel" onClick={() => setConfirmation(null)}><X size={18}/></button></div><p id="confirm-message">{confirmation.message}</p><div className="confirm-actions"><button className="outline-button" onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={confirmation.confirm}>{confirmation.label}</button></div></section></div>}
  </main>;
}

function EqualizerSettings({ bands, enabled, onChange, onToggle }: { bands: number[]; enabled: boolean; onChange: (bands: number[]) => void; onToggle: (enabled: boolean) => void }) {
  const presets = [
    { name: "Flat", bands: [0, 0, 0, 0, 0, 0] },
    { name: "Bass boost", bands: [6, 5, 3, 0, -1, 0] },
    { name: "Vocal", bands: [-3, -1, 2, 4, 2, -1] },
    { name: "Treble", bands: [-2, -1, 0, 1, 4, 5] },
    { name: "Rock", bands: [4, 3, -1, 1, 3, 4] },
  ];
  const [savedPresets, setSavedPresets] = useState<{ name: string; bands: number[] }[]>(() => stored("equalizer-presets", []));
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const allPresets = [...presets, ...savedPresets];
  const activePreset = allPresets.find((preset) => preset.bands.every((gain, index) => gain === bands[index]))?.name;
  const builtInName = (name: string) => presets.some((preset) => preset.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const updateBand = (index: number, value: number) => {
    const next = [...bands]; next[index] = Math.max(-12, Math.min(12, value)); onChange(next);
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name || builtInName(name)) return;
    const next = [...savedPresets.filter((preset) => preset.name.toLocaleLowerCase() !== name.toLocaleLowerCase()), { name, bands: [...bands] }];
    setSavedPresets(next); localStorage.setItem("michoplay-equalizer-presets", JSON.stringify(next));
    setPresetName(""); setSaving(false);
  };
  const chartX = (index: number) => 120 + index * 116;
  const chartY = (gain: number) => 25 + (12 - gain) * (175 / 24);
  const curve = bands.map((gain, index) => [chartX(index), chartY(gain)] as const);
  const smoothPath = curve.slice(1).reduce((path, [x, y], index) => {
    const [previousX, previousY] = curve[index]; const dx = (x - previousX) / 3;
    return `${path} C ${previousX + dx} ${previousY}, ${x - dx} ${y}, ${x} ${y}`;
  }, `M ${curve[0][0]} ${curve[0][1]}`);
  const fillPath = `M ${curve[0][0]} 112 L ${curve[0][0]} ${curve[0][1]}${smoothPath.slice(smoothPath.indexOf(" C"))} L ${curve[curve.length - 1][0]} 112 Z`;
  const updateFromPointer = (event: ReactPointerEvent<SVGSVGElement>, index: number) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgY = (event.clientY - bounds.top) * 250 / bounds.height;
    updateBand(index, Math.round(12 - (svgY - 25) * 24 / 175));
  };
  return <section className="eq-section">
    <header className="eq-header"><h2>Equalizer</h2><button className={`switch ${enabled ? "on" : ""}`} role="switch" aria-label="Equalizer" aria-checked={enabled} onClick={() => onToggle(!enabled)}><span/></button></header>
    <div className={`equalizer-settings ${enabled ? "" : "disabled"}`}>
      <div className="eq-toolbar"><label className="eq-select-wrap"><span className="sr-only">Equalizer preset</span><select aria-label="Equalizer preset" value={activePreset ?? "manual"} onChange={(event) => { const preset = allPresets.find((item) => item.name === event.target.value); if (preset) onChange([...preset.bands]); }}><option value="manual">Manual</option>{presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}{savedPresets.length > 0 && <optgroup label="My presets">{savedPresets.map((preset) => <option key={`saved-${preset.name}`} value={preset.name}>{preset.name}</option>)}</optgroup>}</select></label>
        {saving ? <form className="eq-save-form" onSubmit={(event) => { event.preventDefault(); savePreset(); }}><input autoFocus maxLength={40} value={presetName} aria-label="Preset name" placeholder="Preset name" onChange={(event) => setPresetName(event.target.value)}/><button type="submit" disabled={!presetName.trim() || builtInName(presetName)}>Save</button><button type="button" onClick={() => { setSaving(false); setPresetName(""); }}>Cancel</button></form> : <button className="eq-save-button" onClick={() => setSaving(true)}>Save preset</button>}
      </div>
      <div className="eq-chart-wrap"><svg className="eq-chart" viewBox="0 0 760 250" preserveAspectRatio="none" role="group" aria-label="Equalizer controls" onPointerMove={(event) => { if (dragging !== null) updateFromPointer(event, dragging); }} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
        <defs><linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#1ed760" stopOpacity=".62"/><stop offset="100%" stopColor="#1ed760" stopOpacity=".08"/></linearGradient></defs>
        <text className="eq-db-label" x="0" y="30">+12dB</text><text className="eq-db-label" x="0" y="205">−12dB</text>
        {curve.map(([x], index) => <line className="eq-gridline" key={`grid-${index}`} x1={x} x2={x} y1="25" y2="200"/>)}<line className="eq-zero-line" x1="65" x2="700" y1="112" y2="112"/>
        <path className="eq-fill" d={fillPath}/><path className="eq-line" d={smoothPath}/>
        {curve.map(([x, y], index) => <g key={equalizerFrequencies[index]}><circle className="eq-hit-target" cx={x} cy={y} r="17" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); setDragging(index); }}/><circle className="eq-point" cx={x} cy={y} r="4" role="slider" tabIndex={0} aria-label={equalizerFrequencies[index]} aria-valuemin={-12} aria-valuemax={12} aria-valuenow={bands[index]} aria-valuetext={`${bands[index]} dB`} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); updateBand(index, bands[index] + 1); } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); updateBand(index, bands[index] - 1); } }}/><text className="eq-frequency-label" x={x} y="232" textAnchor="middle">{equalizerFrequencies[index]}</text></g>)}
      </svg></div>
      <div className="eq-card-footer"><span>{enabled ? "Changes apply immediately to playback." : "Equalizer is off."}</span><button className="outline-button eq-reset" onClick={() => onChange([0, 0, 0, 0, 0, 0])}>Reset</button></div>
    </div>
  </section>;
}

function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-library"><h2>{title}</h2><p>{description}</p>{action}</div>;
}
function GlobalSearchResultButton({ result, onClick, isPlaying = false, showPlayHover = true }: { result: GlobalSearchResult; onClick: () => void; isPlaying?: boolean; showPlayHover?: boolean }) {
  const icon = result.type === "Song" ? <Music2 size={18}/> : result.type === "Artist" ? <AudioLines size={18}/> : result.type === "Folder" ? <FolderOpen size={18}/> : result.type === "Playlist" ? <ListMusic size={18}/> : <Disc3 size={18}/>;
  const hasPlaybackHover = showPlayHover && result.type === "Song";
  return <button className={`global-search-result ${hasPlaybackHover ? "has-playback-hover" : ""}`} role="option" aria-selected={false} aria-label={`${isPlaying ? "Pause" : "Play"} ${result.title}`} onClick={onClick}><Cover className={`global-search-cover ${result.type === "Artist" ? "artist-art" : ""}`} keys={[result.artworkKey]} icon={icon}/><span className="search-result-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span>{hasPlaybackHover && <span className="search-result-play" aria-hidden="true">{isPlaying ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</span>}</button>;
}
function CollectionGrid({ collections, kind, onOpen, onPlay, playingId, isPlaying = false }: { collections: Collection[]; kind: Detail["kind"]; onOpen: (collection: Collection) => void; onPlay?: (collection: Collection) => void; playingId?: number | null; isPlaying?: boolean }) {
  const icon = kind === "folder" ? <FolderOpen size={30}/> : kind === "artist" ? <AudioLines size={30}/> : kind === "playlist" ? <ListMusic size={30}/> : <Disc3 size={30}/>;
  return <div className={`media-grid collection-grid ${kind}-grid`}>{collections.map((item) => {
    const active = item.tracks.some((track) => track.id === playingId);
    return <article className={`media-card ${kind}-card ${active ? "playing" : ""}`} key={item.key}>
      <button className="collection-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}><Cover className="card-cover" keys={coverKeys(item.tracks)} icon={icon}/><strong title={item.title}>{item.title}</strong><small>{item.subtitle && kind === "album" ? `${item.subtitle} · ` : ""}{item.tracks.length} songs</small></button>
      {onPlay && item.tracks.length > 0 && <button className={`collection-play-button ${active && isPlaying ? "active" : ""}`} aria-label={`${active && isPlaying ? "Pause" : "Play"} ${item.title}`} title={active && isPlaying ? "Pause" : "Play"} onClick={() => onPlay(item)}>{active && isPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>}
    </article>;
  })}</div>;
}
function TrackRows({ items, player, favorites, playCounts, showPlayCount = false, onPlay, onFavorite, onMenu, emptyTitle, emptyMessage }: { items: Track[]; player: PlayerSnapshot; favorites: number[]; playCounts?: Map<number, number>; showPlayCount?: boolean; onPlay: (track: Track) => void; onFavorite: (id: number) => void; onMenu: (track: Track, event: MouseEvent) => void; emptyTitle: string; emptyMessage: string }) {
  const [dismissedPlayControl, setDismissedPlayControl] = useState<number | null>(null);
  return <div className="track-table" role="table" aria-label="Songs"><div className="table-head" role="row"><span role="columnheader">#</span><span role="columnheader">Title</span><span role="columnheader">Album</span><span role="columnheader">Artist</span><span role="columnheader"><Clock3 size={13}/></span></div>{items.length ? <div className="track-list" role="rowgroup">{items.map((track, index) => { const active = player.currentTrackId === track.id && player.isPlaying; const playCount = playCounts?.get(track.id) ?? 0; const playControlDismissed = dismissedPlayControl === track.id; const playTrack = () => { setDismissedPlayControl(track.id); onPlay(track); }; return <div role="row" key={track.id} className={`track-row ${player.currentTrackId === track.id ? "playing" : ""} ${playControlDismissed ? "suppress-row-play" : ""}`} onMouseLeave={() => { if (playControlDismissed) setDismissedPlayControl(null); }} onContextMenu={(event) => onMenu(track, event)}><button className="track-number" aria-label={`${active ? "Pause" : "Play"} ${track.title}`} onClick={playTrack}>{active ? <span className="playing-animation" aria-label="Playing"><i/><i/><i/></span> : <span className="row-index">{index + 1}</span>}{active ? <Pause className="row-play" size={15} fill="currentColor"/> : <Play className="row-play" size={15} fill="currentColor"/>}</button><div className="track-title-cell" role="cell"><Cover className="row-cover" keys={[track.artworkKey]}/><button className="track-name" onClick={playTrack}><strong>{track.title}</strong><small>{track.artist}{showPlayCount && playCount > 0 && <span className="track-play-count"> · {playCount} {playCount === 1 ? "play" : "plays"}</span>}</small></button></div><span className="track-album" role="cell">{track.album}</span><span className="track-artist-cell" role="cell">{track.artist}</span><span className="track-actions" role="cell"><button className={`row-action ${favorites.includes(track.id) ? "selected" : ""}`} aria-label={favorites.includes(track.id) ? "Remove from favorites" : "Add to favorites"} onClick={() => onFavorite(track.id)}><Heart size={15} fill={favorites.includes(track.id) ? "currentColor" : "none"}/></button><span className="track-duration">{time(track.durationMs)}</span><button className="row-action menu-trigger" aria-label={`Actions for ${track.title}`} onClick={(event) => onMenu(track, event)}><MoreHorizontal size={17}/></button></span></div>;})}</div> : <Empty title={emptyTitle} description={emptyMessage}/>}</div>;
}
function SettingsPage({ roots, player, equalizerBands, equalizerEnabled, compact, showPanel, keepScreenAwake, onKeepScreenAwake, scanning, mobile, zoomLevel, onZoom, onEqualizer, onEqualizerToggle, onCompact, onPanel, onAdd, onRemove, onRefresh, onVolume, onAutoplay, onSleepTimer, onDefaultPlayer }: { roots: string[]; player: PlayerSnapshot; equalizerBands: number[]; equalizerEnabled: boolean; compact: boolean; showPanel: boolean; keepScreenAwake: boolean; onKeepScreenAwake: (value: boolean) => void; scanning: boolean; mobile: boolean; zoomLevel: number; onZoom: (value: number) => void; onEqualizer: (bands: number[]) => void; onEqualizerToggle: (enabled: boolean) => void; onCompact: (value: boolean) => void; onPanel: (value: boolean) => void; onAdd: () => void; onRemove: (root: string) => void; onRefresh: () => void; onVolume: (value: number) => void; onAutoplay: (value: boolean) => void; onSleepTimer: (minutes: number | null, atTrackEnd: boolean) => void; onDefaultPlayer: () => void }) {
  const timerValue = player.sleepTimerAtTrackEnd ? "track" : player.sleepTimerRemainingMs ? String(Math.max(1, Math.ceil(player.sleepTimerRemainingMs / 60_000 / 15) * 15)) : "off";
  const remaining = player.sleepTimerRemainingMs == null ? "" : `${Math.floor(player.sleepTimerRemainingMs / 60_000)}:${String(Math.floor((player.sleepTimerRemainingMs % 60_000) / 1000)).padStart(2, "0")}`;
  const toggle = (title: string, description: string, value: boolean, change: (value: boolean) => void) => <div className="setting-row"><div><strong>{title}</strong><small>{description}</small></div><button className={`switch ${value ? "on" : ""}`} role="switch" aria-label={title} aria-checked={value} onClick={() => change(!value)}><span/></button></div>;
  return <div className="settings-page"><div className="settings-title"><h1>Settings</h1></div><section className="settings-group"><h2>Playback</h2>{toggle("Autoplay", "Continue with the next song when playback ends.", player.autoplay, onAutoplay)}
    <EqualizerSettings bands={equalizerBands} enabled={equalizerEnabled} onChange={onEqualizer} onToggle={onEqualizerToggle}/><div className="setting-row sleep-timer-row"><div><strong>Sleep timer</strong><small>{player.sleepTimerAtTrackEnd ? "Playback will stop at the end of this song." : remaining ? `Playback stops in ${remaining}.` : "Stop playback after a set time or at the end of a song."}</small></div><select className="sleep-timer-select" aria-label="Sleep timer" value={timerValue} onChange={(event) => { const value = event.target.value; onSleepTimer(value === "off" || value === "track" ? null : Number(value), value === "track"); }}><option value="off">Off</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="track" disabled={!player.currentTrackId}>End of current song</option></select></div>
    {mobile && <div className="setting-row"><div><strong>Background playback</strong><small>Keep playing with lock-screen and notification controls.</small></div><span className="setting-value">On</span></div>}<div className="setting-row"><div><strong>Volume</strong><small>Audio output level</small></div><div className="settings-volume"><input type="range" min="0" max="1" step="0.01" value={player.volume} style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} aria-label="Playback volume" onChange={(event) => onVolume(Number(event.target.value))}/><span className="setting-value">{Math.round(player.volume * 100)}%</span></div></div></section>
    <section className="settings-group zoom-settings"><h2>Zoom level</h2><p className="zoom-description">Adjusting the zoom level can help you make the most of MichoPlay and adapt it to your preferences or needs.</p><p className="zoom-shortcuts">Keyboard controls are listed below.</p><div className="zoom-control"><div className="zoom-landmarks"><button className="zoom-landmark" onClick={() => onZoom(70)} aria-label="Set zoom to 70 percent"><span className="zoom-preview dense" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i}/>)}</span><span>Dense</span></button><button className="zoom-landmark" onClick={() => onZoom(100)} aria-label="Set zoom to 100 percent"><span className="zoom-preview default" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i}/>)}</span><span>Default</span></button><button className="zoom-landmark" onClick={() => onZoom(130)} aria-label="Set zoom to 130 percent"><span className="zoom-preview spacious" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</span><span>Spacious</span></button></div><input className="zoom-range" type="range" min="70" max="130" step="10" value={zoomLevel} style={{ "--zoom-progress": `${(zoomLevel - 70) / 60 * 100}%` } as CSSProperties} aria-label="Zoom level" aria-valuetext={`${zoomLevel}%`} onChange={(event) => onZoom(Number(event.target.value))}/><div className="zoom-ticks" aria-hidden="true">{[70, 80, 90, 100, 110, 120, 130].map((value) => <span key={value} className={zoomLevel === value ? "active" : ""}>{value}%</span>)}</div><div className="zoom-reset-row"><button className="outline-button" onClick={() => onZoom(100)}>Reset</button></div></div></section>
    <section className="settings-group shortcuts-settings"><h2>Keyboard shortcuts</h2><div className="shortcut-list">{keyboardShortcuts.map(({ action, keys }) => <div className="shortcut-row" key={action}><span>{action}</span><span className="shortcut-keys">{keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}</span></div>)}</div></section><section className="settings-group"><h2>Your library</h2><div className="setting-row"><div><strong>{mobile ? "Imported music" : "Music folders"}</strong><small>{mobile ? "Imported audio is copied into MichoPlay storage for future sessions." : "Music is scanned recursively inside each root."}</small></div><button className="outline-button" disabled={scanning} onClick={onAdd}><Plus size={15}/>{mobile ? "Import audio" : "Add folder"}</button></div>{roots.map((root) => <div className="root-row" key={root}><FolderOpen size={17}/><span title={root}>{root}</span><button className="icon-button" disabled={scanning} aria-label={`Remove ${root} from library`} onClick={() => onRemove(root)}><Trash2 size={15}/></button></div>)}{!roots.length && <p className="no-roots">No music folders added.</p>}<button className="outline-button refresh-button" disabled={scanning || !roots.length} onClick={onRefresh}><RefreshCw size={14}/>{scanning ? "Refreshing…" : "Refresh library"}</button></section><section className="settings-group"><h2>System integration</h2><div className="setting-row"><div><strong>Default music player</strong><small>{mobile ? "Choose MichoPlay from Android’s Open with menu, then select Always to make it the default." : "MichoPlay can open audio files from your file manager. Installed desktop builds register common audio formats."}</small></div><button className="outline-button" onClick={onDefaultPlayer}>{mobile ? "How to set default" : "Set as default"}</button></div></section><section className="settings-group"><h2>Display</h2>{toggle("Now playing panel", "Show artwork and the adjustable playback queue.", showPanel, onPanel)}{toggle("Keep screen awake in full mode", "Prevent the display from sleeping while the full player is open. Enabled by default.", keepScreenAwake, onKeepScreenAwake)}{toggle("Compact song list", "Fit more songs in the library view.", compact, onCompact)}</section></div>;
}
