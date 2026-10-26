import { Fragment, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion, onBackButtonPress } from "@tauri-apps/api/app";
import {
  AudioLines, Disc3, Heart, Home, ListMusic, Music2, Play, Plus, Search, Shuffle,
  SkipBack, SkipForward, Volume2, VolumeX, Settings2, MoreHorizontal, FolderOpen, Pause,
  Trash2, X, PanelRightClose, PanelRightOpen, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, GripVertical, RefreshCw, Pencil, Clock3, Youtube,
  ListFilter, List, AlignJustify, Check, Library, Timer, Share2, Download,
  Maximize2, Minimize2, MoreVertical, Github, Globe2, Bug,
} from "lucide-react";
import { api } from "../lib/api";
import type { PlayerSnapshot, Track, YoutubeDownload, YoutubeSearchResult } from "../lib/api";
import { youtubeDownloadErrorText, youtubeDownloadProgressText, youtubeResultSizeText } from "../lib/youtube-size";
import { Cover, useArtwork } from "./Artwork";
import packageInfo from "../../package.json";

type Section = "Home" | "Songs" | "Albums" | "Artists" | "Playlists" | "Favorites" | "Recently Played" | "Settings";
type Detail = { kind: "folder" | "album" | "artist" | "playlist"; key: string; title: string };
type Page = { section: Section; detail?: Detail };
type Playlist = { id: string; name: string; trackIds: number[] };
type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type TrackMenu = { track: Track; x: number; y: number };
function playlistSubmenuPlacement(menuX: number) {
  const menuWidth = 228;
  const submenuWidth = 256;
  const gap = 5;
  const edge = 8;
  if (menuX + menuWidth + gap + submenuWidth <= window.innerWidth - edge) return "opens-right";
  if (menuX - gap - submenuWidth >= edge) return "";
  return "submenu-inline";
}
type ListeningRecord = { trackId: number; lastPlayedAt: number; playCount: number; positionMs: number; durationMs: number };
type SavedPlaybackSession = { currentTrackId: number | null; queue: number[]; positionMs: number; isPlaying: boolean };
type GlobalSearchResult = { type: "Song" | "Folder" | "Album" | "Artist" | "Playlist"; title: string; subtitle: string; artworkKey: string | null; trackId?: number; page?: Page };
type TrackSort = "custom" | "title" | "artist" | "album" | "recentlyAdded" | "releaseDate" | "duration";
const trackSortOptions: { key: TrackSort; label: string }[] = [
  { key: "custom", label: "Custom order" }, { key: "title", label: "Title" }, { key: "artist", label: "Artist" },
  { key: "album", label: "Album" }, { key: "recentlyAdded", label: "Recently added" },
  { key: "releaseDate", label: "Release date" }, { key: "duration", label: "Duration" },
];
const latestReleaseApiUrl = "https://api.github.com/repos/namz182/michoplay/releases/latest";
const releasesPageUrl = "https://github.com/namz182/michoplay/releases";
const michoplayGithubUrl = "https://github.com/namz182/michoplay";
const michoplayIssueUrl = "https://github.com/namz182/michoplay/issues/new";
const michoplayDeveloperUrl = "https://mainza.dev";
const michoplayWebsiteUrl = "https://michoplay.mainza.dev/";
const youtubeSearchPageSize = 15;
const youtubeGlobalInitialResultLimit = youtubeSearchPageSize;
const youtubeFolderInitialResultLimit = youtubeSearchPageSize;
function isNewerVersion(candidate: string, current: string) {
  const parts = (version: string) => {
    const normalized = version.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
    if (!/^\d+(\.\d+)*$/.test(normalized)) return null;
    return normalized.split(".").map(Number);
  };
  const latest = parts(candidate);
  const installed = parts(current);
  if (!latest || !installed) return false;
  for (let index = 0; index < Math.max(latest.length, installed.length); index += 1) {
    const difference = (latest[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
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
const initialPlayer: PlayerSnapshot = { currentTrackId: null, isPlaying: false, positionMs: 0, durationMs: 0, volume: 0.75, shuffle: false, repeatMode: "off", queue: [], priorityQueue: [], autoplay: true, sleepTimerRemainingMs: null, sleepTimerAtTrackEnd: false, equalizerBands: Array(6).fill(0), equalizerEnabled: false };
const equalizerFrequencies = ["60Hz", "150Hz", "400Hz", "1KHz", "2.4KHz", "15KHz"];
function stored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`michoplay-${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
function storedLibraryRoots(): string[] {
  const roots = stored<unknown>("library-roots", []);
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string" && !root.startsWith("content://"))
    : [];
}
function time(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function sleepTimerLabel(ms: number) { const seconds = Math.ceil(Math.max(0, ms) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`; }
function durationLabel(seconds: number) { const safeSeconds = Math.max(0, Math.floor(seconds)); return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`; }
function youtubeDownloadDescription(item: YoutubeDownload) {
  if (["queued", "downloading", "paused"].includes(item.status)) return youtubeDownloadProgressText(item);
  if (item.status === "completed") return youtubeDownloadProgressText(item);
  if (item.status === "failed") return youtubeDownloadErrorText(item.message, item.isPlaylist);
  return item.message;
}
function isFinishedYoutubeDownload(item: YoutubeDownload) {
  return item.status === "completed" || item.status === "failed" || item.status === "cancelled";
}
function youtubeResultSize(result: YoutubeSearchResult) {
  return youtubeResultSizeText(result.durationSeconds, result.isPlaylist);
}
function youtubeSearchCanContinue(query: string, count: number) {
  return count > 0 && !/^https?:\/\//i.test(query.trim());
}
function normalizeZoom(value: number) { return Math.max(70, Math.min(130, Math.round(value / 10) * 10)); }
function initialZoomLevel() {
  const android = /android/i.test(navigator.userAgent);
  const saved = stored<number | null>("zoom-level", null);
  const userSelected = localStorage.getItem("michoplay-zoom-level-customized") === "true";
  // Older builds persisted the implicit 100% default, so migrate that value once
  // on Android while preserving any zoom preference saved by the user.
  if (android && !userSelected && (saved === null || saved === 100)) return 120;
  return normalizeZoom(saved ?? (android ? 120 : 100));
}
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
  const [roots, setRoots] = useState<string[]>(storedLibraryRoots);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [player, setPlayer] = useState<PlayerSnapshot>(initialPlayer);
  const lastAudibleVolume = useRef(Math.max(0.01, stored("volume", 0.75)));
  const [fullMode, setFullMode] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileAboutOpen, setMobileAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(packageInfo.version);
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null);
  const [fullPanelTab, setFullPanelTab] = useState<"queue" | "browse">("queue");
  const [fullBrowseTab, setFullBrowseTab] = useState<"playlists" | "library">("playlists");
  const [fullBrowsePlaylistId, setFullBrowsePlaylistId] = useState<string | null>(null);
  const [fullBrowseVisibleLimit, setFullBrowseVisibleLimit] = useState(100);
  const [keepScreenAwake, setKeepScreenAwake] = useState(() => stored("keep-screen-awake-in-full-mode", false));
  const [equalizerBands, setEqualizerBands] = useState<number[]>(() => {
    const saved = stored<number[]>("equalizer-bands", Array(6).fill(0));
    if (!Array.isArray(saved)) return Array(6).fill(0);
    const migrated = saved.length === 10 ? [saved[1], (saved[2] + saved[3]) / 2, saved[4], saved[5], (saved[6] + saved[7]) / 2, saved[9]] : saved;
    return migrated.length === 6 ? migrated.map((value) => Math.max(-12, Math.min(12, Number(value) || 0))) : Array(6).fill(0);
  });
  const [equalizerEnabled, setEqualizerEnabled] = useState(() => stored("equalizer-enabled", false));
  const [favorites, setFavorites] = useState<number[]>(() => stored("favorites", []));
  const [playlists, setPlaylists] = useState<Playlist[]>(() => stored("playlists", []));
  const [listeningHistory, setListeningHistory] = useState<ListeningRecord[]>(() => stored("listening-history", []));
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const seekCommitTimer = useRef<number | null>(null);
  const seekCommitVersion = useRef(0);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [globalYoutubeSearchEnabled, setGlobalYoutubeSearchEnabled] = useState(() => stored("global-youtube-search-enabled", true));
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [globalYoutubeResults, setGlobalYoutubeResults] = useState<YoutubeSearchResult[]>([]);
  const [globalYoutubeSearching, setGlobalYoutubeSearching] = useState(false);
  const [globalYoutubeError, setGlobalYoutubeError] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    const saved = stored<unknown>("recent-searches", []);
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string").slice(0, 8) : [];
  });
  const [inlineSearch, setInlineSearch] = useState("");
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ phase: string; processed: number; total: number } | null>(null);
  const [startupLoading, setStartupLoading] = useState(() => isTauri());
  const [startupPhase, setStartupPhase] = useState("Preparing your library…");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ phase: string; processed: number; total: number }>("library-scan-progress", ({ payload }) => {
      if (!active) return;
      if (["Complete", "Cancelled", "Failed"].includes(payload.phase)) setScanProgress(null);
      else setScanProgress(payload);
    }).then((dispose) => { unlisten = dispose; if (!active) dispose(); });
    return () => { active = false; unlisten?.(); };
  }, []);
  const [menu, setMenu] = useState<TrackMenu | null>(null);
  const appFrameRef = useRef<HTMLElement>(null);
  const trackMenuRef = useRef<HTMLDivElement>(null);
  const playlistSubmenuRef = useRef<HTMLDivElement>(null);
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
  const [mobileTab, setMobileTab] = useState<"home" | "search" | "library" | "youtube" | "downloads">("home");
  const [mobileHomeFilter, setMobileHomeFilter] = useState<"All" | "Folders" | "Albums">("All");
  const [mobileLibraryActionsOpen, setMobileLibraryActionsOpen] = useState(false);
  const [sidebarLibrarySearch, setSidebarLibrarySearch] = useState("");
  const [sidebarLibrarySort, setSidebarLibrarySort] = useState<"recent" | "az">("recent");
  const [mobilePlayerOpen, setMobilePlayerOpen] = useState(false);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const [mobileQueueEditing, setMobileQueueEditing] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [mobileSleepTimerOpen, setMobileSleepTimerOpen] = useState(false);
  const [addSongsPlaylistId, setAddSongsPlaylistId] = useState<string | null>(null);
  const [addSongsSelected, setAddSongsSelected] = useState<number[]>([]);
  const [addSongsSearch, setAddSongsSearch] = useState("");
  const [addSongsVisibleLimit, setAddSongsVisibleLimit] = useState(100);
  const mobileSheetDragStartY = useRef<number | null>(null);
  const mobileTrackSwipeStartX = useRef<number | null>(null);
  const [youtubeDirectory, setYoutubeDirectory] = useState("");
  const [youtubeFolderScanned, setYoutubeFolderScanned] = useState(false);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeSearching, setYoutubeSearching] = useState(false);
  const [youtubeSearchError, setYoutubeSearchError] = useState("");
  const [youtubeResults, setYoutubeResults] = useState<YoutubeSearchResult[]>([]);
  const [youtubeVisibleLimit, setYoutubeVisibleLimit] = useState(youtubeFolderInitialResultLimit);
  const [youtubeHasMore, setYoutubeHasMore] = useState(false);
  const [youtubeLoadingMore, setYoutubeLoadingMore] = useState(false);
  const [youtubeDownloads, setYoutubeDownloads] = useState<YoutubeDownload[]>([]);
  const [globalYoutubeDownloadRequested, setGlobalYoutubeDownloadRequested] = useState<string[]>([]);
  const [globalYoutubeVisibleLimit, setGlobalYoutubeVisibleLimit] = useState(youtubeGlobalInitialResultLimit);
  const [globalYoutubeHasMore, setGlobalYoutubeHasMore] = useState(false);
  const [globalYoutubeLoadingMore, setGlobalYoutubeLoadingMore] = useState(false);
  const [completedDownloadTrackIds, setCompletedDownloadTrackIds] = useState<Record<string, number[]>>({});
  const [zoomLevel, setZoomLevel] = useState(initialZoomLevel);
  const [draggedQueue, setDraggedQueue] = useState<number | null>(null);
  const [queueDrop, setQueueDrop] = useState<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const lastStartedTrack = useRef<number | null>(null);
  const playbackRestoreStarted = useRef(false);
  const playbackRestoreComplete = useRef(false);
  const lastPlaybackSaveAt = useRef(0);
  const latestPlayerSnapshot = useRef<PlayerSnapshot>(initialPlayer);
  const youtubeSearchVersion = useRef(0);
  const globalYoutubeSearchVersion = useRef(0);
  const youtubeSearchCache = useRef(new Map<string, { results: YoutubeSearchResult[]; savedAt: number; hasMore?: boolean }>());
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const completedYoutubeDownloads = useRef(new Set<string>());
  const isAndroid = useMemo(() => /android/i.test(navigator.userAgent), []);
  useLayoutEffect(() => {
    if (!menu || isAndroid) return;
    const menuElement = trackMenuRef.current;
    if (!menuElement) return;
    const menuTop = Math.max(8, Math.min(menu.y, window.innerHeight - menuElement.offsetHeight - 8));
    menuElement.style.top = `${menuTop}px`;
    const submenu = playlistSubmenuRef.current;
    if (!submenu || submenu.classList.contains("submenu-inline")) return;
    const bounds = submenu.getBoundingClientRect();
    const adjustment = bounds.bottom > window.innerHeight - 8
      ? window.innerHeight - 8 - bounds.bottom
      : bounds.top < 8 ? 8 - bounds.top : 0;
    submenu.style.transform = `translateY(${adjustment}px)`;
  }, [menu, playlistSubmenu, isAndroid]);
  useEffect(() => {
    if (!menu || isAndroid) return;
    const closeOnResize = () => setMenu(null);
    window.addEventListener("resize", closeOnResize);
    return () => window.removeEventListener("resize", closeOnResize);
  }, [menu, isAndroid]);
  const clearableYoutubeDownloads = youtubeDownloads.some(isFinishedYoutubeDownload);
  const selectedPlaylist = page.detail?.kind === "playlist" ? playlists.find((item) => item.id === page.detail?.key) : undefined;
  const addSongsSearchTerm = addSongsSearch.trim().toLocaleLowerCase();
  const youtubePlaylist = playlists.find((item) => item.name.trim().toLocaleLowerCase() === "youtube");
  const isYoutubePlaylist = selectedPlaylist?.name.trim().toLocaleLowerCase() === "youtube";

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
    const version = ++seekCommitVersion.current;
    if (seekCommitTimer.current !== null) {
      window.clearTimeout(seekCommitTimer.current);
      seekCommitTimer.current = null;
    }
    const target = Math.max(0, Math.min(player.durationMs, positionMs));
    setSeekPreviewMs(target);
    try {
      await api.seek(target);
      setPlayer(await api.state());
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      if (seekCommitVersion.current === version) setSeekPreviewMs(null);
    }
  }
  function previewSeek(positionMs: number) {
    const target = Math.max(0, Math.min(player.durationMs, positionMs));
    setSeekPreviewMs(target);
    if (seekCommitTimer.current !== null) window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = window.setTimeout(() => {
      seekCommitTimer.current = null;
      void commitSeek(target);
    }, 180);
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
    try {
      const scanned = await api.refresh(folders);
      setTracks(scanned); setPlayer(await api.state());
      if (youtubeDirectory && folders.includes(youtubeDirectory)) setYoutubeFolderScanned(true);
    }
    catch (error) { setMessage(String(error)); }
    finally { setScanning(false); }
  }, [roots, youtubeDirectory]);
  const syncYoutubeLibrary = useCallback(async () => {
    if (!isTauri() || !youtubeDirectory) return [];
    const nextRoots = [...new Set([...roots, youtubeDirectory])];
    const knownIds = new Set(tracks.filter((track) => track.rootPath === youtubeDirectory).map((track) => track.id));
    setScanning(true);
    try {
      const scanned = await api.refresh(nextRoots);
      setRoots(nextRoots); setTracks(scanned); setPlayer(await api.state());
      setYoutubeFolderScanned(true);
      const newIds = scanned.filter((track) => track.rootPath === youtubeDirectory && !knownIds.has(track.id)).map((track) => track.id);
      if (newIds.length) setMessage(`Saved ${newIds.length} ${newIds.length === 1 ? "song" : "songs"} to Music/YouTube`);
      return newIds;
    } catch (error) { setMessage(String(error)); return []; }
    finally { setScanning(false); }
  }, [youtubeDirectory, roots, tracks]);
  useEffect(() => {
    if (!youtubeDirectory || !youtubeFolderScanned) return;
    const folderTrackIds = tracks.filter((track) => track.rootPath === youtubeDirectory).map((track) => track.id);
    setPlaylists((prior) => {
      const existing = prior.find((item) => item.name.trim().toLocaleLowerCase() === "youtube");
      if (!existing) return [{ id: "michoplay-youtube", name: "YouTube", trackIds: folderTrackIds }, ...prior];
      if (existing.trackIds.length === folderTrackIds.length && existing.trackIds.every((id, index) => id === folderTrackIds[index])) return prior;
      return prior.map((item) => item.id === existing.id ? { ...item, trackIds: folderTrackIds } : item);
    });
  }, [tracks, youtubeDirectory, youtubeFolderScanned]);
  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  }, []);
  useEffect(() => {
    if (!isTauri() || !appVersion) return;
    let active = true;
    let controller: AbortController | undefined;
    let requestId = 0;
    const checkForUpdate = async () => {
      if (!active || !navigator.onLine) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const currentRequest = ++requestId;
      const timeout = window.setTimeout(() => requestController.abort(), 8000);
      try {
        const response = await fetch(latestReleaseApiUrl, {
          headers: { Accept: "application/vnd.github+json" },
          signal: requestController.signal,
        });
        if (!response.ok) return;
        const release: unknown = await response.json();
        if (!active || currentRequest !== requestId) return;
        if (!release || typeof release !== "object" || !("tag_name" in release)) return;
        const tag = (release as { tag_name?: unknown }).tag_name;
        if (typeof tag !== "string") return;
        const latestVersion = tag.trim().replace(/^v/i, "");
        if (!isNewerVersion(latestVersion, appVersion)) {
          setAvailableUpdate(null);
          return;
        }
        if (stored("dismissed-update-version", "") === latestVersion) setAvailableUpdate(null);
        else setAvailableUpdate(latestVersion);
      } catch {
        // Update checks are optional; stay quiet when offline or GitHub is unavailable.
      } finally {
        window.clearTimeout(timeout);
      }
    };
    const onOnline = () => { void checkForUpdate(); };
    void checkForUpdate();
    const interval = window.setInterval(() => { void checkForUpdate(); }, 12 * 60 * 60 * 1000);
    window.addEventListener("online", onOnline);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [appVersion]);
  useEffect(() => {
    if (!isTauri()) return;
    void api.volume(stored("volume", 0.75));
    void api.autoplay(stored("autoplay", true));
    void api.equalizer(equalizerBands, equalizerEnabled);
    // Restore library and playback preferences once on launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!isTauri()) { setStartupLoading(false); return; }
    let active = true;
    setStartupPhase("Preparing your library…");
    void api.youtubeMusicDirectory().then(async (directory) => {
      if (!active) return;
      setStartupPhase("Loading saved music…");
      const savedRoots = await api.librarySavedRoots().catch(() => []);
      const discoveredRoots = isAndroid ? await api.discoverMusicFolders().catch((error) => {
        if (active) setMessage(String(error));
        return [];
      }) : [];
      if (!active) return;
      setYoutubeDirectory(directory);
      setYoutubeFolderScanned(false);
      const nextRoots = [...new Set([...(savedRoots.length ? savedRoots : roots), ...discoveredRoots, directory])];
      setRoots(nextRoots);
      setPlaylists((prior) => prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube")
        ? prior
        : [{ id: "michoplay-youtube", name: "YouTube", trackIds: [] }, ...prior]);
      try {
        setStartupPhase("Loading cached songs…");
        const cached = await api.cachedTracks().catch(() => []);
        if (!active) return;
        if (cached.length) {
          setTracks(cached);
          setStartupLoading(false);
        }
        setStartupPhase("Scanning music and artwork…");
        setScanning(true);
        const scanned = await api.refresh(nextRoots);
        if (!active) return;
        setTracks(scanned);
        setPlayer(await api.state());
        setYoutubeFolderScanned(true);
      } catch (error) {
        if (active) setMessage(String(error));
      } finally {
        if (active) setScanning(false);
        if (active) setStartupLoading(false);
      }
    }).catch((error) => { if (active) { setMessage(String(error)); setStartupLoading(false); } });
    return () => { active = false; };
  }, [isAndroid]);
  useEffect(() => {
    if (!startupLoading) return;
    const timeout = window.setTimeout(() => {
      setStartupLoading(false);
      setMessage("The library is still loading in the background.");
    }, 20_000);
    return () => window.clearTimeout(timeout);
  }, [startupLoading]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const applyDownloads = (items: YoutubeDownload[]) => {
      if (!active) return;
      setYoutubeDownloads(items);
      setGlobalYoutubeDownloadRequested((prior) => prior.filter((url) => !items.some((item) => item.url === url && (item.status === "failed" || item.status === "cancelled"))));
      const newlyCompletedIds = items.filter((item) => item.status === "completed" && !completedYoutubeDownloads.current.has(item.id)).map((item) => item.id);
      items.filter((item) => item.status === "completed").forEach((item) => completedYoutubeDownloads.current.add(item.id));
      if (newlyCompletedIds.length) void syncYoutubeLibrary().then((trackIds) => {
        if (!trackIds.length) return;
        setCompletedDownloadTrackIds((prior) => ({ ...prior, ...Object.fromEntries(newlyCompletedIds.map((id) => [id, trackIds])) }));
      });
    };
    void api.youtubeDownloadsState().then((items) => {
      if (!active) return;
      setYoutubeDownloads(items);
      completedYoutubeDownloads.current = new Set(items.filter((item) => item.status === "completed").map((item) => item.id));
    }).catch(() => {});
    const poll = isAndroid ? window.setInterval(() => {
      void api.youtubeDownloadsState().then(applyDownloads).catch(() => {});
    }, 1500) : undefined;
    if (!isAndroid) {
      void listen<YoutubeDownload[]>("youtube-downloads-updated", ({ payload }) => applyDownloads(payload)).then((dispose) => { unlisten = dispose; });
    }
    return () => { active = false; if (poll !== undefined) window.clearInterval(poll); unlisten?.(); };
  }, [isAndroid, syncYoutubeLibrary]);
  useEffect(() => {
    if (!isYoutubePlaylist) return;
    const query = youtubeQuery.trim();
    const version = ++youtubeSearchVersion.current;
    if (!query) {
      setYoutubeResults([]); setYoutubeVisibleLimit(youtubeFolderInitialResultLimit); setYoutubeHasMore(false); setYoutubeSearchError(""); setYoutubeSearching(false);
      return;
    }
    const cached = youtubeSearchCache.current.get(query.toLocaleLowerCase());
    if (cached && Date.now() - cached.savedAt < 60_000) {
      const hasMore = cached.hasMore ?? youtubeSearchCanContinue(query, cached.results.length);
      setYoutubeResults(cached.results); setYoutubeVisibleLimit(hasMore ? youtubeFolderInitialResultLimit : cached.results.length); setYoutubeHasMore(hasMore); setYoutubeSearchError(""); setYoutubeSearching(false);
      return;
    }
    if (!browserOnline) {
      setYoutubeResults([]); setYoutubeVisibleLimit(youtubeFolderInitialResultLimit); setYoutubeHasMore(false); setYoutubeSearchError("YouTube search needs an internet connection."); setYoutubeSearching(false);
      return;
    }
    setYoutubeSearching(true); setYoutubeSearchError(""); setYoutubeResults([]); setYoutubeVisibleLimit(youtubeFolderInitialResultLimit); setYoutubeHasMore(false);
    const timer = window.setTimeout(() => {
      void api.youtubeSearch(query, youtubeSearchPageSize, 0).then((results) => {
        if (youtubeSearchVersion.current !== version) return;
        const hasMore = youtubeSearchCanContinue(query, results.length);
        setYoutubeResults(results); setYoutubeVisibleLimit(youtubeFolderInitialResultLimit); setYoutubeHasMore(hasMore);
        youtubeSearchCache.current.set(query.toLocaleLowerCase(), { results, hasMore, savedAt: Date.now() });
      }).catch(() => {
        if (youtubeSearchVersion.current === version) { setYoutubeResults([]); setYoutubeVisibleLimit(youtubeFolderInitialResultLimit); setYoutubeHasMore(false); setYoutubeSearchError(navigator.onLine ? "Couldn't search YouTube. Try again." : "YouTube search needs an internet connection."); }
      }).finally(() => { if (youtubeSearchVersion.current === version) setYoutubeSearching(false); });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [youtubeQuery, isYoutubePlaylist, browserOnline]);
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    const query = search.trim();
    const version = ++globalYoutubeSearchVersion.current;
    if (!isTauri() || !globalYoutubeSearchEnabled || query.length < 2) {
      setGlobalYoutubeResults([]); setGlobalYoutubeVisibleLimit(youtubeGlobalInitialResultLimit); setGlobalYoutubeHasMore(false); setGlobalYoutubeError(""); setGlobalYoutubeSearching(false);
      return;
    }
    const cacheKey = query.toLocaleLowerCase();
    const cached = youtubeSearchCache.current.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < 60_000) {
      const hasMore = cached.hasMore ?? youtubeSearchCanContinue(query, cached.results.length);
      setGlobalYoutubeResults(cached.results); setGlobalYoutubeVisibleLimit(hasMore ? youtubeGlobalInitialResultLimit : cached.results.length); setGlobalYoutubeHasMore(hasMore); setGlobalYoutubeError(""); setGlobalYoutubeSearching(false);
      return;
    }
    if (!browserOnline) {
      setGlobalYoutubeResults([]); setGlobalYoutubeVisibleLimit(youtubeGlobalInitialResultLimit); setGlobalYoutubeHasMore(false); setGlobalYoutubeError("YouTube search is unavailable offline. Your local matches are still shown."); setGlobalYoutubeSearching(false);
      return;
    }
    setGlobalYoutubeResults([]); setGlobalYoutubeVisibleLimit(youtubeGlobalInitialResultLimit); setGlobalYoutubeHasMore(false); setGlobalYoutubeError(""); setGlobalYoutubeSearching(true);
    const timer = window.setTimeout(() => {
      void api.youtubeSearch(query, youtubeSearchPageSize, 0).then((results) => {
        if (globalYoutubeSearchVersion.current !== version) return;
        const hasMore = youtubeSearchCanContinue(query, results.length);
        setGlobalYoutubeResults(results); setGlobalYoutubeVisibleLimit(youtubeGlobalInitialResultLimit); setGlobalYoutubeHasMore(hasMore);
        youtubeSearchCache.current.set(cacheKey, { results, hasMore, savedAt: Date.now() });
      }).catch(() => {
        if (globalYoutubeSearchVersion.current === version) {
          setGlobalYoutubeResults([]);
          setGlobalYoutubeVisibleLimit(youtubeGlobalInitialResultLimit);
          setGlobalYoutubeHasMore(false);
          setGlobalYoutubeError(navigator.onLine ? "YouTube search couldn't load. Check your connection and try again." : "YouTube search is unavailable offline. Your local matches are still shown.");
        }
      }).finally(() => { if (globalYoutubeSearchVersion.current === version) setGlobalYoutubeSearching(false); });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [search, globalYoutubeSearchEnabled, browserOnline, isAndroid]);
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
      else void api.takeOpenedAudio().then((paths) => { if (paths.length && active) void openDesktopFiles(paths); }).catch((error) => setMessage(String(error)));
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
    if (isAndroid) return;
    const blockClipboard = (event: Event) => event.preventDefault();
    const blockContextMenu = (event: globalThis.MouseEvent) => event.preventDefault();
    const blockRestrictedShortcuts = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      const copyOrCut = (modified && !event.altKey && (key === "c" || key === "x"))
        || (event.ctrlKey && key === "insert")
        || (event.shiftKey && key === "delete");
      const openDevtools = key === "f12"
        || (modified && event.shiftKey && ["i", "j", "c", "k"].includes(key))
        || (event.metaKey && event.altKey && ["i", "j", "c"].includes(key));
      if (copyOrCut || openDevtools) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("copy", blockClipboard, true);
    document.addEventListener("cut", blockClipboard, true);
    document.addEventListener("contextmenu", blockContextMenu, true);
    window.addEventListener("keydown", blockRestrictedShortcuts, true);
    return () => {
      document.removeEventListener("copy", blockClipboard, true);
      document.removeEventListener("cut", blockClipboard, true);
      document.removeEventListener("contextmenu", blockContextMenu, true);
      window.removeEventListener("keydown", blockRestrictedShortcuts, true);
    };
  }, [isAndroid]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const savePlaybackSession = (state: PlayerSnapshot) => {
      const queue = state.currentTrackId === null ? state.queue : [state.currentTrackId, ...state.queue];
      localStorage.setItem("michoplay-playback-session", JSON.stringify({ currentTrackId: state.currentTrackId, queue, positionMs: state.positionMs, isPlaying: state.isPlaying } satisfies SavedPlaybackSession));
    };
    const flushPlaybackSession = () => {
      if (!playbackRestoreComplete.current || tracks.length === 0) return;
      savePlaybackSession(latestPlayerSnapshot.current);
    };
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") flushPlaybackSession(); };
    window.addEventListener("pagehide", flushPlaybackSession);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const tick = async () => {
      try {
        let state = await api.state();
        if (!active) return;
        if (!playbackRestoreStarted.current && tracks.length > 0) {
          playbackRestoreStarted.current = true;
          const saved = stored<SavedPlaybackSession | null>("playback-session", null);
          const available = new Set(tracks.map((track) => track.id));
          const queue = [...new Set((saved?.queue ?? []).filter((id) => available.has(id)))];
          if (state.currentTrackId === null && queue.length > 0 && saved) {
            const startId = saved.currentTrackId !== null && queue.includes(saved.currentTrackId) ? saved.currentTrackId : null;
            if (startId === null) {
              for (const id of [...queue].reverse()) await api.queueAdd(id);
            } else {
              await api.playCollection(queue, startId);
              await api.setPlaying(false);
              if (saved.positionMs > 0) await api.seek(saved.positionMs);
            }
            state = await api.state();
          }
          playbackRestoreComplete.current = true;
        }
        if (!active) return;
        latestPlayerSnapshot.current = state;
        setPlayer(state);
        const now = Date.now();
        if (playbackRestoreComplete.current && now - lastPlaybackSaveAt.current >= 5000) {
          lastPlaybackSaveAt.current = now;
          savePlaybackSession(state);
        }
      } catch {
        if (!playbackRestoreComplete.current) playbackRestoreStarted.current = false;
        /* The player can become available after the library loads. */
      }
    };
    tick(); const timer = window.setInterval(tick, 400);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", flushPlaybackSession);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tracks]);
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
    localStorage.setItem("michoplay-zoom-level-customized", "true");
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
        event.preventDefault(); setZoomLevel(isAndroid ? 120 : 100);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAndroid]);
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
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMobileQueueOpen(false); setMenu(null); setAppMenu(false); setDialog(null); setConfirmation(null); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    let disposed = false;
    let unregister: (() => void) | undefined;
    void onBackButtonPress(() => {
      if (mobileQueueOpen) { setMobileQueueOpen(false); return; }
      if (mobilePlayerOpen) { setMobilePlayerOpen(false); return; }
      if (fullMode) {
        setFullMode(false);
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        return;
      }
      if (dialog || confirmation || menu || appMenu || sortMenuOpen) {
        setDialog(null); setConfirmation(null); setMenu(null); setAppMenu(false); setSortMenuOpen(false); return;
      }
      if (mobileTab !== "home") {
        setMobileTab("home");
        setSearch("");
        if (history.index > 0) travel(-1);
        return;
      }
      if (history.index > 0) { travel(-1); return; }
      if (page.section !== "Home" || page.detail) {
        setHistory({ entries: [{ section: "Home" }], index: 0 });
      }
    }).then((listener) => {
      if (disposed) void listener.unregister();
      else unregister = () => { void listener.unregister(); };
    }).catch(() => {});
    return () => { disposed = true; unregister?.(); };
  }, [isAndroid, mobileQueueOpen, mobilePlayerOpen, fullMode, dialog, confirmation, menu, appMenu, sortMenuOpen, mobileTab, history, page]);

  function beginMobileSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    mobileSheetDragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function finishMobileSheetDrag(event: ReactPointerEvent<HTMLDivElement>, close: () => void) {
    const startY = mobileSheetDragStartY.current;
    mobileSheetDragStartY.current = null;
    if (startY !== null && event.clientY - startY > 56) close();
  }

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
      if (isAndroid) setMobileTab("downloads");
      else { setPanelView("downloads"); setShowPanel(true); }
      return true;
    } catch (error) { setMessage(youtubeDownloadErrorText(String(error), selected.isPlaylist)); return false; }
  }
  function requestYoutubeDownload(selected: YoutubeSearchResult, query?: string) {
    if (query) rememberSearch(query);
    if (youtubeDownloads.some((download) => download.url === selected.url && !["failed", "cancelled"].includes(download.status))) {
      if (isAndroid) setMobileTab("downloads");
      return;
    }
    if (globalYoutubeDownloadRequested.includes(selected.url)) return;
    setGlobalYoutubeDownloadRequested((prior) => prior.includes(selected.url) ? prior : [...prior, selected.url]);
    void queueYoutubeDownload(selected).then((queued) => {
      if (!queued) setGlobalYoutubeDownloadRequested((prior) => prior.filter((url) => url !== selected.url));
    });
  }

  async function playYoutubeDownload(item: YoutubeDownload) {
    const matchingIds = tracks.filter((track) => track.rootPath === youtubeDirectory && track.title.trim().toLocaleLowerCase() === item.title.trim().toLocaleLowerCase()).map((track) => track.id);
    const trackIds = completedDownloadTrackIds[item.id] ?? matchingIds;
    if (trackIds.length) { await run(() => api.playCollection(trackIds, trackIds[0])); return; }
    const refreshedIds = await syncYoutubeLibrary();
    if (refreshedIds.length) {
      setCompletedDownloadTrackIds((prior) => ({ ...prior, [item.id]: refreshedIds }));
      await run(() => api.playCollection(refreshedIds, refreshedIds[0]));
    } else setMessage("The downloaded audio could not be found in Music/YouTube. Try refreshing the library.");
  }
  function openDownloadedTrackMenu(item: YoutubeDownload, event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const matchingIds = completedDownloadTrackIds[item.id] ?? tracks.filter((track) => track.rootPath === youtubeDirectory && track.title.trim().toLocaleLowerCase() === item.title.trim().toLocaleLowerCase()).map((track) => track.id);
    const track = matchingIds.map((id) => trackMap.get(id)).find((candidate): candidate is Track => Boolean(candidate));
    if (track) { openTrackMenuAt(track, rect); return; }
    if (!youtubeDirectory) { setMessage("This download is still being added to your library. Try again shortly."); return; }
    void api.refresh([...new Set([...roots, youtubeDirectory])]).then(async (scanned) => {
      setRoots((prior) => [...new Set([...prior, youtubeDirectory])]);
      setTracks(scanned); setPlayer(await api.state());
      const downloaded = scanned.filter((candidate) => candidate.rootPath === youtubeDirectory);
      const downloadedIds = downloaded.map((candidate) => candidate.id);
      setCompletedDownloadTrackIds((prior) => ({ ...prior, [item.id]: downloadedIds }));
      setPlaylists((prior) => {
        const existing = prior.find((playlist) => playlist.name.trim().toLocaleLowerCase() === "youtube");
        return existing
          ? prior.map((playlist) => playlist.id === existing.id ? { ...playlist, trackIds: [...new Set([...playlist.trackIds, ...downloadedIds])] } : playlist)
          : [{ id: "michoplay-youtube", name: "YouTube", trackIds: downloadedIds }, ...prior];
      });
      const target = downloaded.find((candidate) => candidate.title.trim().toLocaleLowerCase() === item.title.trim().toLocaleLowerCase()) ?? downloaded[0];
      if (target) openTrackMenuAt(target, rect);
      else setMessage("The downloaded song could not be found in Music/YouTube.");
    }).catch((error) => setMessage(String(error)));
  }
  async function controlYoutubeDownload(id: string, action: "pause" | "resume" | "cancel" | "remove") {
    try {
      const item = youtubeDownloads.find((download) => download.id === id);
      if (action === "pause") await api.youtubeDownloadPause(id);
      else if (action === "resume") await api.youtubeDownloadResume(id);
      else if (action === "cancel") await api.youtubeDownloadCancel(id);
      else await api.youtubeDownloadRemove(id);
      if (item && (action === "cancel" || action === "remove")) setGlobalYoutubeDownloadRequested((prior) => prior.filter((url) => url !== item.url));
    } catch (error) { setMessage(youtubeDownloadErrorText(String(error))); }
  }
  async function clearYoutubeDownloads() {
    try {
      const finished = youtubeDownloads.filter(isFinishedYoutubeDownload);
      if (!finished.length) return;
      for (const item of finished) await api.youtubeDownloadRemove(item.id);
      const remaining = await api.youtubeDownloadsState();
      const remainingUrls = new Set(remaining.map((item) => item.url));
      setYoutubeDownloads(remaining);
      setGlobalYoutubeDownloadRequested((prior) => prior.filter((url) => remainingUrls.has(url)));
    } catch (error) { setMessage(String(error)); }
  }
  function chooseLibrarySource() {
    if (isAndroid) {
      setScanning(true); setMessage("");
      void api.pickMusicFolder().then(async ({ path, count, name }) => {
        const nextRoots = [...new Set([...roots, path])];
        const scanned = await api.refresh(nextRoots);
        setTracks(scanned); setPlayer(await api.state());
        setRoots(nextRoots);
        setMessage(`Added ${count} ${count === 1 ? "song" : "songs"} from ${name}.`);
      }).catch((error) => {
        if (!String(error).toLowerCase().includes("cancel")) setMessage(String(error));
      }).finally(() => setScanning(false));
    }
    else void chooseFolder();
  }
  async function chooseAndroidAudioFiles() {
    setScanning(true); setMessage("");
    try {
      const paths = await api.pickAudioFiles();
      if (!paths.length) return;
      const scanned = await api.addAudioFiles(paths);
      setTracks(scanned); setPlayer(await api.state());
      setRoots((prior) => [...new Set([...prior, ...paths.map((path) => path.replace(/[\\/][^\\/]+$/, ""))])]);
      setMessage(`Added ${paths.length} selected ${paths.length === 1 ? "song" : "songs"} and scanned their folders.`);
    } catch (error) {
      if (!String(error).toLowerCase().includes("cancel")) setMessage(String(error));
    } finally { setScanning(false); }
  }
  function openYoutubePage() {
    const youtube = youtubePlaylist ?? { id: "michoplay-youtube", name: "YouTube", trackIds: [] };
    if (!youtubePlaylist) setPlaylists((prior) => prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube") ? prior : [youtube, ...prior]);
    setSearch(""); setMobileTab(isAndroid ? "youtube" : "home");
    navigate({ section: "Playlists", detail: { kind: "playlist", key: youtube.id, title: youtube.name } });
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
  const normalizedTrackSearch = useMemo(() => new Map(tracks.map((track) => [track.id, `${track.title} ${track.artist} ${track.album} ${track.folderName}`.toLocaleLowerCase()])), [tracks]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const addSongsFilteredTracks = useMemo(() => {
    if (!addSongsPlaylistId) return [];
    return tracks.filter((track) => !addSongsSearchTerm || normalizedTrackSearch.get(track.id)?.includes(addSongsSearchTerm));
  }, [addSongsPlaylistId, tracks, addSongsSearchTerm, normalizedTrackSearch]);
  const addSongsVisibleTracks = addSongsFilteredTracks.slice(0, addSongsVisibleLimit);
  const addSongsSelectedSet = useMemo(() => new Set(addSongsSelected), [addSongsSelected]);
  const addSongsAlreadyAddedSet = useMemo(() => new Set(playlists.find((item) => item.id === addSongsPlaylistId)?.trackIds ?? []), [playlists, addSongsPlaylistId]);
  const visibleQueue = queueExpanded ? player.queue : player.queue.slice(0, 80);
  const fullBrowsePlaylist = playlists.find((playlist) => playlist.id === fullBrowsePlaylistId) ?? null;
  const fullBrowsePlaylistTracks = useMemo(() => fullBrowsePlaylist?.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) ?? [], [fullBrowsePlaylist, trackMap]);
  const current = player.currentTrackId === null ? null : trackMap.get(player.currentTrackId) ?? null;
  const currentArtworkDataUrl = useArtwork(current?.artworkKey);
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
    return page.section === "Favorites" ? tracks.filter((track) => favoriteSet.has(track.id)) : tracks;
  }, [page, tracks, selectedPlaylist, trackMap, favoriteSet, recentTracks]);
  const deferredInlineSearch = useDeferredValue(inlineSearch);
  const inlineSearchTerm = deferredInlineSearch.trim().toLocaleLowerCase();
  const visibleTracks = useMemo(() => collectionTracks.filter((track) => !inlineSearchTerm || normalizedTrackSearch.get(track.id)?.includes(inlineSearchTerm)), [collectionTracks, inlineSearchTerm, normalizedTrackSearch]);
  const collectionDurationMs = useMemo(() => collectionTracks.reduce((sum, track) => sum + track.durationMs, 0), [collectionTracks]);
  const collectionHasCurrent = useMemo(() => collectionTracks.some((track) => track.id === player.currentTrackId), [collectionTracks, player.currentTrackId]);
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
  const firstArt = useMemo(() => collectionTracks.find((track) => track.artworkKey)?.artworkKey, [collectionTracks]);
  const headingArt = useArtwork(firstArt);
  const listPage = Boolean(page.detail) || page.section === "Songs" || page.section === "Favorites" || page.section === "Recently Played";
  const buildSearchResults = useCallback((value: string): GlobalSearchResult[] => {
    const query = value.trim().toLocaleLowerCase();
    if (!query) return [];
    const tracksFound = tracks.filter((track) => normalizedTrackSearch.get(track.id)?.includes(query)).slice(0, 4).map((track): GlobalSearchResult => ({
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
      return playlist.name.toLocaleLowerCase().includes(query) || playlistTracks.some((track) => normalizedTrackSearch.get(track.id)?.includes(query));
    }).slice(0, 2).map((playlist): GlobalSearchResult => {
      const item: Collection = { key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => trackMap.has(id) ? [trackMap.get(id)!] : []) };
      return { type: "Playlist", title: item.title, subtitle: `Playlist · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null, page: { section: "Playlists", detail: { kind: "playlist", key: item.key, title: item.title } } };
    });
    return [...tracksFound, ...artistsFound, ...albumsFound, ...foldersFound, ...playlistsFound];
  }, [tracks, artists, albums, folders, playlists, trackMap, normalizedTrackSearch]);
  const deferredSearch = useDeferredValue(search);
  const searchResults = useMemo(() => buildSearchResults(deferredSearch), [buildSearchResults, deferredSearch]);
  const recentSearchResults = useMemo(() => recentSearches.map((query) => ({ query, result: buildSearchResults(query)[0] ?? null })), [recentSearches, buildSearchResults]);

  useEffect(() => {
    if (!isAndroid && !isTauri()) return;
    let unlisten: (() => void) | undefined;
    const handleAction = (action: string) => {
      if (action.startsWith("seek:")) {
        const position = Number(action.slice(5));
        if (Number.isFinite(position)) void run(() => api.seek(position));
        return;
      }
      if (action.startsWith("seek-by:")) {
        const delta = Number(action.slice(8));
        if (Number.isFinite(delta)) void run(async () => {
          const state = await api.state();
          await api.seek(Math.max(0, Math.min(state.durationMs, state.positionMs + delta)));
        });
        return;
      }
      switch (action) {
        case "open-audio": void api.takeOpenedAudio().then(async (paths) => {
          if (!paths.length) return;
          const scanned = await api.openAudioFiles(paths);
          setTracks(scanned); setPlayer(await api.state());
          setRoots((prior) => [...new Set([...prior, ...paths.map((path) => path.replace(/[\\/][^\\/]+$/, ""))])]);
        }).catch((error) => setMessage(String(error))); break;
        case "toggle": void run(api.toggle); break;
        case "play": void run(() => api.setPlaying(true)); break;
        case "pause": void run(() => api.setPlaying(false)); break;
        case "previous": void run(api.previous); break;
        case "next": void run(api.next); break;
      }
    };
    if (isAndroid) {
      // Android media actions are handled by the Rust playback loop so they
      // continue to reach the audio engine while this WebView is backgrounded.
      const refreshPlayerState = () => {
        if (document.visibilityState !== "visible") return;
        void api.state().then(setPlayer).catch(() => {});
      };
      void listen<string>("android-player-state", refreshPlayerState).then((dispose) => { unlisten = dispose; });
      document.addEventListener("visibilitychange", refreshPlayerState);
      window.addEventListener("focus", refreshPlayerState);
      return () => {
        unlisten?.();
        document.removeEventListener("visibilitychange", refreshPlayerState);
        window.removeEventListener("focus", refreshPlayerState);
      };
    }
    void listen<string>("system-media-control", ({ payload }) => handleAction(payload)).then((dispose) => { unlisten = dispose; });
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
        else await api.mediaUpdate(current, state.isPlaying, state.durationMs, state.positionMs, currentArtworkDataUrl);
      } catch { /* The player can start before Android creates the service. */ }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, isAndroid ? 4000 : 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [isAndroid, current?.id, current?.title, current?.artist, currentArtworkDataUrl, player.isPlaying]);
  const playCollection = (track: Track, items = sortedVisibleTracks) => {
    if (track.id === player.currentTrackId) { void run(api.toggle); return; }
    void run(() => api.playCollection(items.map((item) => item.id), track.id));
  };
  const isCollectionCurrent = (item: Collection) => {
    const trackIds = new Set(item.tracks.map((track) => track.id));
    return player.currentTrackId !== null && trackIds.has(player.currentTrackId) && player.queue.every((id) => trackIds.has(id));
  };
  const playCardCollection = (item: Collection) => {
    const trackIds = item.tracks.map((track) => track.id);
    if (!trackIds.length) return;
    if (isCollectionCurrent(item)) void run(api.toggle);
    else void run(() => api.playCollection(trackIds, trackIds[0]));
  };
  function openTrackMenu(track: Track, event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openTrackMenuAt(track, rect);
  }
  function openTrackMenuAt(track: Track, rect: DOMRect) {
    setMenu({ track, x: Math.max(8, Math.min(window.innerWidth - 235, rect.right - 225)), y: Math.max(8, Math.min(window.innerHeight - 390, rect.bottom + 5)) });
    setPlaylistSubmenu(false); setPlaylistSearch(""); setAppMenu(false);
  }
  function shareTrack(track: Track) {
    const details = { title: track.title, text: `${track.title} — ${track.artist}` };
    if (navigator.share) void navigator.share(details).catch(() => {});
    else setMessage("Sharing isn't available on this device.");
  }
  async function shareMichoPlay() {
    const title = "MichoPlay";
    const text = "Check out MichoPlay, a free music player for Android, Windows, macOS, and Linux.";
    if (isAndroid && isTauri()) {
      try {
        await api.shareText(title, text, michoplayWebsiteUrl);
        return;
      } catch {
        // Continue with the browser share API or clipboard fallback when the
        // native Android share activity is unavailable.
      }
    }
    const details = { title, text, url: michoplayWebsiteUrl };
    if (navigator.share) {
      try { await navigator.share(details); return; } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text + "\n\n" + michoplayWebsiteUrl);
      setMessage("MichoPlay website copied to the clipboard.");
    } catch { setMessage("Copy this message to share MichoPlay: " + text + " " + michoplayWebsiteUrl); }
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
  const rows = (items: Track[], emptyTitle = "No songs here") => <TrackRows items={items} player={player} favorites={favoriteSet} compact={compact} playCounts={playCounts} showPlayCount={page.section === "Recently Played"} onPlay={(track) => playCollection(track, items)} onFavorite={toggleFavorite} onMenu={openTrackMenu} emptyTitle={scanning ? "Scanning music…" : search || inlineSearch ? "No results" : emptyTitle} emptyMessage={scanning ? "Reading local audio and artwork." : search || inlineSearch ? "Try another search." : page.section === "Favorites" ? "Save songs with the heart in their action menu." : page.section === "Recently Played" ? "Songs will appear here after you play them." : page.detail?.kind === "playlist" ? "Add songs to this playlist from your library." : "Add a music folder to get started."} emptyAction={!scanning && !search && !inlineSearch && selectedPlaylist && selectedPlaylist.name.toLocaleLowerCase() !== "youtube" ? <button className="primary-button playlist-add-songs" onClick={() => { setAddSongsPlaylistId(selectedPlaylist.id); setAddSongsSelected([]); setAddSongsSearch(""); setAddSongsVisibleLimit(100); }}><Plus size={15}/>Add songs</button> : undefined} />;
  async function loadMoreYoutubeFolderResults() {
    const query = youtubeQuery.trim();
    if (!query || youtubeSearching || youtubeLoadingMore || !youtubeHasMore) return;
    const version = youtubeSearchVersion.current;
    const offset = youtubeResults.length;
    setYoutubeLoadingMore(true);
    try {
      const next = await api.youtubeSearch(query, youtubeSearchPageSize, offset);
      if (youtubeSearchVersion.current !== version) return;
      setYoutubeResults((current) => {
        const known = new Set(current.map((result) => result.id));
        const merged = [...current, ...next.filter((result) => !known.has(result.id))];
        youtubeSearchCache.current.set(query.toLocaleLowerCase(), { results: merged, hasMore: youtubeSearchCanContinue(query, next.length), savedAt: Date.now() });
        return merged;
      });
      setYoutubeHasMore(youtubeSearchCanContinue(query, next.length));
      setYoutubeVisibleLimit((limit) => limit + youtubeSearchPageSize);
    } catch {
      if (youtubeSearchVersion.current === version) setMessage("Couldn't load more YouTube results. Try again.");
    } finally {
      setYoutubeLoadingMore(false);
    }
  }
  async function loadMoreGlobalYoutubeResults() {
    const query = search.trim();
    if (!query || globalYoutubeSearching || globalYoutubeLoadingMore || !globalYoutubeHasMore) return;
    const version = globalYoutubeSearchVersion.current;
    const offset = globalYoutubeResults.length;
    setGlobalYoutubeLoadingMore(true);
    try {
      const next = await api.youtubeSearch(query, youtubeSearchPageSize, offset);
      if (globalYoutubeSearchVersion.current !== version) return;
      setGlobalYoutubeResults((current) => {
        const known = new Set(current.map((result) => result.id));
        const merged = [...current, ...next.filter((result) => !known.has(result.id))];
        youtubeSearchCache.current.set(query.toLocaleLowerCase(), { results: merged, hasMore: youtubeSearchCanContinue(query, next.length), savedAt: Date.now() });
        return merged;
      });
      setGlobalYoutubeHasMore(youtubeSearchCanContinue(query, next.length));
      setGlobalYoutubeVisibleLimit((limit) => limit + youtubeSearchPageSize);
    } catch {
      if (globalYoutubeSearchVersion.current === version) setMessage("Couldn't load more YouTube results. Try again.");
    } finally {
      setGlobalYoutubeLoadingMore(false);
    }
  }
  const globalSearchContent = search.trim() ? <>
    {!isAndroid && isTauri() && globalYoutubeSearchEnabled && search.trim().length >= 2 && <section className="global-search-group global-youtube-search-group">
      <h2>YouTube</h2>
      {globalYoutubeSearching ? Array.from({ length: 3 }, (_, index) => <div className="global-search-youtube-skeleton" key={index}><span/><i/><i/></div>) : globalYoutubeError ? <p className="global-search-status" role="status">{globalYoutubeError}</p> : globalYoutubeResults.length ? <>
        <div className="global-youtube-results-scroll" role="region" aria-label="YouTube search results">
          {globalYoutubeResults.slice(0, globalYoutubeVisibleLimit).map((result) => <div className="global-youtube-result-row" key={result.id}>
            <button className="global-search-result global-youtube-result" role="option" aria-label={`Download ${result.title} from YouTube`} onClick={() => requestYoutubeDownload(result, search)}>
              {result.thumbnail ? <img className="cover global-search-cover" src={result.thumbnail} alt="" loading="lazy"/> : <span className="cover global-search-cover global-youtube-placeholder"><Youtube size={18}/></span>}
              <span className="search-result-copy"><strong>{result.title}</strong><small>YouTube · {result.isPlaylist ? "Playlist" : `${result.durationSeconds == null ? "Audio" : durationLabel(result.durationSeconds)} · ${youtubeResultSize(result)}`}</small></span>
            </button>
            {!globalYoutubeDownloadRequested.includes(result.url) && !youtubeDownloads.some((download) => download.url === result.url && !["failed", "cancelled"].includes(download.status)) && <button className="global-youtube-download" aria-label={`Download ${result.title}`} title="Download audio" onClick={() => requestYoutubeDownload(result, search)}><Download size={16}/></button>}
          </div>)}
        </div>
        {globalYoutubeHasMore && <button className="youtube-load-more global-youtube-load-more" disabled={globalYoutubeLoadingMore} onClick={() => void loadMoreGlobalYoutubeResults()}>{globalYoutubeLoadingMore ? "Loading YouTube results…" : "Load more"}</button>}
      </> : !globalYoutubeSearching && !globalYoutubeError ? <p className="global-search-status">No YouTube matches.</p> : null}
    </section>}
    {searchResults.length ? ["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => {
      const group = searchResults.filter((result) => result.type === type);
      return group.length ? <section className="global-search-group" key={type}><h2>{type === "Song" ? "Songs" : `${type}s`}</h2>{group.map((result) => <GlobalSearchResultButton key={`${result.type}-${result.title}-${result.subtitle}`} result={result} onClick={() => chooseSearchResult(result)} isPlaying={result.trackId === player.currentTrackId && player.isPlaying}/>)}</section> : null;
    }) : <div className="global-search-empty"><strong>No matches in your library for “{search}”</strong><span>Try a song, artist, album, folder, or playlist name.</span></div>}
  </> : recentSearchResults.length ? <section className="global-search-group"><div className="global-search-heading"><h2>Recent searches</h2><button onClick={() => { setRecentSearches([]); localStorage.removeItem("michoplay-recent-searches"); }}>Clear</button></div>{recentSearchResults.map(({ query, result }) => result ? <GlobalSearchResultButton key={query} result={result} onClick={() => { setSearch(query); setSearchOpen(true); }} showPlayHover={false}/> : <button className="global-search-result recent-query" key={query} role="option" onClick={() => { setSearch(query); setSearchOpen(true); }}><span className="search-result-symbol"><Search size={17}/></span><span className="search-result-copy"><strong>{query}</strong><small>Recent search</small></span></button>)}</section> : <div className="global-search-empty"><strong>Search your library</strong><span>Find songs, artists, albums, folders, and playlists.</span></div>;

  const submenuPlacement = menu && !isAndroid ? playlistSubmenuPlacement(menu.x) : "";
  return <main ref={appFrameRef} className={`app-frame ${compact ? "compact" : ""} ${isAndroid ? "android-app" : "desktop-app"}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--panel-width": `${panelWidth}px` } as CSSProperties}>
    <svg className="mobile-svg-defs" aria-hidden="true" focusable="false"><defs><linearGradient id="michoplay-brand-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#f5c6be"/><stop offset="64%" stopColor="#f5eee8"/><stop offset="100%" stopColor="#d8eee4"/></linearGradient></defs></svg>
    {startupLoading && <div className="startup-loading" role="status" aria-live="polite" aria-label="Loading MichoPlay">
      <div className="startup-loading-card">
        <span className="startup-loading-mark"><AudioLines size={24}/></span>
        <div className="startup-loading-copy">
          <strong>Loading MichoPlay</strong>
          <span>{scanProgress?.phase ?? startupPhase}</span>
          {scanProgress?.total ? <small>{scanProgress.processed.toLocaleString()} of {scanProgress.total.toLocaleString()} audio files</small> : <small>Preparing your library…</small>}
        </div>
        <span className="startup-loading-spinner" aria-hidden="true"/>
      </div>
    </div>}
    {!isAndroid && <input ref={importInput} className="audio-import-input" type="file" accept="audio/*,.mp3,.flac,.wav,.ogg,.opus,.m4a,.aac,.aiff,.aif" multiple aria-label="Choose audio files" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importAudioFiles(files); }}/>}
    <aside className="sidebar" aria-label="Main navigation">
      <button className="brand" onClick={() => navigate({ section: "Home" })}><span className="brand-mark"><AudioLines size={19}/></span><span>Micho<span className="brand-light">Play</span></span></button>
      <nav className="nav-list" aria-label="Library">{navigation.map(({ label, icon: Icon }) => <Fragment key={label}><button className={`nav-item ${page.section === label && !(label === "Playlists" && isYoutubePlaylist) ? "active" : ""}`} aria-label={label} title={label} aria-current={page.section === label && !(label === "Playlists" && isYoutubePlaylist) ? "page" : undefined} onClick={() => { setSearch(""); navigate({ section: label }); }}><Icon size={18}/><span>{label}</span></button>{label === "Favorites" && !isAndroid && <button className={`nav-item ${isYoutubePlaylist ? "active" : ""}`} aria-label="YouTube" title="YouTube" aria-current={isYoutubePlaylist ? "page" : undefined} onClick={() => { const youtube = youtubePlaylist ?? { id: "michoplay-youtube", name: "YouTube", trackIds: [] }; if (!youtubePlaylist) setPlaylists((prior) => prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube") ? prior : [youtube, ...prior]); setSearch(""); navigate({ section: "Playlists", detail: { kind: "playlist", key: youtube.id, title: youtube.name } }); }}><Youtube size={18}/><span>YouTube</span></button>}</Fragment>)}</nav>
      <div className="sidebar-rule"/><div className="library-heading"><span className="side-label">Your Library</span><div className="library-heading-actions"><button className="icon-button small" aria-label="Create playlist" title="Create playlist" onClick={() => newPlaylist()}><Plus size={15}/></button><button className="icon-button small" aria-label="Open playlists" title="Open playlists" onClick={() => navigate({ section: "Playlists" })}><Maximize2 size={12}/></button></div></div>
      <div className="library-tools"><label className="library-search"><Search size={16}/><input aria-label="Search your library" placeholder="Search" value={sidebarLibrarySearch} onChange={(event) => setSidebarLibrarySearch(event.target.value)}/>{sidebarLibrarySearch && <button aria-label="Clear library search" onClick={() => setSidebarLibrarySearch("")}><X size={13}/></button>}</label><button className="library-sort" aria-label={`Sort ${sidebarLibrarySort === "recent" ? "recently added" : "alphabetically"}; click to change`} title="Change sort order" onClick={() => setSidebarLibrarySort((value) => value === "recent" ? "az" : "recent")}><span>{sidebarLibrarySort === "recent" ? "Recents" : "A–Z"}</span><List size={16}/></button></div>
      <div className="sidebar-playlists" aria-live="polite">{sidebarPlaylistItems.map((playlist) => { const firstTrack = playlist.trackIds.map((id) => trackMap.get(id)).find((track): track is Track => Boolean(track)); const selected = selectedPlaylist?.id === playlist.id; return <button key={playlist.id} className={`library-item ${selected ? "selected" : ""}`} onClick={() => navigate({ section: "Playlists", detail: { kind: "playlist", key: playlist.id, title: playlist.name } })}>{firstTrack ? <Cover className="library-item-art" keys={[firstTrack.artworkKey]}/> : <span className="library-item-placeholder"><ListMusic size={20}/></span>}<span className="library-item-copy"><strong>{playlist.name}</strong><small className="library-item-meta"><ListMusic size={12}/><span className="library-item-kind">Playlist</span><span className="library-item-separator">·</span><span className="library-item-count">{playlist.trackIds.length} {playlist.trackIds.length === 1 ? "song" : "songs"}</span></small></span></button>})}{!sidebarPlaylistItems.length && <div className="library-empty">{sidebarLibrarySearch ? "No matching playlists" : "Create a playlist to keep songs together."}</div>}</div>
    </aside>
    <div className="resize-handle sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={(event) => startResize("sidebar", event)}/>
    <section className="workspace">
      {isAndroid && !mobilePlayerOpen && !listPage && page.section !== "Settings" && <header className="mobile-header">
        <div className="mobile-header-title">
          <span className="brand-mark"><AudioLines size={19}/></span>
          <h1>{mobileTab === "downloads" ? "Downloads" : page.section === "Home" ? mobileTab === "home" ? "MichoPlay" : mobileTab === "search" ? "Search" : mobileTab === "youtube" ? "YouTube" : "Your Library" : page.section}</h1>
        </div>
        <div className="mobile-header-actions">
          {mobileTab === "home" && <button className="mobile-icon-button" aria-label="Search music" onClick={() => { setMobileTab("search"); setSearch(""); }}><Search size={24}/></button>}
          {mobileTab === "library" && <button className="mobile-icon-button" aria-label="Create playlist or import music" onClick={() => setMobileLibraryActionsOpen(true)}><Plus size={25}/></button>}
          {mobileTab === "youtube" && <button className="mobile-icon-button" aria-label="Open downloads" onClick={() => setMobileTab("downloads")}><Download size={21}/></button>}
          <button className="mobile-icon-button" aria-label="Settings" onClick={() => { setMobileTab("home"); navigate({ section: "Settings" }); }}><Settings2 size={20}/></button>
        </div>
      </header>}
      <header className="topbar"><div className="history-nav"><div className="app-menu-anchor"><button className="icon-button menu-trigger" aria-label="Application menu" aria-expanded={appMenu} onClick={() => { setAppMenu(!appMenu); setMenu(null); }}><MoreHorizontal size={22}/></button>{appMenu && <div className="action-menu app-menu"><button onClick={() => { chooseLibrarySource(); setAppMenu(false); }}><Plus size={15}/>Add music folder</button><button onClick={() => { void refresh(); setAppMenu(false); }}><RefreshCw size={15}/>Refresh library</button><button onClick={() => newPlaylist()}><ListMusic size={15}/>New playlist</button><div className="menu-separator"/><button onClick={() => navigate({ section: "Settings" })}><Settings2 size={15}/>Settings</button><button onClick={() => { setAboutOpen(true); setAppMenu(false); }}><AudioLines size={15}/>About MichoPlay</button></div>}</div><button className="icon-button" aria-label="Go back" disabled={history.index === 0} onClick={() => travel(-1)}><ChevronLeft size={24}/></button><button className="icon-button" aria-label="Go forward" disabled={history.index === history.entries.length - 1} onClick={() => travel(1)}><ChevronRight size={24}/></button></div><div className={`search-box global-search ${searchOpen ? "expanded" : ""}`} role="search"><Search size={17}/><input aria-label="Search all music" aria-expanded={searchOpen} aria-controls="global-search-results" placeholder="What do you want to play?" value={search} onFocus={() => setSearchOpen(true)} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); else if (event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLButtonElement>(".global-search-result")?.focus(); } else if (event.key === "Enter") event.preventDefault(); }}/>{search && <button className="icon-button" aria-label="Clear search" onClick={() => { setSearch(""); setSearchOpen(true); }}><X size={15}/></button>}{searchOpen && <div className="global-search-popover" id="global-search-results" role="listbox" aria-label="Search results">{globalSearchContent}</div>}</div><button className={`topbar-downloads ${showPanel && panelView === "downloads" ? "active" : ""}`} aria-label="Downloads" title="Downloads" onClick={() => { setPanelView("downloads"); setShowPanel(true); }}><Download size={18}/></button><button className={`topbar-settings ${page.section === "Settings" ? "active" : ""}`} aria-label="Settings" title="Settings" onClick={() => navigate({ section: "Settings" })}><Settings2 size={18}/></button></header>
      <div className={`work-area ${showPanel ? "with-panel" : "without-panel"}`}>
        <section className="content-scroll" aria-label={heading}>
          {availableUpdate && <div className="update-notice" role="status">
            <span className="update-notice-icon"><Download size={17}/></span>
            <span className="update-notice-copy"><strong>MichoPlay {availableUpdate} is available</strong><small>Installed version {appVersion}</small></span>
            <button className="update-download-button" onClick={() => { void openUrl(releasesPageUrl).catch((error) => setMessage(`Could not open the releases page: ${String(error)}`)); }}><Download size={14}/>Download</button>
            <button className="icon-button update-dismiss" aria-label="Dismiss update notice" title="Remind me later" onClick={() => { localStorage.setItem("michoplay-dismissed-update-version", availableUpdate); setAvailableUpdate(null); }}><X size={15}/></button>
          </div>}
          {scanning && <div className="scan-banner" role="status"><span className="loading-indicator"/><span>{scanProgress?.phase ?? "Scanning music and artwork…"}{scanProgress?.phase === "Finding audio files" && scanProgress.processed ? ` · ${scanProgress.processed.toLocaleString()} found` : scanProgress?.total ? ` · ${scanProgress.processed.toLocaleString()} of ${scanProgress.total.toLocaleString()}` : ""}</span><button className="scan-cancel-button" onClick={() => void api.cancelScan().catch(() => {})}>Cancel</button></div>}
          {message && <div className="status-message" role="status"><span>{message.includes("Refresh the folder") ? <>{message.split("Refresh the folder")[0]}<button className="inline-link" onClick={() => void refresh()}>Refresh the folder</button>{message.split("Refresh the folder")[1]}</> : message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage("")}><X size={13}/></button></div>}
          {isAndroid && page.section === "Settings" ? mobileAboutOpen ? <MobileAboutPage version={appVersion} onBack={() => setMobileAboutOpen(false)} onOpenUrl={(url) => { void openUrl(url).catch((error) => setMessage(`Could not open the link: ${String(error)}`)); }} onShare={() => { void shareMichoPlay(); }} /> : <MobileSettingsPage
            roots={roots}
            player={player}
            equalizerBands={equalizerBands}
            equalizerEnabled={equalizerEnabled}
            compact={compact}
            keepScreenAwake={keepScreenAwake}
            scanning={scanning}
            zoomLevel={zoomLevel}
            onBack={() => { setMobileTab("home"); if (history.index > 0) travel(-1); else navigate({ section: "Home" }); }}
            onKeepScreenAwake={setKeepScreenAwake}
            onEqualizer={onEqualizer => {
              setEqualizerBands(onEqualizer);
              localStorage.setItem("michoplay-equalizer-bands", JSON.stringify(onEqualizer));
              return api.equalizer(onEqualizer, equalizerEnabled).catch((error) => setMessage(String(error)));
            }}
            onEqualizerPreview={(bands) => api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)))}
            onEqualizerToggle={(enabled) => { setEqualizerEnabled(enabled); localStorage.setItem("michoplay-equalizer-enabled", JSON.stringify(enabled)); void run(() => api.equalizer(equalizerBands, enabled)); }}
            onCompact={setCompact}
            onAdd={chooseLibrarySource}
            onRemove={confirmRemoveFolder}
            onRefresh={() => void refresh()}
            onVolume={(volume) => { localStorage.setItem("michoplay-volume", JSON.stringify(volume)); void run(() => api.volume(volume)); }}
            onSleepTimer={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))}
            onZoom={setZoomLevel}
            onAbout={() => setMobileAboutOpen(true)}
          /> : isAndroid && mobileTab === "downloads" ? <div className="mobile-downloads-page">
            <div className="mobile-downloads-destination"><FolderOpen size={20}/><span><strong>Music / MichoPlay / YouTube</strong><small>Saved to your phone and added to Your Library</small></span></div>
            <div className="section-title-row"><h2>Your downloads</h2><span>{youtubeDownloads.filter((item) => item.status === "downloading" || item.status === "queued").length} active</span>{clearableYoutubeDownloads && <button className="download-clear-button" onClick={() => void clearYoutubeDownloads()}><Trash2 size={14}/>Clear</button>}</div>
            {youtubeDownloads.length ? <div className="mobile-download-list">{youtubeDownloads.map((item) => <article className={`mobile-download-row status-${item.status}`} key={item.id}>
              <div className="mobile-download-art">{item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/>}<Youtube size={16}/>{item.status === "completed" && <button aria-label={`Play ${item.title}`} onClick={() => void playYoutubeDownload(item)}><Play size={16} fill="currentColor"/></button>}</div>
              <div className="mobile-download-copy"><strong>{item.title}</strong>{youtubeDownloadDescription(item) && <small>{youtubeDownloadDescription(item)}</small>}<div className="mobile-download-progress"><span style={{ width: `${item.percent ?? (item.status === "downloading" ? 5 : item.status === "completed" ? 100 : 0)}%` }}/></div>{item.status === "completed" && <small className="mobile-download-status">Completed</small>}</div>
              <div className="mobile-download-actions">{item.status === "downloading" || item.status === "queued" ? <><button aria-label={`Pause ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "pause")}><Pause size={17}/></button><button aria-label={`Cancel ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "cancel")}><X size={17}/></button></> : item.status === "paused" || item.status === "failed" ? <><button aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "resume")}><Play size={17}/></button><button aria-label={`Remove ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "remove")}><X size={17}/></button></> : <button className="download-menu-trigger" aria-label={`More actions for ${item.title}`} onClick={(event) => openDownloadedTrackMenu(item, event)}><MoreVertical size={19}/></button>}</div>
            </article>)}</div> : <div className="mobile-download-empty"><Download size={30}/><strong>No downloads yet</strong><span>Find a song on YouTube and tap Download. It will appear here.</span><button className="primary-button" onClick={openYoutubePage}><Youtube size={16}/>Find music</button></div>}
          </div> : isAndroid && mobileTab === "search" ? <div className="mobile-search-view">
            <label className="mobile-search-input"><Search size={22}/><input aria-label="Search your library" placeholder="What do you want to listen to?" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}/>{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={19}/></button>}</label>
            {globalYoutubeSearchEnabled && search.trim().length >= 2 && <section className="mobile-youtube-search-results"><h2>YouTube</h2>{globalYoutubeSearching ? <div className="mobile-youtube-search-loading"><span/><span/><span/></div> : globalYoutubeResults.length ? <><div className="mobile-youtube-results-scroll" role="region" aria-label="YouTube search results">{globalYoutubeResults.slice(0, globalYoutubeVisibleLimit).map((result) => <article className="mobile-youtube-search-result" key={result.id}><button className="mobile-youtube-search-open" onClick={() => requestYoutubeDownload(result, search)}><span>{result.thumbnail ? <img src={result.thumbnail} alt="" loading="lazy"/> : <Youtube size={18}/>}</span><span className="mobile-youtube-search-copy"><strong>{result.title}</strong><small>{result.isPlaylist ? "Playlist · Size varies" : `${result.durationSeconds == null ? "YouTube" : durationLabel(result.durationSeconds)} · ${youtubeResultSize(result)}`}</small></span></button></article>)}</div>{globalYoutubeHasMore && <button className="youtube-load-more mobile-youtube-load-more" disabled={globalYoutubeLoadingMore} onClick={() => void loadMoreGlobalYoutubeResults()}>{globalYoutubeLoadingMore ? "Loading YouTube results…" : "Load more"}</button>}</> : globalYoutubeError ? <p>{globalYoutubeError}</p> : <p>No YouTube matches.</p>}</section>}
            {search.trim() ? searchResults.length ? <div className="mobile-search-results">{["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => { const group = searchResults.filter((result) => result.type === type); return group.length ? <section className="mobile-result-group" key={type}><h2>{type === "Song" ? "Songs" : `${type}s`}</h2>{group.map((result) => <GlobalSearchResultButton key={`${result.type}-${result.title}-${result.subtitle}`} result={result} onClick={() => chooseSearchResult(result)} isPlaying={result.trackId === player.currentTrackId && player.isPlaying}/>)}</section> : null; })}</div> : <div className="mobile-search-empty"><strong>No matches for “{search}”</strong><span>Try a song, artist, album, folder, or playlist name.</span></div> : recentSearchResults.length ? <section className="mobile-result-group"><h2>Recent searches</h2>{recentSearchResults.map(({ query, result }) => result ? <GlobalSearchResultButton key={query} result={result} onClick={() => { setSearch(query); }} showPlayHover={false}/> : null)}</section> : <div className="mobile-search-empty"><strong>Search your music</strong><span>Find songs, artists, albums, folders, and playlists saved on this device.</span></div>}
          </div> : isAndroid && mobileTab === "library" ? <div className="mobile-library-view">
            <div className="mobile-library-list">
              <button className="mobile-library-row" onClick={() => { setMobileTab("home"); navigate({ section: "Favorites" }); }}><Cover className="mobile-library-cover liked-cover" keys={favorites.flatMap((id) => trackMap.get(id)?.artworkKey ?? [])} icon={<Heart size={23} fill="currentColor"/>}/><span><strong>Liked Songs</strong><small>{favorites.length} songs · Playlist</small></span></button>
              <button className="mobile-library-row" onClick={() => { setMobileTab("home"); navigate({ section: "Songs" }); }}><Cover className="mobile-library-cover" keys={coverKeys(tracks)} icon={<Music2 size={23}/>}/><span><strong>All Songs</strong><small>{tracks.length} {tracks.length === 1 ? "song" : "songs"} · Library</small></span></button>
              {(() => { const youtube = youtubePlaylist ?? { id: "michoplay-youtube", name: "YouTube", trackIds: [] }; const item: Collection = { key: youtube.id, title: youtube.name, subtitle: "", tracks: youtube.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) }; return <button className="mobile-library-row" onClick={() => { setMobileTab("home"); openDetail("Playlists", "playlist", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)} icon={<Youtube size={23}/>}/><span><strong>YouTube</strong><small>{item.tracks.length} songs · Playlist</small></span></button>; })()}
              {playlists.filter((playlist) => playlist.name.trim().toLocaleLowerCase() !== "youtube").map((playlist) => { const item: Collection = { key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) }; return <button className="mobile-library-row" key={playlist.id} onClick={() => { setMobileTab("home"); openDetail("Playlists", "playlist", item); }}><Cover className="mobile-library-cover" keys={coverKeys(item.tracks)} icon={<ListMusic size={23}/>}/><span><strong>{playlist.name}</strong><small>{item.tracks.length} songs · Playlist</small></span></button>; })}
              {!playlists.some((playlist) => playlist.name.trim().toLocaleLowerCase() !== "youtube") && <Empty title="Your playlists will appear here" description="Create a playlist or import music using the + button."/>}
            </div>
          </div> : page.section === "Settings" ? <SettingsPage
            roots={roots}
            player={player}
            equalizerBands={equalizerBands}
            equalizerEnabled={equalizerEnabled}
            compact={compact}
            showPanel={showPanel}
            keepScreenAwake={keepScreenAwake}
            onKeepScreenAwake={setKeepScreenAwake}
            globalYoutubeSearchEnabled={globalYoutubeSearchEnabled}
            onGlobalYoutubeSearch={(enabled) => { setGlobalYoutubeSearchEnabled(enabled); localStorage.setItem("michoplay-global-youtube-search-enabled", JSON.stringify(enabled)); }}
            scanning={scanning}
            mobile={isAndroid}
            zoomLevel={zoomLevel}
            onZoom={setZoomLevel}
            onEqualizer={(bands) => {
              setEqualizerBands(bands);
              localStorage.setItem("michoplay-equalizer-bands", JSON.stringify(bands));
              return api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)));
            }}
            onEqualizerPreview={(bands) => api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)))}
            onEqualizerToggle={(enabled) => { setEqualizerEnabled(enabled); localStorage.setItem("michoplay-equalizer-enabled", JSON.stringify(enabled)); void run(() => api.equalizer(equalizerBands, enabled)); }}
            onCompact={setCompact}
            onPanel={setShowPanel}
            onAdd={chooseLibrarySource}
            onRemove={confirmRemoveFolder}
            onRefresh={() => void refresh()}
            onVolume={(volume) => { localStorage.setItem("michoplay-volume", JSON.stringify(volume)); void run(() => api.volume(volume)); }}
            onAutoplay={(enabled) => { localStorage.setItem("michoplay-autoplay", JSON.stringify(enabled)); void run(() => api.autoplay(enabled)); }}
            onSleepTimer={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))}
            onDefaultPlayer={() => isAndroid ? setMessage("Open an audio file from your file manager, choose MichoPlay, then tap Always to make it the default.") : void run(() => api.setDefaultPlayer())}
          /> : <>
            <div className={`collection-heading ${listPage ? "detail-heading" : ""} ${isYoutubePlaylist ? "youtube-detail-heading" : ""}`}>
              {headingArt && listPage && <div className="cover-backdrop" style={{ backgroundImage: `url("${headingArt}")` }}/> }{isAndroid && listPage && <button className="mobile-detail-back" aria-label="Back" onClick={() => { if (history.index > 0) travel(-1); else navigate({ section: "Home" }); }}><ChevronLeft size={24}/></button>}<div className="heading-foreground">{listPage && <Cover className="heading-cover" keys={coverKeys(collectionTracks)} icon={page.detail?.kind === "folder" ? <FolderOpen size={40}/> : page.section === "Favorites" ? <Heart size={36} fill="currentColor"/> : <Music2 size={36}/>}/>}<div className="heading-copy"><h1>{heading}</h1><p>{isYoutubePlaylist ? "Download audio from YouTube by searching or pasting a link." : listPage ? `${collectionTracks.length} songs · ${time(collectionDurationMs)}` : page.section === "Home" ? `${folders.length} music folders` : page.section === "Albums" ? `${albums.length} albums` : page.section === "Artists" ? `${artists.length} artists` : `${playlists.length} playlists`}</p></div></div>
            </div>
          {listPage ? <>{isYoutubePlaylist && <section className="youtube-downloader youtube-downloader-featured" aria-label="Search YouTube audio">
            <div className="youtube-search-header">
            <form className="youtube-search-form" onSubmit={(event) => event.preventDefault()}>
              <label className="youtube-search-input youtube-search-input-featured"><Youtube size={18}/><span className="youtube-search-input-copy"><strong>Search YouTube</strong><input type="text" aria-label="Search YouTube" placeholder="Song, artist, or paste a YouTube link" value={youtubeQuery} onChange={(event) => setYoutubeQuery(event.target.value)}/></span>{youtubeQuery && <button type="button" aria-label="Clear YouTube search" onClick={() => setYoutubeQuery("")}><X size={15}/></button>}</label>
            </form>
            </div>
            {youtubeSearching ? <div className="youtube-search-grid" aria-label="Loading YouTube results">{Array.from({ length: 6 }, (_, index) => <div className="youtube-result-skeleton" key={index}><span/><div><i/><i/></div></div>)}</div>
              : youtubeSearchError ? <p className="youtube-search-empty" role="alert">{youtubeSearchError}</p>
              : youtubeQuery.trim() && youtubeResults.length ? <><div className="youtube-results-scroll" role="region" aria-label="YouTube search results"><div className="youtube-search-grid">{youtubeResults.slice(0, youtubeVisibleLimit).map((result) => <article className="youtube-result-card" key={result.id}>
                <div className="youtube-result-preview">
                  <span className="youtube-result-art">{result.thumbnail ? <img src={result.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/> : <Youtube size={24}/>}<span className="youtube-result-duration">{result.durationSeconds === null ? (result.isPlaylist ? "Playlist" : "YouTube") : durationLabel(result.durationSeconds)}</span></span>
                  <span className="youtube-result-copy"><strong>{result.title}</strong><small>{result.isPlaylist ? "Playlist · MP3 audio" : `Video · ${youtubeResultSize(result)}`}</small></span>
                </div>
                <button className="youtube-result-download" aria-label={`Download ${result.title}`} onClick={() => requestYoutubeDownload(result)} disabled={globalYoutubeDownloadRequested.includes(result.url) || youtubeDownloads.some((download) => download.url === result.url && !["failed", "cancelled"].includes(download.status))}><Download size={14}/><span>{globalYoutubeDownloadRequested.includes(result.url) || youtubeDownloads.some((download) => download.url === result.url && !["failed", "cancelled"].includes(download.status)) ? "Queued" : "Download"}</span></button>
              </article>)}</div></div>{youtubeHasMore && <button className="youtube-load-more" disabled={youtubeLoadingMore} onClick={() => void loadMoreYoutubeFolderResults()}>{youtubeLoadingMore ? "Loading YouTube results…" : "Load more"}</button>}</>
              : youtubeQuery.trim() ? <p className="youtube-search-empty">No videos found. Try a different title or link.</p> : null}
          </section>}
            <div className="collection-tools"><div className="play-actions"><button className={`primary-play ${collectionHasCurrent ? "is-playing" : ""}`} aria-label={collectionHasCurrent && player.isPlaying ? `Pause ${heading}` : `Play ${heading}`} disabled={!visibleTracks.length} onClick={() => { if (collectionHasCurrent) void run(api.toggle); else if (sortedVisibleTracks[0]) playCollection(sortedVisibleTracks[0]); }}>{collectionHasCurrent && player.isPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button><button className={`round-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={!visibleTracks.length} onClick={() => void run(api.shuffle)}><Shuffle size={18}/></button>{selectedPlaylist && <><button className="text-action" onClick={() => newPlaylist(undefined, selectedPlaylist)}><Pencil size={14}/>Rename</button><button className="icon-button" aria-label="Delete playlist" onClick={() => confirmDeletePlaylist(selectedPlaylist)}><Trash2 size={16}/></button></>}</div><div className="collection-tools-right"><label className="collection-search"><Search size={15}/><input aria-label={`Search in ${heading}`} placeholder={`Search in ${heading}`} value={inlineSearch} onChange={(event) => setInlineSearch(event.target.value)}/>{inlineSearch && <button className="icon-button" aria-label="Clear collection search" onClick={() => setInlineSearch("")}><X size={14}/></button>}</label><div className="sort-control"><button className={`sort-trigger ${sortMenuOpen ? "open" : ""}`} aria-label={`Sort by ${trackSortOptions.find((option) => option.key === sortBy)?.label}`} aria-expanded={sortMenuOpen} onClick={() => setSortMenuOpen((open) => !open)}><span>{trackSortOptions.find((option) => option.key === sortBy)?.label}</span><ListFilter size={15}/></button>{sortMenuOpen && <div className="sort-menu" role="menu"><strong className="sort-menu-heading">Sort by</strong>{trackSortOptions.map((option) => <button key={option.key} role="menuitemradio" aria-checked={sortBy === option.key} className={`sort-menu-option ${sortBy === option.key ? "selected" : ""}`} onClick={() => { setSortBy(option.key); localStorage.setItem("michoplay-collection-sort", JSON.stringify(option.key)); setSortMenuOpen(false); }}><span>{option.label}</span>{sortBy === option.key && <Check size={15}/>}</button>)}<span className="sort-menu-divider"/><strong className="sort-menu-heading">View as</strong><button role="menuitemradio" aria-checked={!compact} className={`sort-menu-option view-option ${!compact ? "selected" : ""}`} onClick={() => { setCompact(false); setSortMenuOpen(false); }}><List size={15}/><span>List</span>{!compact && <Check size={15}/>}</button><button role="menuitemradio" aria-checked={compact} className={`sort-menu-option view-option ${compact ? "selected" : ""}`} onClick={() => { setCompact(true); setSortMenuOpen(false); }}><AlignJustify size={15}/><span>Compact</span>{compact && <Check size={15}/>}</button></div>}</div></div></div>{rows(sortedVisibleTracks, page.section === "Favorites" ? "No favorites yet" : page.section === "Recently Played" ? "No listening history yet" : "No songs here")}</> : page.section === "Home" ? <div className="home-section android-home">
            {isAndroid && <div className="mobile-filter-row home-filter-row" role="tablist" aria-label="Home content filters">{(["All", "Folders", "Albums"] as const).map((filter) => <button key={filter} role="tab" aria-selected={mobileHomeFilter === filter} className={mobileHomeFilter === filter ? "selected" : ""} onClick={() => setMobileHomeFilter(filter)}>{filter}</button>)}</div>}
            <div className="home-quick-grid home-library-links" aria-label="Library shortcuts">
              <button className="home-quick-card" onClick={() => navigate({ section: "Albums" })}><Cover className="home-quick-art" keys={albums[0] ? coverKeys(albums[0].tracks) : []} icon={<Disc3 size={21}/>}/><span><strong>Albums</strong><small>{albums.length} {albums.length === 1 ? "album" : "albums"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Artists" })}><Cover className="home-quick-art artist" keys={artists[0] ? coverKeys(artists[0].tracks) : []} icon={<AudioLines size={21}/>}/><span><strong>Artists</strong><small>{artists.length} {artists.length === 1 ? "artist" : "artists"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Recently Played" })}><Cover className="home-quick-art" keys={recentTracks[0] ? [recentTracks[0].artworkKey] : []} icon={<Clock3 size={21}/>}/><span><strong>Recently Played</strong><small>{recentTracks.length} {recentTracks.length === 1 ? "song" : "songs"}</small></span></button>
              <button className="home-quick-card" onClick={() => navigate({ section: "Playlists" })}><Cover className="home-quick-art" keys={playlists[0] ? playlists[0].trackIds.map((id) => trackMap.get(id)?.artworkKey ?? null) : []} icon={<ListMusic size={21}/>}/><span><strong>Playlists</strong><small>{playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}</small></span></button>
              <button className="home-quick-card home-youtube-link" onClick={openYoutubePage}><span className="home-quick-art"><Youtube size={22}/></span><span><strong>YouTube</strong><small>Search and download audio</small></span></button>
            </div>
            {mobileHomeFilter !== "Albums" && <><div className="section-title-row"><h2>Folders</h2><button className="text-action" disabled={scanning} onClick={chooseLibrarySource}><Plus size={15}/>{isAndroid ? "Import music" : "Add root folder"}</button></div><CollectionGrid collections={folders} kind="folder" onOpen={(item) => openDetail("Home", "folder", item)} onPlay={playCardCollection} isCurrentCollection={isCollectionCurrent} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!folders.length && <Empty title={scanning ? "Scanning music…" : "Your music starts here"} description="Import audio files to build your library on this device." action={<button className="primary-button" disabled={scanning} onClick={chooseLibrarySource}><Plus size={15}/>Import audio</button>}/>}</>}
          </div> : page.section === "Albums" ? <CollectionGrid collections={albums} kind="album" onOpen={(item) => openDetail("Albums", "album", item)}/> : page.section === "Artists" ? <CollectionGrid collections={artists} kind="artist" onOpen={(item) => openDetail("Artists", "artist", item)}/> : <div className="home-section"><div className="section-title-row"><h2>Your playlists</h2><button className="outline-button" onClick={() => newPlaylist()}><Plus size={15}/>Create playlist</button></div><CollectionGrid collections={playlists.map((item) => ({ key: item.id, title: item.name, subtitle: "", tracks: item.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []) }))} kind="playlist" onOpen={(item) => openDetail("Playlists", "playlist", item)} onPlay={playCardCollection} isCurrentCollection={isCollectionCurrent} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!playlists.length && <Empty title="No playlists yet" description="Create a playlist and add songs from their action menu."/>}</div>}
          </>}
        </section>
        {showPanel && <><div className="resize-handle panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" onPointerDown={(event) => startResize("panel", event)}/><aside className="now-panel" aria-label={panelView === "downloads" ? "Downloads" : "Now playing and queue"}>
          <div className="now-panel-head"><button className="icon-button now-panel-close" aria-label="Hide side panel" title="Hide side panel" onClick={() => setShowPanel(false)}><PanelRightClose size={16}/></button><div className="side-panel-tabs" role="tablist" aria-label="Side panel"><button role="tab" aria-selected={panelView === "now-playing"} className={panelView === "now-playing" ? "selected" : ""} onClick={() => setPanelView("now-playing")}>Now playing</button><button role="tab" aria-selected={panelView === "downloads"} className={panelView === "downloads" ? "selected" : ""} onClick={() => setPanelView("downloads")}>Downloads{youtubeDownloads.some((item) => item.status === "downloading" || item.status === "queued") && <span className="download-tab-count">{youtubeDownloads.filter((item) => item.status === "downloading" || item.status === "queued").length}</span>}</button></div><div className="now-panel-tools">{panelView === "now-playing" ? <button className="icon-button" aria-label="More options for current song" title="More options" disabled={!nowPlayingTrack} onClick={(event) => { if (nowPlayingTrack) openTrackMenu(nowPlayingTrack, event); }}><MoreHorizontal size={18}/></button> : clearableYoutubeDownloads && <button className="download-clear-button" onClick={() => void clearYoutubeDownloads()}><Trash2 size={13}/>Clear</button>}</div></div>
          {panelView === "downloads" ? <div className="download-manager" aria-live="polite">{youtubeDownloads.length ? youtubeDownloads.map((item) => <article className={`download-item status-${item.status}`} key={item.id}><div className="download-item-main"><div className="download-item-art">{item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/>}<Youtube size={17}/>{item.status === "completed" && <button className="download-art-play" aria-label={`Play ${item.title}`} title="Play downloaded audio" onClick={() => void playYoutubeDownload(item)}><Play size={15} fill="currentColor"/></button>}</div><div className="download-item-copy"><strong>{item.title}</strong>{youtubeDownloadDescription(item) && <small>{youtubeDownloadDescription(item)}</small>}</div></div><div className="download-item-progress"><span style={{ width: `${item.percent ?? (item.status === "downloading" ? 5 : 0)}%` }}/></div><div className="download-item-actions"><span className={`download-status-label ${item.status}`}>{item.status === "completed" ? "Completed" : item.status}</span>{item.status === "completed" ? <button className="icon-button download-menu-trigger" aria-label={`More actions for ${item.title}`} title={`More actions for ${item.title}`} onClick={(event) => openDownloadedTrackMenu(item, event)}><MoreVertical size={16}/></button> : <>{item.status === "downloading" || item.status === "queued" ? <button className="icon-button" aria-label={`Pause ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "pause")}><Pause size={14}/></button> : item.status === "paused" || item.status === "failed" ? <button className="icon-button" aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "resume")}><Play size={14}/></button> : null}{["queued", "downloading", "paused"].includes(item.status) ? <button className="icon-button" aria-label={`Cancel ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "cancel")}><X size={14}/></button> : <button className="icon-button" aria-label={`Remove ${item.title} from downloads`} onClick={() => void controlYoutubeDownload(item.id, "remove")}><X size={14}/></button>}</>}</div></article>) : <div className="download-manager-empty"><Download size={27}/><strong>No downloads yet</strong><span>Choose a video from YouTube search to add it here.</span></div>}</div> : <>{nowPlayingTrack ? <div className={`now-track ${nowPlayingIsActive ? "is-active" : ""}`}><Cover className="now-cover" keys={[nowPlayingTrack.artworkKey]}/><div className="now-title"><div className="now-track-copy"><strong>{nowPlayingTrack.title}</strong><span>{nowPlayingTrack.artist}</span></div><button className={`row-action visible ${favorites.includes(nowPlayingTrack.id) ? "selected" : ""}`} aria-label="Toggle favorite" onClick={() => toggleFavorite(nowPlayingTrack.id)}><Heart size={17} fill={favorites.includes(nowPlayingTrack.id) ? "currentColor" : "none"}/></button></div></div> : <div className="now-empty"><strong>Nothing playing</strong><span>Choose a song from your library.</span></div>}<div className="queue-hint"><ListMusic size={16}/><span>Up next</span><span className="queue-empty">{player.queue.length} songs</span></div><div className="queue-list">{visibleQueue.map((id, index) => { const track = trackMap.get(id); return track ? <div key={id} draggable className={`queue-row ${draggedQueue === index ? "dragging" : ""} ${queueDrop === index ? "drop-target" : ""} ${player.priorityQueue.includes(id) ? "priority" : ""}`} onDragStart={(event) => { setDraggedQueue(index); event.dataTransfer.setData("application/michoplay-queue", String(index)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggedQueue !== null) { event.preventDefault(); setQueueDrop(index); } }} onDrop={(event) => { event.preventDefault(); if (draggedQueue !== null && draggedQueue !== index) void run(() => api.queueMove(draggedQueue, index)); setDraggedQueue(null); setQueueDrop(null); }} onDragEnd={() => { setDraggedQueue(null); setQueueDrop(null); }}><GripVertical className="queue-grip" size={13}/><button className="queue-song" onClick={() => void run(() => api.play(id))}><Cover className="queue-cover" keys={[track.artworkKey]}/><span><b>{track.title}</b><small>{track.artist}</small></span></button><div className="queue-actions"><button className="icon-button" aria-label={`Move ${track.title} up`} disabled={index === 0} onClick={() => void run(() => api.queueMove(index, index - 1))}><ChevronUp size={13}/></button><button className="icon-button" aria-label={`Move ${track.title} down`} disabled={index === player.queue.length - 1} onClick={() => void run(() => api.queueMove(index, index + 1))}><ChevronDown size={13}/></button><button className="icon-button" aria-label={`Remove ${track.title} from queue`} onClick={() => void run(() => api.queueRemove(index))}><X size={13}/></button></div></div> : null; })}</div>{!queueExpanded && player.queue.length > visibleQueue.length && <button className="queue-expand-button" onClick={() => setQueueExpanded(true)}>Show all {player.queue.length} queued songs</button>}{queueExpanded && player.queue.length > 80 && <button className="queue-expand-button" onClick={() => setQueueExpanded(false)}>Show fewer queued songs</button>}{!player.queue.length && <p className="queue-notice">Add songs to the queue from their action menu.</p>}</>}</aside></>}
      </div>
        <footer className="player-bar" aria-label="Playback controls"><div className="now-playing-mini">{footerTrack && <Cover className="mini-cover" keys={[footerTrack.artworkKey]}/>}<div className="track-copy"><span className="track-title">{footerTrack?.title ?? "Nothing playing"}</span><span className="track-artist">{footerTrack?.artist ?? ""}</span></div>{footerTrack && <button className={`row-action visible ${favorites.includes(footerTrack.id) ? "selected" : ""}`} aria-label="Toggle favorite" onClick={() => toggleFavorite(footerTrack.id)}><Heart size={15} fill={favorites.includes(footerTrack.id) ? "currentColor" : "none"}/></button>}</div><div className="transport"><div className="transport-buttons"><button className={`transport-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={!tracks.length} onClick={() => void run(api.shuffle)}><Shuffle size={15}/></button><button className="transport-button" aria-label="Previous track" disabled={!tracks.length} onClick={() => void run(api.previous)}><SkipBack size={17} fill="currentColor"/></button><button className={`play-button ${player.isPlaying ? "is-playing" : ""}`} aria-label={player.isPlaying ? "Pause" : "Play"} disabled={!tracks.length} onClick={() => void run(current ? api.toggle : footerTrack ? () => api.play(footerTrack.id) : api.toggle)}>{player.isPlaying ? <Pause size={16} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</button><button className="transport-button" aria-label="Next track" disabled={!tracks.length} onClick={() => void run(api.next)}><SkipForward size={17} fill="currentColor"/></button><button className={`transport-button repeat-button repeat-control ${player.repeatMode !== "off" ? "active" : ""}`} aria-label={`Repeat ${player.repeatMode}`} disabled={!tracks.length} onClick={() => void run(api.repeat)}>↻{player.repeatMode === "one" && <small>1</small>}</button></div><div className="seek-row"><span>{time(seekPreviewMs ?? player.positionMs)}</span><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => previewSeek(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><span>{time(player.durationMs)}</span></div></div><div className="player-options"><SleepTimerControl player={player} onSet={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))} placement="bar"/><button className="icon-button" aria-label={showPanel ? "Hide now playing panel" : "Show now playing panel"} onClick={() => setShowPanel(!showPanel)}>{showPanel ? <PanelRightClose size={17}/> : <PanelRightOpen size={17}/>}</button><button className="volume-mute-button" aria-label={player.volume === 0 ? "Unmute" : "Mute"} title={player.volume === 0 ? "Unmute" : "Mute"} onClick={toggleMute}>{player.volume === 0 ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button><input type="range" min="0" max="1" step="0.01" value={player.volume} style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))}/><button className={`transport-button full-mode-trigger ${fullMode ? "active" : ""}`} aria-label={fullMode ? "Exit full mode" : "Open full mode"} title={fullMode ? "Exit full mode" : "Full mode"} onClick={toggleFullMode}>{fullMode ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div></footer>
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
            <div className="full-mode-seek"><span>{time(seekPreviewMs ?? player.positionMs)}</span><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => previewSeek(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><span>{time(player.durationMs)}</span></div>
            <div className="full-mode-volume"><button className="volume-mute-button" aria-label={player.volume === 0 ? "Unmute" : "Mute"} title={player.volume === 0 ? "Unmute" : "Mute"} onClick={toggleMute}>{player.volume === 0 ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button><input type="range" min="0" max="1" step="0.01" value={player.volume} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))}/></div></div>
          </div>
          <aside className="full-mode-side"><div className="full-mode-tabs" role="tablist" aria-label="Full mode side panel"><button role="tab" aria-selected={fullPanelTab === "queue"} className={fullPanelTab === "queue" ? "active" : ""} onClick={() => setFullPanelTab("queue")}>Queue</button><button role="tab" aria-selected={fullPanelTab === "browse"} className={fullPanelTab === "browse" ? "active" : ""} onClick={() => setFullPanelTab("browse")}>Browse</button></div>{fullPanelTab === "queue" ? <div className="full-mode-list"><h2>Now playing</h2>{footerTrack && <button className="full-mode-track current" onClick={() => { if (current) void run(api.toggle); }}><Cover className="full-mode-track-cover" keys={[footerTrack.artworkKey]}/><span><strong>{footerTrack.title}</strong><small>{footerTrack.artist}</small></span></button>}<h2>Up next</h2>{visibleQueue.map((id) => { const track = trackMap.get(id); return track ? <button className="full-mode-track" key={id} onClick={() => void run(() => api.play(id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button> : null; })}{!player.queue.length && <p className="full-mode-empty">Nothing queued</p>}</div> : <div className="full-mode-list full-mode-browse">{fullBrowsePlaylistId ? <><button className="full-mode-back" onClick={() => setFullBrowsePlaylistId(null)}><ChevronLeft size={14}/><span>{fullBrowsePlaylist?.name ?? "Playlists"}</span></button>{fullBrowsePlaylistTracks.slice(0, fullBrowseVisibleLimit).map((track) => <button className="full-mode-track" key={track.id} onClick={() => void run(() => api.playCollection(fullBrowsePlaylistTracks.map((item) => item.id), track.id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>)}{fullBrowsePlaylistTracks.length > fullBrowseVisibleLimit && <button className="queue-expand-button" onClick={() => setFullBrowseVisibleLimit((prior) => prior + 100)}>Show more songs ({fullBrowsePlaylistTracks.length - fullBrowseVisibleLimit} remaining)</button>}{!fullBrowsePlaylistTracks.length && <p className="full-mode-empty">This playlist has no songs yet.</p>}</> : <><div className="full-mode-browse-tabs" role="tablist" aria-label="Browse your music"><button role="tab" aria-selected={fullBrowseTab === "playlists"} className={fullBrowseTab === "playlists" ? "active" : ""} onClick={() => setFullBrowseTab("playlists")}>Playlists</button><button role="tab" aria-selected={fullBrowseTab === "library"} className={fullBrowseTab === "library" ? "active" : ""} onClick={() => setFullBrowseTab("library")}>Library</button></div>{fullBrowseTab === "playlists" ? <><h2>Your playlists</h2>{playlists.map((playlist) => { const playlistTracks = playlist.trackIds.flatMap((id) => trackMap.get(id) ? [trackMap.get(id)!] : []); return <button className="full-mode-track full-mode-playlist" key={playlist.id} onClick={() => setFullBrowsePlaylistId(playlist.id)}><Cover className="full-mode-track-cover" keys={coverKeys(playlistTracks)} icon={<ListMusic size={18}/>}/><span><strong>{playlist.name}</strong><small>{playlistTracks.length} {playlistTracks.length === 1 ? "song" : "songs"}</small></span><ChevronRight className="full-mode-playlist-chevron" size={15}/></button>; })}{!playlists.length && <p className="full-mode-empty">Your playlists will appear here.</p>}</> : <><h2>All songs</h2>{tracks.slice(0, fullBrowseVisibleLimit).map((track) => <button className="full-mode-track" key={track.id} onClick={() => void run(() => api.playCollection(tracks.map((item) => item.id), track.id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>)}{tracks.length > fullBrowseVisibleLimit && <button className="queue-expand-button" onClick={() => setFullBrowseVisibleLimit((prior) => prior + 100)}>Show more songs ({tracks.length - fullBrowseVisibleLimit} remaining)</button>}{!tracks.length && <p className="full-mode-empty">Import songs to browse your library.</p>}</>}</>}</div>}</aside>
        </div>
      </section>}
    </section>
    {isAndroid && !mobilePlayerOpen && <>
      <div className={`mobile-mini-player ${page.section === "Settings" ? "settings-open" : ""}`}>
        <button className="mobile-mini-track" onClick={() => setMobilePlayerOpen(true)} disabled={!footerTrack}>{footerTrack && <Cover className="mobile-mini-cover" keys={[footerTrack.artworkKey]}/>}<span><strong>{footerTrack?.title ?? "Nothing playing"}</strong><small>{footerTrack?.artist ?? "Choose a song to start"}</small></span></button>
        {footerTrack && <><button className={`mobile-mini-action ${favorites.includes(footerTrack.id) ? "selected" : ""}`} aria-label={favorites.includes(footerTrack.id) ? "Remove from liked songs" : "Add to liked songs"} onClick={() => toggleFavorite(footerTrack.id)}><Heart size={19} fill={favorites.includes(footerTrack.id) ? "currentColor" : "none"}/></button><button className="mobile-mini-skip" aria-label="Previous track" onClick={() => void run(api.previous)}><SkipBack size={17} fill="currentColor"/></button><button className="mobile-mini-play" aria-label={player.isPlaying ? "Pause" : "Play"} onClick={() => void run(current ? api.toggle : () => api.play(footerTrack.id))}>{player.isPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button><button className="mobile-mini-skip" aria-label="Next track" onClick={() => void run(api.next)}><SkipForward size={17} fill="currentColor"/></button></>}
        <div className="mobile-mini-progress" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={player.durationMs || 0} aria-valuenow={Math.min(player.positionMs, player.durationMs)}><span style={{ width: `${Math.min(100, player.durationMs ? player.positionMs / player.durationMs * 100 : 0)}%` }}/></div>
      </div>
      <nav className={`mobile-bottom-nav ${page.section === "Settings" ? "settings-open" : ""}`} aria-label="Main navigation">
        <button className={mobileTab === "home" && page.section !== "Settings" ? "active" : ""} onClick={() => { setMobileTab("home"); if (page.section !== "Home" || page.detail) navigate({ section: "Home" }); }}><Home size={22}/><span>Home</span></button>
        <button className={mobileTab === "search" ? "active" : ""} onClick={() => { setMobileTab("search"); setSearch(""); }}><Search size={22}/><span>Search</span></button>
        <button className={mobileTab === "library" ? "active" : ""} onClick={() => setMobileTab("library")}><Library size={22}/><span>Your Library</span></button>
        <button className={mobileTab === "youtube" ? "active" : ""} onClick={openYoutubePage}><Youtube size={22}/><span>YouTube</span></button>
        <button className={mobileTab === "downloads" ? "active" : ""} onClick={() => setMobileTab("downloads")}><Download size={22}/><span>Downloads</span></button>
      </nav>
    </>}
    {isAndroid && mobilePlayerOpen && <section className="mobile-player-screen" aria-label="Now playing">
      <header className="mobile-player-top"><button aria-label="Close player" onClick={() => setMobilePlayerOpen(false)}><ChevronDown size={27}/></button><div><span className="brand-mark mobile-player-brand-mark"><AudioLines size={15}/></span><small>Playing from {page.detail?.kind === "playlist" ? "Playlist" : page.detail?.kind ?? "Your library"}</small><strong>{page.detail?.title ?? "Now playing"}</strong></div><button aria-label="Track options" onClick={(event) => footerTrack && openTrackMenu(footerTrack, event)}><MoreVertical size={23}/></button></header>
      {footerTrack ? <>
        <div className="mobile-player-art-swipe" onPointerDown={(event) => { mobileTrackSwipeStartX.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={(event) => { const start = mobileTrackSwipeStartX.current; mobileTrackSwipeStartX.current = null; if (start === null) return; const delta = event.clientX - start; if (delta <= -55) void run(api.next); else if (delta >= 55) void run(api.previous); }} onPointerCancel={() => { mobileTrackSwipeStartX.current = null; }}><Cover className="mobile-player-cover" keys={[footerTrack.artworkKey]}/></div>
        <div className="mobile-player-track"><div><strong>{footerTrack.title}</strong><span>{footerTrack.artist}</span></div><button className={favorites.includes(footerTrack.id) ? "favorite" : ""} aria-label="Toggle favorite" onClick={() => toggleFavorite(footerTrack.id)}><Heart size={24} fill={favorites.includes(footerTrack.id) ? "url(#michoplay-brand-gradient)" : "none"}/></button></div>
        <div className="mobile-seek"><input type="range" min="0" max={Math.max(1, player.durationMs)} value={Math.min(seekPreviewMs ?? player.positionMs, player.durationMs)} style={{ "--range-value": `${Math.min(100, player.durationMs ? (seekPreviewMs ?? player.positionMs) / player.durationMs * 100 : 0)}%` } as CSSProperties} aria-label="Seek" disabled={!current} onChange={(event) => previewSeek(Number(event.target.value))} onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))} onKeyUp={(event) => void commitSeek(Number(event.currentTarget.value))}/><div><span>{time(seekPreviewMs ?? player.positionMs)}</span><span>{time(player.durationMs)}</span></div></div>
        <div className="mobile-player-controls"><button className={`shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" onClick={() => void run(api.shuffle)}><Shuffle size={22}/></button><button aria-label="Previous track" onClick={() => void run(api.previous)}><SkipBack size={27} fill="currentColor"/></button><button className="mobile-big-play" aria-label={player.isPlaying ? "Pause" : "Play"} onClick={() => void run(current ? api.toggle : () => api.play(footerTrack.id))}>{player.isPlaying ? <Pause size={28} fill="currentColor"/> : <Play size={28} fill="currentColor"/>}</button><button aria-label="Next track" onClick={() => void run(api.next)}><SkipForward size={27} fill="currentColor"/></button><button className={`repeat-control ${player.repeatMode !== "off" ? "active" : ""}`} aria-label={`Repeat ${player.repeatMode}`} onClick={() => void run(api.repeat)}>↻{player.repeatMode === "one" && <small className="repeat-one-badge">1</small>}</button></div>
        <div className="mobile-player-actions"><button aria-label="Show queue" onClick={() => setMobileQueueOpen(true)}><ListMusic size={22}/></button></div>
      </> : <div className="mobile-player-empty"><Music2 size={36}/><strong>Nothing playing</strong><span>Choose a song from your library.</span><button onClick={() => { setMobilePlayerOpen(false); setMobileTab("library"); }}>Open library</button></div>}
    </section>}
    {isAndroid && mobileLibraryActionsOpen && <div className="mobile-sheet-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileLibraryActionsOpen(false); }}><section className="mobile-library-action-sheet" role="dialog" aria-modal="true" aria-label="Add to your library"><div className="mobile-sheet-handle"/><h2>Add to your library</h2><button onClick={() => { setMobileLibraryActionsOpen(false); newPlaylist(); }}><ListMusic size={20}/><span><strong>Create playlist</strong><small>Make a playlist and add songs from their menu.</small></span></button><button onClick={() => { setMobileLibraryActionsOpen(false); chooseLibrarySource(); }}><FolderOpen size={20}/><span><strong>Add music folder</strong><small>Use songs in their original folder.</small></span></button><button onClick={() => { setMobileLibraryActionsOpen(false); void chooseAndroidAudioFiles(); }}><Music2 size={20}/><span><strong>Add songs</strong><small>Choose files to scan their folders without copying audio.</small></span></button></section></div>}
    {isAndroid && mobileQueueOpen && <div className="mobile-sheet-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileQueueOpen(false); }}>
      <section className="mobile-queue-sheet" role="dialog" aria-modal="true" aria-label="Playback queue">
        <div className="mobile-sheet-handle" role="presentation" onPointerDown={beginMobileSheetDrag} onPointerUp={(event) => finishMobileSheetDrag(event, () => setMobileQueueOpen(false))} onPointerCancel={() => { mobileSheetDragStartY.current = null; }}/><div className="mobile-queue-heading"><div><h2>Queue</h2><p>Playing {page.detail?.title ?? "from your library"}</p></div><div className="mobile-queue-heading-actions"><button className="mobile-edit-queue" onClick={() => setMobileQueueEditing((editing) => !editing)}>{mobileQueueEditing ? "Done" : "Edit"}</button><button className="mobile-close-sheet" aria-label="Close queue" onClick={() => setMobileQueueOpen(false)}><X size={20}/></button></div></div>
        <div className="mobile-queue-list">{footerTrack && <div className="mobile-queue-row current"><Cover className="mobile-queue-cover" keys={[footerTrack.artworkKey]}/><span><strong>{footerTrack.title}</strong><small>{footerTrack.artist}</small></span><button className="mobile-queue-play" aria-label="Play current song" onClick={() => void run(current ? api.toggle : () => api.play(footerTrack.id))}>{player.isPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button></div>}{visibleQueue.map((id, index) => { const track = trackMap.get(id); return track ? <div className="mobile-queue-row" key={`${id}-${index}`}><button className="mobile-queue-song" onClick={() => void run(() => api.play(id))}><Cover className="mobile-queue-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button><div className="mobile-queue-order">{mobileQueueEditing && <><button aria-label={`Move ${track.title} up`} disabled={index === 0} onClick={() => void run(() => api.queueMove(index, index - 1))}><ChevronUp size={16}/></button><button aria-label={`Move ${track.title} down`} disabled={index === player.queue.length - 1} onClick={() => void run(() => api.queueMove(index, index + 1))}><ChevronDown size={16}/></button></>}<GripVertical size={18}/></div></div> : null; })}{!queueExpanded && player.queue.length > visibleQueue.length && <button className="queue-expand-button" onClick={() => setQueueExpanded(true)}>Show all {player.queue.length} queued songs</button>}{queueExpanded && player.queue.length > 80 && <button className="queue-expand-button" onClick={() => setQueueExpanded(false)}>Show fewer queued songs</button>}{!footerTrack && !player.queue.length && <p className="mobile-queue-empty">Your queue is empty.</p>}</div>
        <div className="mobile-queue-tools"><button className={`shuffle-control ${player.shuffle ? "active" : ""}`} onClick={() => void run(api.shuffle)}><Shuffle size={22}/><span>Shuffle</span></button><button className={`repeat-control ${player.repeatMode !== "off" ? "active" : ""}`} onClick={() => void run(api.repeat)}><span className="repeat-symbol">↻{player.repeatMode === "one" && <small className="repeat-one-badge">1</small>}</span><span>Repeat</span></button><button className={`full-mode-control ${player.sleepTimerRemainingMs !== null || player.sleepTimerAtTrackEnd ? "active" : ""}`} onClick={() => setMobileSleepTimerOpen(true)}><Timer size={22}/><span>{player.sleepTimerRemainingMs !== null ? sleepTimerLabel(player.sleepTimerRemainingMs) : player.sleepTimerAtTrackEnd ? "Track end" : "Timer"}</span></button></div>
      </section>
    </div>}
    {isAndroid && mobileSleepTimerOpen && <div className="mobile-sheet-layer sleep-timer-sheet-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileSleepTimerOpen(false); }}><section className="mobile-sleep-timer-sheet" role="dialog" aria-modal="true" aria-label="Sleep timer"><div className="mobile-sheet-handle"/><h2>Sleep timer</h2>{[[5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"]].map(([minutes, label]) => <button key={minutes} onClick={() => { void run(() => api.sleepTimer(Number(minutes), false)); setMobileSleepTimerOpen(false); }}>{label}</button>)}<button onClick={() => { void run(() => api.sleepTimer(null, true)); setMobileSleepTimerOpen(false); }}>End of track</button>{(player.sleepTimerRemainingMs !== null || player.sleepTimerAtTrackEnd) && <button className="sleep-timer-cancel" onClick={() => { void run(() => api.sleepTimer(null, false)); setMobileSleepTimerOpen(false); }}>Turn off timer</button>}</section></div>}
    {menu && createPortal(<>{isAndroid && <button className="mobile-sheet-backdrop" aria-label="Close song actions" onClick={() => setMenu(null)}/>}<div ref={trackMenuRef} className={`action-menu track-menu ${isAndroid ? "mobile-action-sheet" : ""} ${submenuPlacement === "submenu-inline" ? "submenu-inline" : ""}`} role="menu" style={{ left: menu.x, top: menu.y }}>
      {isAndroid && <div className="mobile-action-heading"><div className="mobile-sheet-handle" role="presentation" onPointerDown={beginMobileSheetDrag} onPointerUp={(event) => finishMobileSheetDrag(event, () => setMenu(null))} onPointerCancel={() => { mobileSheetDragStartY.current = null; }}/><div className="mobile-action-track"><Cover className="mobile-queue-cover" keys={[menu.track.artworkKey]}/><span><strong>{menu.track.title}</strong><small>{menu.track.artist}</small></span></div></div>}
      <div className="playlist-menu-wrap" onMouseEnter={() => setPlaylistSubmenu(true)}><button role="menuitem" aria-expanded={playlistSubmenu} onClick={() => setPlaylistSubmenu(!playlistSubmenu)}><Plus size={15}/>Add to playlist<ChevronRight size={14} className="menu-arrow"/></button>{playlistSubmenu && <div ref={playlistSubmenuRef} className={`playlist-submenu ${submenuPlacement}`}><label className="playlist-find"><Search size={15}/><input autoFocus placeholder="Find a playlist" aria-label="Find a playlist" value={playlistSearch} onChange={(event) => setPlaylistSearch(event.target.value)}/></label><button onClick={() => newPlaylist(menu.track)}><ListMusic size={15}/>New playlist</button><div className="menu-separator"/><div className="playlist-options">{playlists.filter((item) => item.name.toLocaleLowerCase().includes(playlistSearch.toLocaleLowerCase())).map((item) => <button key={item.id} onClick={() => addToPlaylist(item, menu.track)}><ListMusic size={15}/>{item.name}</button>)}</div>{!playlists.length && <p>Create your first playlist above.</p>}</div>}</div>{!isAndroid && <button role="menuitem" onClick={() => { shareTrack(menu.track); setMenu(null); }}><Share2 size={15}/>Share</button>}{selectedPlaylist && <button role="menuitem" onClick={() => confirmRemovePlaylistTrack(selectedPlaylist, menu.track)}><Trash2 size={15}/>Remove from playlist</button>}<button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart size={15}/>{favorites.includes(menu.track.id) ? "Remove from favorites" : "Save to favorites"}</button><button role="menuitem" onClick={() => { void run(() => api.queueAdd(menu.track.id)); setMenu(null); }}><ListMusic size={15}/>Add to queue</button><button role="menuitem" onClick={() => { playCollection(menu.track); setMenu(null); }}><Play size={15}/>Play now</button><div className="menu-separator"/><button role="menuitem" onClick={() => navigate({ section: "Artists", detail: { kind: "artist", key: menu.track.artist, title: menu.track.artist } })}><AudioLines size={15}/>Go to artist</button><button role="menuitem" onClick={() => navigate({ section: "Albums", detail: { kind: "album", key: albumKey(menu.track), title: menu.track.album } })}><Disc3 size={15}/>Go to album</button>
    </div></>, isAndroid ? appFrameRef.current ?? document.body : document.body)}
    {aboutOpen && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title"><div className="about-dialog-head"><div className="about-product"><span className="about-mark"><AudioLines size={21}/></span><strong id="about-title">MichoPlay</strong></div><button className="icon-button" aria-label="Close About" onClick={() => setAboutOpen(false)}><X size={19}/></button></div><p className="about-caption">Desktop music player</p><div className="about-version"><span>Current version</span><strong>{appVersion}</strong></div></section></div>}
    {dialog && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}><form className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title" onSubmit={(event) => { event.preventDefault(); savePlaylist(); }}><div className="dialog-title"><h2 id="playlist-dialog-title">{dialog.playlist ? "Rename playlist" : "Create playlist"}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18}/></button></div><label>Playlist name<input autoFocus required maxLength={120} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)}/></label>{dialog.target && <p>“{dialog.target.title}” will be added.</p>}<button className="primary-button" type="submit" disabled={!playlistName.trim()}>{dialog.playlist ? "Save" : "Create playlist"}</button></form></div>}
    {addSongsPlaylistId && <div className="dialog-overlay add-songs-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setAddSongsPlaylistId(null); }}>
      <section className="add-songs-dialog" role="dialog" aria-modal="true" aria-labelledby="add-songs-title">
        <div className="dialog-title"><h2 id="add-songs-title">Add songs</h2><button className="icon-button" aria-label="Close song picker" onClick={() => setAddSongsPlaylistId(null)}><X size={18}/></button></div>
        <p className="add-songs-description">Choose songs for <strong>{playlists.find((item) => item.id === addSongsPlaylistId)?.name ?? "your playlist"}</strong>.</p>
        <label className="add-songs-search"><Search size={17}/><input type="text" aria-label="Search songs to add" placeholder="Search songs or artists" value={addSongsSearch} onChange={(event) => { setAddSongsSearch(event.target.value); setAddSongsVisibleLimit(100); }}/>{addSongsSearch && <button type="button" aria-label="Clear song search" onClick={() => { setAddSongsSearch(""); setAddSongsVisibleLimit(100); }}><X size={15}/></button>}</label>
        <div className="add-songs-list">
          {addSongsVisibleTracks.map((track) => {
            const alreadyAdded = addSongsAlreadyAddedSet.has(track.id);
            const selected = addSongsSelectedSet.has(track.id);
            return <button type="button" className={`add-songs-row ${selected ? "selected" : ""} ${alreadyAdded ? "already-added" : ""}`} key={track.id} disabled={alreadyAdded} aria-pressed={selected} onClick={() => setAddSongsSelected((prior) => selected ? prior.filter((id) => id !== track.id) : [...prior, track.id])}>
              <Cover className="add-songs-cover" keys={[track.artworkKey]}/><span className="add-songs-copy"><strong>{track.title}</strong><small>{track.artist}</small></span>{alreadyAdded ? <span className="add-songs-added">Added</span> : <span className="add-songs-check">{selected ? <Check size={17}/> : <Plus size={17}/>}</span>}
            </button>;
          })}
          {addSongsVisibleTracks.length < addSongsFilteredTracks.length && <button type="button" className="text-action add-songs-more" onClick={() => setAddSongsVisibleLimit((prior) => prior + 100)}>Show more songs ({addSongsFilteredTracks.length - addSongsVisibleTracks.length} remaining)</button>}
          {!tracks.length && <p className="add-songs-empty">Import music before adding songs to a playlist.</p>}
          {!!tracks.length && !addSongsFilteredTracks.length && <p className="add-songs-empty">No songs match “{addSongsSearch}”. Try another title or artist.</p>}
        </div>
        <div className="add-songs-footer"><span className="add-songs-selected-count">{addSongsSelected.length} selected</span><button type="button" className="primary-button add-songs-submit" disabled={!addSongsSelected.length} onClick={() => { const ids = addSongsSelected; setPlaylists((prior) => prior.map((item) => item.id === addSongsPlaylistId ? { ...item, trackIds: [...item.trackIds, ...ids.filter((id) => !item.trackIds.includes(id))] } : item)); setAddSongsPlaylistId(null); setMessage(`Added ${ids.length} ${ids.length === 1 ? "song" : "songs"} to playlist.`); }}>{addSongsSelected.length ? `Add ${addSongsSelected.length} ${addSongsSelected.length === 1 ? "song" : "songs"}` : "Add songs"}</button></div>
      </section>
    </div>}
    {confirmation && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message"><div className="dialog-title"><h2 id="confirm-title">{confirmation.title}</h2><button className="icon-button" aria-label="Cancel" onClick={() => setConfirmation(null)}><X size={18}/></button></div><p id="confirm-message">{confirmation.message}</p><div className="confirm-actions"><button className="outline-button" onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={confirmation.confirm}>{confirmation.label}</button></div></section></div>}
  </main>;
}

function EqualizerSettings({ bands, enabled, mobile = false, onChange, onPreview, onToggle }: { bands: number[]; enabled: boolean; mobile?: boolean; onChange: (bands: number[]) => void | Promise<unknown>; onPreview: (bands: number[]) => void | Promise<unknown>; onToggle: (enabled: boolean) => void }) {
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
  const dragIndex = useRef<number | null>(null);
  const dragSvg = useRef<SVGSVGElement | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const dragBounds = useRef<{ top: number; height: number } | null>(null);
  const latestBands = useRef<number[] | null>(null);
  const dragChanged = useRef(false);
  const previewTimer = useRef<number | null>(null);
  const pendingPreview = useRef<number[] | null>(null);
  const previewInFlight = useRef(false);
  const previewRequest = useRef<Promise<unknown> | null>(null);
  const lastPreviewAt = useRef(0);
  const chartLine = useRef<SVGPathElement | null>(null);
  const chartFill = useRef<SVGPathElement | null>(null);
  const chartHitTargets = useRef<(SVGCircleElement | null)[]>([]);
  const chartPoints = useRef<(SVGCircleElement | null)[]>([]);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => { onPreviewRef.current = onPreview; }, [onPreview]);
  const visibleBands = latestBands.current ?? bands;
  const allPresets = [...presets, ...savedPresets];
  const activePreset = allPresets.find((preset) => preset.bands.every((gain, index) => gain === visibleBands[index]))?.name;
  const builtInName = (name: string) => presets.some((preset) => preset.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const updateBand = (index: number, value: number) => {
    const next = [...visibleBands]; next[index] = Math.max(-12, Math.min(12, value)); onChange(next);
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name || builtInName(name)) return;
    const next = [...savedPresets.filter((preset) => preset.name.toLocaleLowerCase() !== name.toLocaleLowerCase()), { name, bands: [...visibleBands] }];
    setSavedPresets(next); localStorage.setItem("michoplay-equalizer-presets", JSON.stringify(next));
    setPresetName(""); setSaving(false);
  };
  const chartX = (index: number) => mobile ? 65 + index * 127 : 120 + index * 116;
  const chartY = (gain: number) => 25 + (12 - gain) * (175 / 24);
  const curveFor = (values: number[]) => values.map((gain, index) => [chartX(index), chartY(gain)] as [number, number]);
  const smoothPathFor = (points: [number, number][]) => points.slice(1).reduce((path, [x, y], index) => {
    const [previousX, previousY] = points[index]; const dx = (x - previousX) / 3;
    return path + " C " + (previousX + dx) + " " + previousY + " " + (x - dx) + " " + y + " " + x + " " + y;
  }, "M " + points[0][0] + " " + points[0][1]);
  const fillPathFor = (points: [number, number][], path: string) => "M " + points[0][0] + " 112 L " + points[0][0] + " " + points[0][1] + path.slice(path.indexOf(" C")) + " L " + points[points.length - 1][0] + " 112 Z";
  const curve = curveFor(visibleBands);
  const smoothPath = smoothPathFor(curve);
  const fillPath = fillPathFor(curve, smoothPath);
  const updateChartPreview = (values: number[]) => {
    const points = curveFor(values);
    const path = smoothPathFor(points);
    chartLine.current?.setAttribute("d", path);
    chartFill.current?.setAttribute("d", fillPathFor(points, path));
    points.forEach(([, y], index) => {
      chartHitTargets.current[index]?.setAttribute("cy", String(y));
      chartPoints.current[index]?.setAttribute("cy", String(y));
      chartPoints.current[index]?.setAttribute("aria-valuenow", String(values[index]));
    });
  };
  const queueAudioPreview = (next: number[]) => {
    pendingPreview.current = next;
    if (previewTimer.current !== null || previewInFlight.current) return;
    const flush = () => {
      previewTimer.current = null;
      if (previewInFlight.current) return;
      const pending = pendingPreview.current;
      pendingPreview.current = null;
      if (!pending) return;
      const delay = Math.max(0, 60 - (performance.now() - lastPreviewAt.current));
      if (delay > 0) {
        pendingPreview.current = pending;
        previewTimer.current = window.setTimeout(flush, delay);
        return;
      }
      lastPreviewAt.current = performance.now();
      previewInFlight.current = true;
      const request = (async () => {
        try { await onPreviewRef.current(pending); }
        catch { /* The final value is still applied when the drag ends. */ }
        finally {
          previewInFlight.current = false;
          previewRequest.current = null;
          if (dragIndex.current !== null && pendingPreview.current) queueAudioPreview(pendingPreview.current);
        }
      })();
      previewRequest.current = request;
      void request;
    };
    flush();
  };
  const updateFromPointer = (clientY: number, index: number) => {
    const bounds = dragBounds.current;
    if (!bounds || bounds.height <= 0) return;
    const svgY = (clientY - bounds.top) * 250 / bounds.height;
    const value = Math.max(-12, Math.min(12, Math.round(12 - (svgY - 25) * 24 / 175)));
    const next = [...(latestBands.current ?? visibleBands)];
    if (next[index] === value) return;
    next[index] = value;
    latestBands.current = next;
    dragChanged.current = true;
    updateChartPreview(next);
    queueAudioPreview(next);
  };
  const finishDrag = (event?: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex.current === null) return;
    if (event && dragPointerId.current !== event.pointerId) return;
    const svg = dragSvg.current;
    const pointerId = dragPointerId.current;
    dragIndex.current = null;
    dragSvg.current = null;
    dragPointerId.current = null;
    dragBounds.current = null;
    if (svg && pointerId !== null && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    pendingPreview.current = null;
    const finalBands = latestBands.current;
    if (dragChanged.current && finalBands) {
      const committedBands = [...finalBands];
      const commit = () => { void onChange(committedBands); };
      if (previewRequest.current) void previewRequest.current.finally(commit);
      else commit();
    }
    latestBands.current = null;
    dragChanged.current = false;
  };
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    pendingPreview.current = null;
  }, []);
  return <section className={`eq-section ${mobile ? "mobile-equalizer-editor" : ""}`}>
    <header className="eq-header"><h2>Equalizer</h2><button className={`switch ${enabled ? "on" : ""}`} role="switch" aria-label="Equalizer" aria-checked={enabled} onClick={() => onToggle(!enabled)}><span/></button></header>
    <div className={`equalizer-settings ${enabled ? "" : "disabled"}`}>
      <div className="eq-toolbar"><label className="eq-select-wrap"><span className="sr-only">Equalizer preset</span><select aria-label="Equalizer preset" value={activePreset ?? "manual"} onChange={(event) => { const preset = allPresets.find((item) => item.name === event.target.value); if (preset) onChange([...preset.bands]); }}><option value="manual">Manual</option>{presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}{savedPresets.length > 0 && <optgroup label="My presets">{savedPresets.map((preset) => <option key={`saved-${preset.name}`} value={preset.name}>{preset.name}</option>)}</optgroup>}</select></label>
        {saving ? <form className="eq-save-form" onSubmit={(event) => { event.preventDefault(); savePreset(); }}><input autoFocus maxLength={40} value={presetName} aria-label="Preset name" placeholder="Preset name" onChange={(event) => setPresetName(event.target.value)}/><button type="submit" disabled={!presetName.trim() || builtInName(presetName)}>Save</button><button type="button" onClick={() => { setSaving(false); setPresetName(""); }}>Cancel</button></form> : <button className="eq-save-button" onClick={() => setSaving(true)}>Save preset</button>}
      </div>
      <div className="eq-chart-wrap"><svg className="eq-chart" viewBox="0 0 760 250" preserveAspectRatio="none" role="group" aria-label="Equalizer controls" onPointerMove={(event) => { if (dragPointerId.current === event.pointerId && dragIndex.current !== null) updateFromPointer(event.clientY, dragIndex.current); }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
        <defs>
          <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--blush)" stopOpacity=".42"/><stop offset="64%" stopColor="var(--brand-highlight)" stopOpacity=".24"/><stop offset="100%" stopColor="var(--accent)" stopOpacity=".05"/></linearGradient>
          <linearGradient id="eq-line" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="var(--blush)"/><stop offset="64%" stopColor="#f5eee8"/><stop offset="100%" stopColor="var(--accent)"/></linearGradient>
        </defs>
        <text className="eq-db-label" x="0" y="30">+12dB</text><text className="eq-db-label" x="0" y="117">0dB</text><text className="eq-db-label" x="0" y="205">−12dB</text>
        {curve.map(([x], index) => <line className="eq-gridline" key={`grid-${index}`} x1={x} x2={x} y1="25" y2="200"/>)}<line className="eq-zero-line" x1="65" x2="700" y1="112" y2="112"/>
        <path ref={chartFill} className="eq-fill" d={fillPath}/><path ref={chartLine} className="eq-line" d={smoothPath}/>
        {curve.map(([x, y], index) => <g key={equalizerFrequencies[index]}><circle ref={(node) => { chartHitTargets.current[index] = node; }} className="eq-hit-target" cx={x} cy={y} r="17" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const svg = event.currentTarget.ownerSVGElement; const bounds = svg?.getBoundingClientRect(); if (!svg || !bounds || bounds.height <= 0) return; try { svg.setPointerCapture(event.pointerId); } catch { return; } dragIndex.current = index; dragSvg.current = svg; dragPointerId.current = event.pointerId; dragBounds.current = { top: bounds.top, height: bounds.height }; latestBands.current = [...visibleBands]; dragChanged.current = false; updateFromPointer(event.clientY, index); }}/><circle ref={(node) => { chartPoints.current[index] = node; }} className="eq-point" cx={x} cy={y} r="4" role="slider" tabIndex={0} aria-label={equalizerFrequencies[index]} aria-valuemin={-12} aria-valuemax={12} aria-valuenow={visibleBands[index]} aria-valuetext={`${visibleBands[index]} dB`} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); updateBand(index, visibleBands[index] + 1); } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); updateBand(index, visibleBands[index] - 1); } }}/><text className="eq-frequency-label" x={x} y="232" textAnchor="middle">{equalizerFrequencies[index]}</text></g>)}
      </svg></div>
      <div className="eq-card-footer"><button className="outline-button eq-reset" onClick={() => onChange([0, 0, 0, 0, 0, 0])}>Reset</button></div>
    </div>
  </section>;
}

function MobileSettingsPage({ roots, player, equalizerBands, equalizerEnabled, compact, keepScreenAwake, scanning, zoomLevel, onBack, onKeepScreenAwake, onEqualizer, onEqualizerPreview, onEqualizerToggle, onCompact, onAdd, onRemove, onRefresh, onVolume, onSleepTimer, onZoom, onAbout }: { roots: string[]; player: PlayerSnapshot; equalizerBands: number[]; equalizerEnabled: boolean; compact: boolean; keepScreenAwake: boolean; scanning: boolean; zoomLevel: number; onBack: () => void; onKeepScreenAwake: (value: boolean) => void; onEqualizer: (bands: number[]) => void; onEqualizerPreview: (bands: number[]) => void | Promise<unknown>; onEqualizerToggle: (enabled: boolean) => void; onCompact: (value: boolean) => void; onAdd: () => void; onRemove: (root: string) => void; onRefresh: () => void; onVolume: (value: number) => void; onSleepTimer: (minutes: number | null, atTrackEnd: boolean) => void; onZoom: (value: number) => void; onAbout: () => void }) {
  const [query, setQuery] = useState("");
  const [equalizerOpen, setEqualizerOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  useEffect(() => {
    document.querySelector<HTMLElement>(".content-scroll")?.scrollTo({ top: 0, behavior: "auto" });
  }, []);
  const timerValue = player.sleepTimerAtTrackEnd ? "track" : player.sleepTimerRemainingMs ? String(Math.max(1, Math.ceil(player.sleepTimerRemainingMs / 60_000 / 15) * 15)) : "off";
  const matches = (value: string) => !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const toggle = (label: string, value: boolean, change: (next: boolean) => void) => <button className={`mobile-settings-switch ${value ? "on" : ""}`} role="switch" aria-label={label} aria-checked={value} onClick={(event) => { event.stopPropagation(); change(!value); }}><span/></button>;
  const row = (icon: React.ReactNode, title: string, description: string, trailing: React.ReactNode, onClick?: () => void, className = "") => <div className={`mobile-settings-row ${onClick ? "action" : ""} ${className}`}>{onClick ? <button className="mobile-settings-row-button" onClick={onClick}>{icon}<span><strong>{title}</strong><small>{description}</small></span><span className="mobile-settings-row-trailing">{trailing}</span></button> : <>{icon}<span><strong>{title}</strong><small>{description}</small></span><span className="mobile-settings-row-trailing">{trailing}</span></>}</div>;
  const section = (title: string, children: React.ReactNode, visible: boolean) => visible ? <section className="mobile-settings-section"><h2>{title}</h2><div className="mobile-settings-card">{children}</div></section> : null;
  const eqMatches = matches("equalizer audio sound bass treble");
  const sleepMatches = matches("sleep timer playback");
  const volumeMatches = matches("volume audio playback");
  const libraryMatches = matches("music folders library songs original files");
  const refreshMatches = matches("refresh library scan");
  const downloadsMatches = matches("downloads music folder youtube");
  const appearanceMatches = matches("screen awake display compact song list");
  const zoomMatches = matches("zoom level scale size text dense spacious");
  const aboutMatches = matches("about michoplay version");
  const playbackVisible = eqMatches || sleepMatches || volumeMatches;
  const libraryVisible = libraryMatches || refreshMatches || downloadsMatches;
  const appearanceVisible = appearanceMatches || zoomMatches;
  const aboutVisible = aboutMatches;
  return <div className="mobile-settings-page">
    <header className="mobile-settings-header"><button aria-label="Back to music" onClick={onBack}><ChevronLeft size={27}/></button><h1>Settings</h1><span/></header>
    <label className="mobile-settings-search"><Search size={21}/><input aria-label="Find a setting" placeholder="Find a setting" value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <button aria-label="Clear settings search" onClick={() => setQuery("")}><X size={18}/></button>}</label>
    {section("Playback", <>
      {eqMatches && <div className={`mobile-settings-row mobile-settings-eq ${equalizerOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={equalizerOpen} onClick={() => setEqualizerOpen((open) => !open)}><ListFilter size={21}/><span><strong>Equalizer</strong><small>{equalizerEnabled ? "On · Shape the sound for your headphones." : "Off · Playback stays flat."}</small></span><span className="mobile-settings-row-trailing"><span className="mobile-settings-value">{equalizerEnabled ? "On" : "Off"}</span>{equalizerOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{equalizerOpen && <div className="mobile-eq-panel"><div className="mobile-eq-toggle"><span>Enable equalizer</span>{toggle("Enable equalizer", equalizerEnabled, onEqualizerToggle)}</div><EqualizerSettings bands={equalizerBands} enabled={equalizerEnabled} mobile onChange={onEqualizer} onPreview={onEqualizerPreview} onToggle={onEqualizerToggle}/></div>}</div>}
      {sleepMatches && row(<Timer size={21}/>, "Sleep timer", player.sleepTimerAtTrackEnd ? "Stops at the end of this song." : player.sleepTimerRemainingMs ? `Stops in ${sleepTimerLabel(player.sleepTimerRemainingMs)}.` : "Stop playback after a set time.", <select className="mobile-settings-select" aria-label="Sleep timer" value={timerValue} onChange={(event) => { const value = event.target.value; onSleepTimer(value === "off" || value === "track" ? null : Number(value), value === "track"); }} onClick={(event) => event.stopPropagation()}><option value="off">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="track" disabled={!player.currentTrackId}>Track end</option></select>)}
      {volumeMatches && row(<Volume2 size={21}/>, "Volume", "Audio output level.", <span className="mobile-settings-volume"><input type="range" min="0" max="1" step="0.01" value={player.volume} aria-label="Volume" style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} onChange={(event) => onVolume(Number(event.target.value))}/><output>{Math.round(player.volume * 100)}%</output></span>)}
    </>, playbackVisible)}
    {section("Library & storage", <>
      {libraryMatches && <div className={`mobile-settings-row mobile-settings-folders ${foldersOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={foldersOpen} onClick={() => setFoldersOpen((open) => !open)}><FolderOpen size={21}/><span><strong>Music folders</strong><small>{roots.length ? `${roots.length} folder${roots.length === 1 ? "" : "s"} · Songs stay in place.` : "Add a folder to find music on your phone."}</small></span><span className="mobile-settings-row-trailing">{foldersOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{foldersOpen && <div className="mobile-folder-manager">{roots.length ? roots.map((root) => <div className="mobile-folder-row" key={root}><FolderOpen size={16}/><span className={`mobile-folder-path ${root.length > 34 ? "long" : ""}`} title={root}><span className="mobile-folder-path-track"><span>{root}</span>{root.length > 34 && <span aria-hidden="true">{root}</span>}</span></span><button aria-label={`Remove ${root} from library`} disabled={scanning} onClick={(event) => { event.stopPropagation(); onRemove(root); }}><Trash2 size={16}/></button></div>) : <p className="mobile-folder-empty">No music folders added yet.</p>}<button className="mobile-folder-add" disabled={scanning} onClick={onAdd}><Plus size={15}/>{scanning ? "Scanning…" : "Add music folder"}</button></div>}</div>}
      {refreshMatches && row(<RefreshCw size={21}/>, "Refresh library", scanning ? "Scanning your music…" : "Look for new songs and artwork.", scanning ? <span className="mobile-settings-spinner"/> : <ChevronRight size={18}/>, scanning ? undefined : onRefresh)}
      {downloadsMatches && row(<Download size={21}/>, "Download location", "Music / MichoPlay / YouTube", <span className="mobile-settings-value">Phone</span>)}
    </>, libraryVisible)}
    {section("Look & feel", <>
      {appearanceMatches && row(<Settings2 size={21}/>, "Keep screen awake", "Keep the display on while you listen.", toggle("Keep screen awake", keepScreenAwake, onKeepScreenAwake))}
      {appearanceMatches && row(<List size={21}/>, "Compact song list", "Fit more songs on the library screen.", toggle("Compact song list", compact, onCompact))}
      {zoomMatches && <div className={`mobile-settings-row mobile-settings-zoom ${zoomOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={zoomOpen} onClick={() => setZoomOpen((open) => !open)}><Maximize2 size={21}/><span><strong>Zoom level</strong><small>{zoomLevel}% · Adjust the size of the app interface.</small></span><span className="mobile-settings-row-trailing"><span className="mobile-settings-value">{zoomLevel}%</span>{zoomOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{zoomOpen && <div className="mobile-zoom-panel"><div className="mobile-zoom-presets"><button className={zoomLevel === 70 ? "selected" : ""} onClick={() => onZoom(70)}>Dense</button><button className={zoomLevel === 120 ? "selected" : ""} onClick={() => onZoom(120)}>Default</button><button className={zoomLevel === 130 ? "selected" : ""} onClick={() => onZoom(130)}>Spacious</button></div><input className="mobile-zoom-range" type="range" min="70" max="130" step="10" value={zoomLevel} aria-label="Zoom level" style={{ "--zoom-progress": `${(zoomLevel - 70) / 60 * 100}%` } as CSSProperties} onChange={(event) => onZoom(Number(event.target.value))}/><div className="mobile-zoom-ticks" aria-hidden="true">{[70, 80, 90, 100, 110, 120, 130].map((value) => <span key={value} className={zoomLevel === value ? "active" : ""}>{value}%</span>)}</div><button className="mobile-zoom-reset" onClick={() => onZoom(120)}>Reset to default</button></div>}</div>}
    </>, appearanceVisible)}
    {section("About", <>{aboutMatches && row(<AudioLines size={21}/>, "About MichoPlay", `Version ${packageInfo.version} · Offline music`, <ChevronRight size={18}/>, onAbout)}</>, aboutVisible)}
    {query.trim() && !playbackVisible && !libraryVisible && !appearanceVisible && !aboutVisible && <div className="mobile-settings-empty"><Search size={25}/><strong>No settings found</strong><span>Try a different word.</span></div>}
  </div>;
}

function MobileAboutPage({ version, onBack, onOpenUrl, onShare }: { version: string; onBack: () => void; onOpenUrl: (url: string) => void; onShare: () => void }) {
  return <div className="mobile-about-page">
    <header className="mobile-about-header"><button aria-label="Back to settings" onClick={onBack}><ChevronLeft size={27}/></button><h1>About</h1></header>
    <section className="mobile-about-hero">
      <div className="mobile-about-mark"><AudioLines size={46}/></div>
      <h2>MichoPlay</h2>
      <span className="mobile-about-version">Version {version}</span>
      <div className="mobile-about-actions"><button onClick={() => onOpenUrl(michoplayGithubUrl)}><Github size={18}/>GitHub</button><button onClick={() => onOpenUrl(michoplayIssueUrl)}><Bug size={18}/>Report issue</button></div>
    </section>
    <section className="mobile-about-section"><h2>Links</h2><div className="mobile-about-links"><button onClick={() => onOpenUrl(michoplayDeveloperUrl)}><Globe2 size={19}/><span><strong>Developer</strong></span><ChevronRight size={18}/></button><button onClick={() => onOpenUrl(michoplayWebsiteUrl)}><AudioLines size={19}/><span><strong>MichoPlay website</strong></span><ChevronRight size={18}/></button><button onClick={onShare}><Share2 size={19}/><span><strong>Share MichoPlay</strong></span><ChevronRight size={18}/></button></div></section>
   
  </div>;
}

function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-library"><h2>{title}</h2><p>{description}</p>{action}</div>;
}
function GlobalSearchResultButton({ result, onClick, isPlaying = false, showPlayHover = true }: { result: GlobalSearchResult; onClick: () => void; isPlaying?: boolean; showPlayHover?: boolean }) {
  const icon = result.type === "Song" ? <Music2 size={18}/> : result.type === "Artist" ? <AudioLines size={18}/> : result.type === "Folder" ? <FolderOpen size={18}/> : result.type === "Playlist" ? <ListMusic size={18}/> : <Disc3 size={18}/>;
  const hasPlaybackHover = showPlayHover && result.type === "Song";
  return <button className={`global-search-result ${hasPlaybackHover ? "has-playback-hover" : ""}`} role="option" aria-selected={false} aria-label={`${isPlaying ? "Pause" : "Play"} ${result.title}`} onClick={onClick}><Cover className={`global-search-cover ${result.type === "Artist" ? "artist-art" : ""}`} keys={[result.artworkKey]} icon={icon}/><span className="search-result-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span>{hasPlaybackHover && <span className="search-result-play" aria-hidden="true">{isPlaying ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</span>}</button>;
}
function CollectionGrid({ collections, kind, onOpen, onPlay, isCurrentCollection, playingId, isPlaying = false }: { collections: Collection[]; kind: Detail["kind"]; onOpen: (collection: Collection) => void; onPlay?: (collection: Collection) => void; isCurrentCollection?: (collection: Collection) => boolean; playingId?: number | null; isPlaying?: boolean }) {
  const icon = kind === "folder" ? <FolderOpen size={30}/> : kind === "artist" ? <AudioLines size={30}/> : kind === "playlist" ? <ListMusic size={30}/> : <Disc3 size={30}/>;
  return <div className={`media-grid collection-grid ${kind}-grid`}>{collections.map((item) => {
    const active = isCurrentCollection ? isCurrentCollection(item) : item.tracks.some((track) => track.id === playingId);
    return <article className={`media-card ${kind}-card ${active ? "playing" : ""}`} key={item.key}>
      <button className="collection-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}><Cover className="card-cover" keys={coverKeys(item.tracks)} icon={icon}/><strong title={item.title}>{item.title}</strong><small>{item.subtitle && kind === "album" ? `${item.subtitle} · ` : ""}{item.tracks.length} songs</small></button>
      {onPlay && item.tracks.length > 0 && <button className={`collection-play-button ${active && isPlaying ? "active" : ""}`} aria-label={`${active && isPlaying ? "Pause" : "Play"} ${item.title}`} title={active && isPlaying ? "Pause" : "Play"} onClick={() => onPlay(item)}>{active && isPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>}
    </article>;
  })}</div>;
}
const TrackRows = memo(function TrackRows({ items, player, favorites, compact, playCounts, showPlayCount = false, onPlay, onFavorite, onMenu, emptyTitle, emptyMessage, emptyAction }: { items: Track[]; player: PlayerSnapshot; favorites: Set<number>; compact: boolean; playCounts?: Map<number, number>; showPlayCount?: boolean; onPlay: (track: Track) => void; onFavorite: (id: number) => void; onMenu: (track: Track, event: MouseEvent) => void; emptyTitle: string; emptyMessage: string; emptyAction?: React.ReactNode }) {
  const [dismissedPlayControl, setDismissedPlayControl] = useState<number | null>(null);
  const [range, setRange] = useState({ start: 0, end: 80 });
  const listRef = useRef<HTMLDivElement>(null);
  const rowHeight = compact ? 43 : 54;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const root = list.closest<HTMLElement>(".content-scroll");
    const update = () => {
      const rect = list.getBoundingClientRect();
      const top = root ? rect.top - root.getBoundingClientRect().top + root.scrollTop : rect.top + window.scrollY;
      const scrollTop = root ? root.scrollTop : window.scrollY;
      const height = root ? root.clientHeight : window.innerHeight;
      const relativeTop = scrollTop - top;
      const firstVisible = Math.max(0, Math.floor(relativeTop / rowHeight));
      const lastVisible = Math.min(items.length, Math.ceil((relativeTop + height) / rowHeight));
      const next = {
        start: Math.max(0, firstVisible - 8),
        end: Math.min(items.length, Math.max(firstVisible, lastVisible) + 8),
      };
      setRange((prior) => prior.start === next.start && prior.end === next.end ? prior : next);
    };
    update();
    const scrollTarget: HTMLElement | Window = root ?? window;
    scrollTarget.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (root) observer?.observe(root);
    observer?.observe(list);
    return () => {
      scrollTarget.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [items, rowHeight]);
  const visibleItems = items.slice(range.start, range.end);
  return <div className="track-table" role="table" aria-label="Songs"><div className="table-head" role="row"><span role="columnheader">#</span><span role="columnheader">Title</span><span role="columnheader">Album</span><span role="columnheader">Artist</span><span role="columnheader"><Clock3 size={13}/></span></div>{items.length ? <div ref={listRef} className="track-list virtual-track-list" role="rowgroup" style={{ height: items.length * rowHeight, position: "relative" }}>{visibleItems.map((track, offset) => { const index = range.start + offset; const active = player.currentTrackId === track.id && player.isPlaying; const playCount = playCounts?.get(track.id) ?? 0; const playControlDismissed = dismissedPlayControl === track.id; const playTrack = () => { setDismissedPlayControl(track.id); onPlay(track); }; const favorite = favorites.has(track.id); return <div role="row" key={track.id} className={`track-row ${player.currentTrackId === track.id ? "playing" : ""} ${playControlDismissed ? "suppress-row-play" : ""}`} style={{ position: "absolute", top: index * rowHeight, left: 0, right: 0, height: rowHeight }} onMouseLeave={() => { if (playControlDismissed) setDismissedPlayControl(null); }} onContextMenu={(event) => onMenu(track, event)}><button className="track-number" aria-label={`${active ? "Pause" : "Play"} ${track.title}`} onClick={playTrack}>{active ? <span className="playing-animation" aria-label="Playing"><i/><i/><i/></span> : <span className="row-index">{index + 1}</span>}{active ? <Pause className="row-play" size={15} fill="currentColor"/> : <Play className="row-play" size={15} fill="currentColor"/>}</button><div className="track-title-cell" role="cell"><Cover className="row-cover" keys={[track.artworkKey]}/><button className="track-name" onClick={playTrack}><strong>{track.title}</strong><small>{track.artist}{showPlayCount && playCount > 0 && <span className="track-play-count"> · {playCount} {playCount === 1 ? "play" : "plays"}</span>}</small></button></div><span className="track-album" role="cell">{track.album}</span><span className="track-artist-cell" role="cell">{track.artist}</span><span className="track-actions" role="cell"><button className={`row-action favorite-action ${favorite ? "selected" : ""}`} aria-label={favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => onFavorite(track.id)}><Heart size={15} fill={favorite ? "currentColor" : "none"}/></button><span className="track-duration">{time(track.durationMs)}</span><button className="row-action menu-trigger" aria-label={`Actions for ${track.title}`} onClick={(event) => onMenu(track, event)}><MoreHorizontal size={17}/></button></span></div>;})}</div> : <Empty title={emptyTitle} description={emptyMessage} action={emptyAction}/>}</div>;
});
function SettingsPage({ roots, player, equalizerBands, equalizerEnabled, compact, showPanel, keepScreenAwake, onKeepScreenAwake, globalYoutubeSearchEnabled, onGlobalYoutubeSearch, scanning, mobile, zoomLevel, onZoom, onEqualizer, onEqualizerPreview, onEqualizerToggle, onCompact, onPanel, onAdd, onRemove, onRefresh, onVolume, onAutoplay, onSleepTimer, onDefaultPlayer }: { roots: string[]; player: PlayerSnapshot; equalizerBands: number[]; equalizerEnabled: boolean; compact: boolean; showPanel: boolean; keepScreenAwake: boolean; onKeepScreenAwake: (value: boolean) => void; globalYoutubeSearchEnabled: boolean; onGlobalYoutubeSearch: (value: boolean) => void; scanning: boolean; mobile: boolean; zoomLevel: number; onZoom: (value: number) => void; onEqualizer: (bands: number[]) => void; onEqualizerPreview: (bands: number[]) => void | Promise<unknown>; onEqualizerToggle: (enabled: boolean) => void; onCompact: (value: boolean) => void; onPanel: (value: boolean) => void; onAdd: () => void; onRemove: (root: string) => void; onRefresh: () => void; onVolume: (value: number) => void; onAutoplay: (value: boolean) => void; onSleepTimer: (minutes: number | null, atTrackEnd: boolean) => void; onDefaultPlayer: () => void }) {
  const timerValue = player.sleepTimerAtTrackEnd ? "track" : player.sleepTimerRemainingMs ? String(Math.max(1, Math.ceil(player.sleepTimerRemainingMs / 60_000 / 15) * 15)) : "off";
  const remaining = player.sleepTimerRemainingMs == null ? "" : `${Math.floor(player.sleepTimerRemainingMs / 60_000)}:${String(Math.floor((player.sleepTimerRemainingMs % 60_000) / 1000)).padStart(2, "0")}`;
  const toggle = (title: string, description: string, value: boolean, change: (value: boolean) => void) => <div className="setting-row"><div><strong>{title}</strong><small>{description}</small></div><button className={`switch ${value ? "on" : ""}`} role="switch" aria-label={title} aria-checked={value} onClick={() => change(!value)}><span/></button></div>;
  return <div className="settings-page"><div className="settings-title"><h1>Settings</h1></div><section className="settings-group"><h2>Playback</h2>{toggle("Autoplay", "Continue with the next song when playback ends.", player.autoplay, onAutoplay)}{!mobile && toggle("YouTube in global search", "Include online YouTube matches alongside songs in your library.", globalYoutubeSearchEnabled, onGlobalYoutubeSearch)}
    <EqualizerSettings bands={equalizerBands} enabled={equalizerEnabled} onChange={onEqualizer} onPreview={onEqualizerPreview} onToggle={onEqualizerToggle}/><div className="setting-row sleep-timer-row"><div><strong>Sleep timer</strong><small>{player.sleepTimerAtTrackEnd ? "Playback will stop at the end of this song." : remaining ? `Playback stops in ${remaining}.` : "Stop playback after a set time or at the end of a song."}</small></div><select className="sleep-timer-select" aria-label="Sleep timer" value={timerValue} onChange={(event) => { const value = event.target.value; onSleepTimer(value === "off" || value === "track" ? null : Number(value), value === "track"); }}><option value="off">Off</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="track" disabled={!player.currentTrackId}>End of current song</option></select></div>
    {mobile && <div className="setting-row"><div><strong>Background playback</strong><small>Keep playing with lock-screen and notification controls.</small></div><span className="setting-value">On</span></div>}<div className="setting-row"><div><strong>Volume</strong><small>Audio output level</small></div><div className="settings-volume"><input type="range" min="0" max="1" step="0.01" value={player.volume} style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} aria-label="Playback volume" onChange={(event) => onVolume(Number(event.target.value))}/><span className="setting-value">{Math.round(player.volume * 100)}%</span></div></div></section>
    <section className="settings-group zoom-settings"><h2>Zoom level</h2><p className="zoom-description">Adjusting the zoom level can help you make the most of MichoPlay and adapt it to your preferences or needs.</p><p className="zoom-shortcuts">Keyboard controls are listed below.</p><div className="zoom-control"><div className="zoom-landmarks"><button className="zoom-landmark" onClick={() => onZoom(70)} aria-label="Set zoom to 70 percent"><span className="zoom-preview dense" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i}/>)}</span><span>Dense</span></button><button className="zoom-landmark" onClick={() => onZoom(mobile ? 120 : 100)} aria-label={`Set zoom to ${mobile ? 120 : 100} percent`}><span className="zoom-preview default" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i}/>)}</span><span>Default</span></button><button className="zoom-landmark" onClick={() => onZoom(130)} aria-label="Set zoom to 130 percent"><span className="zoom-preview spacious" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</span><span>Spacious</span></button></div><input className="zoom-range" type="range" min="70" max="130" step="10" value={zoomLevel} style={{ "--zoom-progress": `${(zoomLevel - 70) / 60 * 100}%` } as CSSProperties} aria-label="Zoom level" aria-valuetext={`${zoomLevel}%`} onChange={(event) => onZoom(Number(event.target.value))}/><div className="zoom-ticks" aria-hidden="true">{[70, 80, 90, 100, 110, 120, 130].map((value) => <span key={value} className={zoomLevel === value ? "active" : ""}>{value}%</span>)}</div><div className="zoom-reset-row"><button className="outline-button" onClick={() => onZoom(mobile ? 120 : 100)}>Reset</button></div></div></section>
    <section className="settings-group shortcuts-settings"><h2>Keyboard shortcuts</h2><div className="shortcut-list">{keyboardShortcuts.map(({ action, keys }) => <div className="shortcut-row" key={action}><span>{action}</span><span className="shortcut-keys">{keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}</span></div>)}</div></section><section className="settings-group"><h2>Your library</h2><div className="setting-row"><div><strong>Music folders</strong><small>{mobile ? "MichoPlay reads songs from their original folders. Only metadata and artwork are cached." : "Music is scanned recursively inside each root."}</small></div><button className="outline-button" disabled={scanning} onClick={onAdd}><Plus size={15}/>Add folder</button></div>{roots.map((root) => <div className="root-row" key={root}><FolderOpen size={17}/><span title={root}>{root}</span><button className="icon-button" disabled={scanning} aria-label={`Remove ${root} from library`} onClick={() => onRemove(root)}><Trash2 size={15}/></button></div>)}{!roots.length && <p className="no-roots">No music folders added.</p>}<button className="outline-button refresh-button" disabled={scanning || !roots.length} onClick={onRefresh}><RefreshCw size={14}/>{scanning ? "Refreshing…" : "Refresh library"}</button></section><section className="settings-group"><h2>System integration</h2><div className="setting-row"><div><strong>Default music player</strong><small>{mobile ? "Choose MichoPlay from Android’s Open with menu, then select Always to make it the default." : "MichoPlay can open audio files from your file manager. Installed desktop builds register common audio formats."}</small></div><button className="outline-button" onClick={onDefaultPlayer}>{mobile ? "How to set default" : "Set as default"}</button></div></section><section className="settings-group"><h2>Display</h2>{toggle("Now playing panel", "Show artwork and the adjustable playback queue.", showPanel, onPanel)}{toggle("Keep screen awake in full mode", "Prevent the display from sleeping while the full player is open. Off by default.", keepScreenAwake, onKeepScreenAwake)}{toggle("Compact song list", "Fit more songs in the library view.", compact, onCompact)}</section></div>;
}
