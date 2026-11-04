import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion, onBackButtonPress } from "@tauri-apps/api/app";
import {
  AudioLines, ArrowRight, Disc3, Heart, Home, ListMusic, Music2, Play, Plus, Search, Shuffle,
  SkipBack, SkipForward, Volume2, VolumeX, Settings2, MoreHorizontal, FolderOpen, Pause,
  Trash2, X, PanelRightClose, PanelRightOpen, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, GripVertical, RefreshCw, Pencil, Youtube,
  ListFilter, List, AlignJustify, Check, Library, Timer, Download, EyeOff,
  Maximize2, Minimize2, MoreVertical, Github, Globe2, Bug,
} from "lucide-react";
import { api } from "../lib/api";
import { saveStoredData, stored } from "../lib/storage";
import type { PlayerSnapshot, Track, YoutubeDownload, YoutubeSearchResult } from "../lib/api";
import { MobileAboutPage, MobileSettingsPage, SettingsPage } from "../screens/settings";
import { HomeScreen } from "../screens/home";
import { MobileDownloadsScreen } from "../screens/downloads";
import { MobileLibraryScreen } from "../screens/library";
import { TrackRows } from "../screens/library/TrackRows";
import { MobileSearchScreen } from "../screens/search";
import { SearchResultButton as GlobalSearchResultButton } from "../screens/search/GlobalSearchResultButton";
import { Empty } from "../components/EmptyState";
import { CollectionGrid } from "../components/library/CollectionGrid";
import packageInfo from "../../package.json";
import { youtubeDownloadErrorText, youtubeDownloadProgressText, youtubeResultSizeText } from "../lib/youtube-size";
import { Cover, useArtwork } from "./Artwork";

type Section = "Home" | "Songs" | "Albums" | "Artists" | "Playlists" | "Folders" | "Favorites" | "Recently Played" | "Settings";
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
const navigation: { label: Section; icon: typeof Home }[] = [
  { label: "Home", icon: Home }, { label: "Songs", icon: Music2 },
  { label: "Playlists", icon: ListMusic }, { label: "Favorites", icon: Heart },
];
const initialPlayer: PlayerSnapshot = { currentTrackId: null, isPlaying: false, positionMs: 0, durationMs: 0, volume: 0.75, shuffle: false, repeatMode: "off", queue: [], priorityQueue: [], autoplay: true, sleepTimerRemainingMs: null, sleepTimerAtTrackEnd: false, equalizerBands: Array(6).fill(0), equalizerEnabled: false };
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
function normalizedAudioPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/\/\?\//, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}
function tracksForDownload(item: YoutubeDownload, tracks: Track[], youtubeDirectory: string) {
  if (item.filePaths?.length) {
    const byPath = new Map(tracks.map((track) => [normalizedAudioPath(track.path), track]));
    const seen = new Set<number>();
    return item.filePaths.flatMap((path) => {
      const track = byPath.get(normalizedAudioPath(path));
      if (!track || seen.has(track.id)) return [];
      seen.add(track.id);
      return [track];
    });
  }
  if (item.isPlaylist) return [];
  const candidates = tracks.filter((track) => normalizedAudioPath(track.rootPath) === normalizedAudioPath(youtubeDirectory));
  const title = item.title.trim().toLocaleLowerCase();
  const match = candidates.find((track) => normalizedAudioPath(track.path).split("/").pop()?.replace(/\.mp3$/i, "").trim().toLocaleLowerCase() === title)
    ?? candidates.find((track) => track.title.trim().toLocaleLowerCase() === title);
  return match ? [match] : [];
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
  const [hiddenTrackIds, setHiddenTrackIds] = useState<number[]>(() => {
    const saved = stored<unknown>("hidden-tracks", []);
    return Array.isArray(saved) ? saved.filter((id): id is number => Number.isSafeInteger(id)) : [];
  });
  const [player, setPlayer] = useState<PlayerSnapshot>(initialPlayer);
  const lastAudibleVolume = useRef(Math.max(0.01, stored("volume", 0.75)));
  const [fullMode, setFullMode] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileAboutOpen, setMobileAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(packageInfo.version);
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null);
  const [deferredUpdatePrompt, setDeferredUpdatePrompt] = useState<string | null>(null);
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
  const [showPanel, setShowPanel] = useState(() => stored("show-now-playing", false));
  const [panelView, setPanelView] = useState<"now-playing" | "downloads">("now-playing");
  const [compact, setCompact] = useState(() => stored("compact", false));
  const [sortBy, setSortBy] = useState<TrackSort>(() => {
    const saved = stored<string>("collection-sort", "custom");
    return trackSortOptions.some((option) => option.key === saved) ? saved as TrackSort : "custom";
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"home" | "search" | "library" | "youtube" | "downloads">("home");
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
    saveStoredData("volume", JSON.stringify(volume));
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
      return scanned;
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
    if (!availableUpdate || deferredUpdatePrompt === availableUpdate) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeferredUpdatePrompt(availableUpdate);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [availableUpdate, deferredUpdatePrompt]);
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
        setAvailableUpdate(latestVersion);
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
      if (newlyCompletedIds.length) void syncYoutubeLibrary();
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
      saveStoredData("playback-session", JSON.stringify({ currentTrackId: state.currentTrackId, queue, positionMs: state.positionMs, isPlaying: state.isPlaying } satisfies SavedPlaybackSession));
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
          const available = new Set(tracks.filter((track) => !hiddenTrackIds.includes(track.id)).map((track) => track.id));
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
  }, [tracks, hiddenTrackIds]);
  useEffect(() => { saveStoredData("library-roots", JSON.stringify(roots)); }, [roots]);
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
    saveStoredData("zoom-level", JSON.stringify(zoomLevel));
    saveStoredData("zoom-level-customized", "true");
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
  useEffect(() => { saveStoredData("favorites", JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { saveStoredData("hidden-tracks", JSON.stringify(hiddenTrackIds)); }, [hiddenTrackIds]);
  useEffect(() => { saveStoredData("playlists", JSON.stringify(playlists)); }, [playlists]);
  useEffect(() => { saveStoredData("listening-history", JSON.stringify(listeningHistory)); }, [listeningHistory]);
  useEffect(() => { saveStoredData("recent-searches", JSON.stringify(recentSearches)); }, [recentSearches]);
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
  useEffect(() => { saveStoredData("sidebar-width", JSON.stringify(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { saveStoredData("panel-width", JSON.stringify(panelWidth)); }, [panelWidth]);
  useEffect(() => { saveStoredData("show-now-playing", JSON.stringify(showPanel)); }, [showPanel]);
  useEffect(() => { saveStoredData("keep-screen-awake-in-full-mode", JSON.stringify(keepScreenAwake)); }, [keepScreenAwake]);
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
  useEffect(() => { saveStoredData("compact", JSON.stringify(compact)); }, [compact]);
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
    let matching = tracksForDownload(item, tracks, youtubeDirectory);
    if (!matching.length) matching = tracksForDownload(item, await syncYoutubeLibrary(), youtubeDirectory);
    if (matching.length) {
      const trackIds = matching.map((track) => track.id);
      await run(() => api.playCollection(trackIds, trackIds[0]));
    } else setMessage("The downloaded audio could not be found in Music/YouTube. Try refreshing the library.");
  }
  function openDownloadedTrackMenu(item: YoutubeDownload, event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const track = tracksForDownload(item, tracks, youtubeDirectory)[0];
    if (track) { openTrackMenuAt(track, rect); return; }
    if (!youtubeDirectory) { setMessage("This download is still being added to your library. Try again shortly."); return; }
    void syncYoutubeLibrary().then((scanned) => {
      const target = tracksForDownload(item, scanned, youtubeDirectory)[0];
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
  function hideTrack(track: Track) {
    setHiddenTrackIds((prior) => prior.includes(track.id) ? prior : [...prior, track.id]);
    setMenu(null);
    void api.state().then(async (state) => {
      const queuedIndexes = state.queue.flatMap((id, index) => id === track.id ? [index] : []).reverse();
      for (const index of queuedIndexes) await api.queueRemove(index);
      if (state.currentTrackId === track.id && state.isPlaying) await api.setPlaying(false);
      setPlayer(await api.state());
    }).catch((error) => setMessage(`Could not remove the hidden song from the queue: ${String(error)}`));
  }
  function restoreTrack(id: number) {
    setHiddenTrackIds((prior) => prior.filter((trackId) => trackId !== id));
  }
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
  const hiddenTrackSet = useMemo(() => new Set(hiddenTrackIds), [hiddenTrackIds]);
  const availableTracks = useMemo(() => tracks.filter((track) => !hiddenTrackSet.has(track.id)), [tracks, hiddenTrackSet]);
  const hiddenTracks = useMemo(() => tracks.filter((track) => hiddenTrackSet.has(track.id)), [tracks, hiddenTrackSet]);
  const normalizedTrackSearch = useMemo(() => new Map(tracks.map((track) => [track.id, `${track.title} ${track.artist} ${track.album} ${track.folderName}`.toLocaleLowerCase()])), [tracks]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const addSongsFilteredTracks = useMemo(() => {
    if (!addSongsPlaylistId) return [];
    return availableTracks.filter((track) => !addSongsSearchTerm || normalizedTrackSearch.get(track.id)?.includes(addSongsSearchTerm));
  }, [addSongsPlaylistId, availableTracks, addSongsSearchTerm, normalizedTrackSearch]);
  const addSongsVisibleTracks = addSongsFilteredTracks.slice(0, addSongsVisibleLimit);
  const addSongsSelectedSet = useMemo(() => new Set(addSongsSelected), [addSongsSelected]);
  const addSongsAlreadyAddedSet = useMemo(() => new Set(playlists.find((item) => item.id === addSongsPlaylistId)?.trackIds ?? []), [playlists, addSongsPlaylistId]);
  const visibleQueue = queueExpanded ? player.queue : player.queue.slice(0, 80);
  const fullBrowsePlaylist = playlists.find((playlist) => playlist.id === fullBrowsePlaylistId) ?? null;
  const fullBrowsePlaylistTracks = useMemo(() => fullBrowsePlaylist?.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : []) ?? [], [fullBrowsePlaylist, trackMap, hiddenTrackSet]);
  const current = player.currentTrackId === null ? null : trackMap.get(player.currentTrackId) ?? null;
  const currentArtworkDataUrl = useArtwork(current?.artworkKey);
  const recentTracks = useMemo(() => listeningHistory
    .slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .flatMap((entry) => !hiddenTrackSet.has(entry.trackId) && trackMap.has(entry.trackId) ? [trackMap.get(entry.trackId)!] : []), [listeningHistory, trackMap, hiddenTrackSet]);
  const nowPlayingTrack = current;
  const nowPlayingIsActive = current !== null && player.isPlaying;
  const footerTrack = current ?? recentTracks[0] ?? null;
  useEffect(() => {
    if (current && player.isPlaying) {
      setShowPanel(true);
    }
  }, [current?.id, player.isPlaying]);
  const folders = useMemo(() => {
    const groups = new Map<string, Collection>();
    const rootsWithDirectSongs = new Set(availableTracks.filter((track) => track.folderPath === track.rootPath).map((track) => track.rootPath));
    for (const track of availableTracks) for (const folder of track.folders) {
      // Include roots only when they have direct songs, and include every music-bearing descendant.
      if (folder.path === track.rootPath && !rootsWithDirectSongs.has(track.rootPath)) continue;
      if (!groups.has(folder.path)) groups.set(folder.path, { key: folder.path, title: folder.name, subtitle: folder.path, tracks: [] });
      groups.get(folder.path)!.tracks.push(track);
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const albums = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of availableTracks) { const key = albumKey(track); if (!groups.has(key)) groups.set(key, { key, title: track.album, subtitle: track.artist, tracks: [] }); groups.get(key)!.tracks.push(track); }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const artists = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of availableTracks) { if (!groups.has(track.artist)) groups.set(track.artist, { key: track.artist, title: track.artist, subtitle: "", tracks: [] }); groups.get(track.artist)!.tracks.push(track); }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const sidebarPlaylistItems = useMemo(() => { const items = playlists.filter((item) => item.name.trim().toLocaleLowerCase() !== "youtube" && item.name.toLocaleLowerCase().includes(sidebarLibrarySearch.trim().toLocaleLowerCase())); if (sidebarLibrarySort === "az") items.sort((a, b) => a.name.localeCompare(b.name)); return items; }, [playlists, sidebarLibrarySearch, sidebarLibrarySort]);
  const collectionTracks = useMemo(() => {
    const detail = page.detail;
    if (page.section === "Recently Played") return recentTracks;
    if (detail?.kind === "folder") return availableTracks.filter((track) => track.folders.some((folder) => folder.path === detail.key));
    if (detail?.kind === "album") return availableTracks.filter((track) => albumKey(track) === detail.key);
    if (detail?.kind === "artist") return availableTracks.filter((track) => track.artist === detail.key);
    if (detail?.kind === "playlist") return (selectedPlaylist?.trackIds ?? []).flatMap((id) => !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : []);
    return page.section === "Favorites" ? availableTracks.filter((track) => favoriteSet.has(track.id)) : availableTracks;
  }, [page, availableTracks, selectedPlaylist, trackMap, favoriteSet, recentTracks, hiddenTrackSet]);
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
    const tracksFound = availableTracks.filter((track) => normalizedTrackSearch.get(track.id)?.includes(query)).slice(0, 4).map((track): GlobalSearchResult => ({
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
      const playlistTracks = playlist.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.has(id) ? [trackMap.get(id)!] : []);
      return playlist.name.toLocaleLowerCase().includes(query) || playlistTracks.some((track) => normalizedTrackSearch.get(track.id)?.includes(query));
    }).slice(0, 2).map((playlist): GlobalSearchResult => {
      const item: Collection = { key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.has(id) ? [trackMap.get(id)!] : []) };
      return { type: "Playlist", title: item.title, subtitle: `Playlist · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`, artworkKey: item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null, page: { section: "Playlists", detail: { kind: "playlist", key: item.key, title: item.title } } };
    });
    return [...tracksFound, ...artistsFound, ...albumsFound, ...foldersFound, ...playlistsFound];
  }, [availableTracks, artists, albums, folders, playlists, trackMap, normalizedTrackSearch, hiddenTrackSet]);
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
    // Android's Rust playback loop publishes directly to the media service,
    // including while the WebView is suspended in the background.
    if (!isTauri() || isAndroid) return;
    let active = true;
    const update = async () => {
      if (!active) return;
      try {
        const state = await api.state();
        if (!active) return;
        await api.mediaUpdate(current, state.isPlaying, state.durationMs, state.positionMs, currentArtworkDataUrl);
      } catch { /* The player can start before Android creates the service. */ }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 2000);
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
  function openAboutUrl(url: string) {
    void openUrl(url).catch((error) => setMessage(`Could not open the link: ${String(error)}`));
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
    saveStoredData("recent-searches", JSON.stringify(next));
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
  const rows = (items: Track[], emptyTitle = "No songs here") => <TrackRows items={items} player={player} favorites={favoriteSet} compact={compact} rowHeight={isAndroid ? 64 : undefined} playCounts={playCounts} showPlayCount={page.section === "Recently Played"} onPlay={(track) => playCollection(track, items)} onFavorite={toggleFavorite} onMenu={openTrackMenu} emptyTitle={scanning ? "Scanning music…" : search || inlineSearch ? "No results" : emptyTitle} emptyMessage={scanning ? "Reading local audio and artwork." : search || inlineSearch ? "Try another search." : page.section === "Favorites" ? "Save songs with the heart in their action menu." : page.section === "Recently Played" ? "Songs will appear here after you play them." : page.detail?.kind === "playlist" ? "Add songs to this playlist from your library." : "Add a music folder to get started."} emptyAction={!scanning && !search && !inlineSearch && selectedPlaylist && selectedPlaylist.name.toLocaleLowerCase() !== "youtube" ? <button className="primary-button playlist-add-songs" onClick={() => { setAddSongsPlaylistId(selectedPlaylist.id); setAddSongsSelected([]); setAddSongsSearch(""); setAddSongsVisibleLimit(100); }}><Plus size={15}/>Add songs</button> : undefined} />;
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
  </> : recentSearchResults.length ? <section className="global-search-group"><div className="global-search-heading"><h2>Recent searches</h2><button onClick={() => { setRecentSearches([]); saveStoredData("recent-searches", "[]"); }}>Clear</button></div>{recentSearchResults.map(({ query, result }) => result ? <GlobalSearchResultButton key={query} result={result} onClick={() => { setSearch(query); setSearchOpen(true); }} showPlayHover={false}/> : <button className="global-search-result recent-query" key={query} role="option" onClick={() => { setSearch(query); setSearchOpen(true); }}><span className="search-result-symbol"><Search size={17}/></span><span className="search-result-copy"><strong>{query}</strong><small>Recent search</small></span></button>)}</section> : <div className="global-search-empty"><strong>Search your library</strong><span>Find songs, artists, albums, folders, and playlists.</span></div>;

  const submenuPlacement = menu && !isAndroid ? playlistSubmenuPlacement(menu.x) : "";
  const updatePromptOpen = Boolean(availableUpdate && deferredUpdatePrompt !== availableUpdate);
  const deferUpdatePrompt = () => { if (availableUpdate) setDeferredUpdatePrompt(availableUpdate); };
  const openUpdateDownload = () => {
    void openUrl(michoplayWebsiteUrl)
      .then(deferUpdatePrompt)
      .catch((error) => {
        setMessage(`Could not open the MichoPlay website: ${String(error)}`);
        deferUpdatePrompt();
      });
  };
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
      <div className="sidebar-playlists" aria-live="polite">{sidebarPlaylistItems.map((playlist) => { const firstTrack = playlist.trackIds.map((id) => trackMap.get(id)).find((track): track is Track => Boolean(track)); const selected = selectedPlaylist?.id === playlist.id; return <button key={playlist.id} className={`library-item ${selected ? "selected" : ""}`} onClick={() => navigate({ section: "Playlists", detail: { kind: "playlist", key: playlist.id, title: playlist.name } })}>{firstTrack ? <Cover className="library-item-art" keys={[firstTrack.artworkKey]}/> : <span className="library-item-placeholder"><ListMusic size={20}/></span>}<span className="library-item-copy"><strong>{playlist.name}</strong><small className="library-item-meta"><ListMusic size={12}/><span className="library-item-count">{playlist.trackIds.length} {playlist.trackIds.length === 1 ? "song" : "songs"}</span></small></span></button>})}{!sidebarPlaylistItems.length && <div className="library-empty">{sidebarLibrarySearch ? "No matching playlists" : "Create a playlist to keep songs together."}</div>}</div>
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
            hiddenTracks={hiddenTracks}
            onRestoreTrack={restoreTrack}
            onBack={() => { setMobileTab("home"); if (history.index > 0) travel(-1); else navigate({ section: "Home" }); }}
            onKeepScreenAwake={setKeepScreenAwake}
            onEqualizer={onEqualizer => {
              setEqualizerBands(onEqualizer);
              saveStoredData("equalizer-bands", JSON.stringify(onEqualizer));
              return api.equalizer(onEqualizer, equalizerEnabled).catch((error) => setMessage(String(error)));
            }}
            onEqualizerPreview={(bands) => api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)))}
            onEqualizerToggle={(enabled) => { setEqualizerEnabled(enabled); saveStoredData("equalizer-enabled", JSON.stringify(enabled)); void run(() => api.equalizer(equalizerBands, enabled)); }}
            onCompact={setCompact}
            onAdd={chooseLibrarySource}
            onRemove={confirmRemoveFolder}
            onRefresh={() => void refresh()}
            onVolume={(volume) => { saveStoredData("volume", JSON.stringify(volume)); void run(() => api.volume(volume)); }}
            onSleepTimer={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))}
            onZoom={setZoomLevel}
            onAbout={() => setMobileAboutOpen(true)}
          /> : isAndroid && mobileTab === "downloads" ? <MobileDownloadsScreen
            downloads={youtubeDownloads}
            clearable={clearableYoutubeDownloads}
            onClear={() => void clearYoutubeDownloads()}
            onControl={(id, action) => void controlYoutubeDownload(id, action)}
            onPlay={(item) => void playYoutubeDownload(item)}
            onMenu={(item, event) => openDownloadedTrackMenu(item, event)}
            onOpenYoutube={openYoutubePage}
          /> : isAndroid && mobileTab === "search" ? <MobileSearchScreen
            search={search}
            onSearch={setSearch}
            youtubeEnabled={globalYoutubeSearchEnabled}
            youtubeSearching={globalYoutubeSearching}
            youtubeResults={globalYoutubeResults}
            youtubeLimit={globalYoutubeVisibleLimit}
            youtubeHasMore={globalYoutubeHasMore}
            youtubeLoadingMore={globalYoutubeLoadingMore}
            youtubeError={globalYoutubeError}
            onYoutubeDownload={(result, query) => requestYoutubeDownload(result, query)}
            onLoadMoreYoutube={() => void loadMoreGlobalYoutubeResults()}
            searchResults={searchResults}
            recentSearchResults={recentSearchResults}
            onChooseResult={chooseSearchResult}
            onLoadRecentSearch={(query) => setSearch(query)}
            currentTrackId={player.currentTrackId}
            isPlaying={player.isPlaying}
          /> : isAndroid && mobileTab === "library" ? <MobileLibraryScreen
            favorites={favorites}
            availableTracks={availableTracks}
            playlists={playlists}
            youtubePlaylist={youtubePlaylist}
            trackMap={trackMap}
            hiddenTrackSet={hiddenTrackSet}
            onOpenFavorites={() => { setMobileTab("home"); navigate({ section: "Favorites" }); }}
            onOpenSongs={() => { setMobileTab("home"); navigate({ section: "Songs" }); }}
            onOpenPlaylist={(item) => { setMobileTab("home"); openDetail("Playlists", "playlist", item); }}
          /> : page.section === "Settings" ? <SettingsPage
            roots={roots}
            player={player}
            equalizerBands={equalizerBands}
            equalizerEnabled={equalizerEnabled}
            compact={compact}
            showPanel={showPanel}
            keepScreenAwake={keepScreenAwake}
            onKeepScreenAwake={setKeepScreenAwake}
            globalYoutubeSearchEnabled={globalYoutubeSearchEnabled}
            onGlobalYoutubeSearch={(enabled) => { setGlobalYoutubeSearchEnabled(enabled); saveStoredData("global-youtube-search-enabled", JSON.stringify(enabled)); }}
            scanning={scanning}
            mobile={isAndroid}
            zoomLevel={zoomLevel}
            hiddenTracks={hiddenTracks}
            onRestoreTrack={restoreTrack}
            onZoom={setZoomLevel}
            onEqualizer={(bands) => {
              setEqualizerBands(bands);
              saveStoredData("equalizer-bands", JSON.stringify(bands));
              return api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)));
            }}
            onEqualizerPreview={(bands) => api.equalizer(bands, equalizerEnabled).catch((error) => setMessage(String(error)))}
            onEqualizerToggle={(enabled) => { setEqualizerEnabled(enabled); saveStoredData("equalizer-enabled", JSON.stringify(enabled)); void run(() => api.equalizer(equalizerBands, enabled)); }}
            onCompact={setCompact}
            onPanel={setShowPanel}
            onAdd={chooseLibrarySource}
            onRemove={confirmRemoveFolder}
            onRefresh={() => void refresh()}
            onVolume={(volume) => { saveStoredData("volume", JSON.stringify(volume)); void run(() => api.volume(volume)); }}
            onAutoplay={(enabled) => { saveStoredData("autoplay", JSON.stringify(enabled)); void run(() => api.autoplay(enabled)); }}
            onSleepTimer={(minutes, atTrackEnd) => void run(() => api.sleepTimer(minutes, atTrackEnd))}
            onDefaultPlayer={() => isAndroid ? setMessage("Open an audio file from your file manager, choose MichoPlay, then tap Always to make it the default.") : void run(() => api.setDefaultPlayer())}
          /> : <>
            {!listPage && (page.section === "Folders" || page.section === "Playlists" || page.section === "Albums" || page.section === "Artists") && <button className="browse-back-button" onClick={() => navigate({ section: "Home" })}><ChevronLeft size={17}/>Back to Home</button>}
            <div className={`collection-heading ${listPage ? "detail-heading" : ""} ${isYoutubePlaylist ? "youtube-detail-heading" : ""}`}>
              {headingArt && listPage && <div className="cover-backdrop" style={{ backgroundImage: `url("${headingArt}")` }}/> }{isAndroid && listPage && <button className="mobile-detail-back" aria-label="Back" onClick={() => { if (history.index > 0) travel(-1); else navigate({ section: "Home" }); }}><ChevronLeft size={24}/></button>}<div className="heading-foreground">{listPage && <Cover className="heading-cover" keys={coverKeys(collectionTracks)} icon={page.detail?.kind === "folder" ? <FolderOpen size={40}/> : page.section === "Favorites" ? <Heart size={36} fill="currentColor"/> : <Music2 size={36}/>}/>}<div className="heading-copy"><h1>{heading}</h1><p>{isYoutubePlaylist ? "Download audio from YouTube by searching or pasting a link." : listPage ? `${collectionTracks.length} songs · ${time(collectionDurationMs)}` : page.section === "Home" ? `${folders.length} music folders` : page.section === "Albums" ? `${albums.length} albums` : page.section === "Artists" ? `${artists.length} artists` : page.section === "Folders" ? `${folders.length} folders` : `${playlists.length} playlists`}</p></div></div>
            </div>
          {listPage ? <>{isYoutubePlaylist && <section className="youtube-downloader" aria-label="Search YouTube audio">
            <div className="youtube-search-header">
            <form className="youtube-search-form" onSubmit={(event) => event.preventDefault()}>
              <label className="search-box youtube-global-search"><Search size={17}/><input type="text" aria-label="Search YouTube" placeholder="Song, artist, or paste a YouTube link" value={youtubeQuery} onChange={(event) => setYoutubeQuery(event.target.value)}/>{youtubeQuery && <button type="button" aria-label="Clear YouTube search" onClick={() => setYoutubeQuery("")}><X size={15}/></button>}</label>
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
            <div className="collection-tools"><div className="play-actions"><button className={`primary-play ${collectionHasCurrent ? "is-playing" : ""}`} aria-label={collectionHasCurrent && player.isPlaying ? `Pause ${heading}` : `Play ${heading}`} disabled={!visibleTracks.length} onClick={() => { if (collectionHasCurrent) void run(api.toggle); else if (sortedVisibleTracks[0]) playCollection(sortedVisibleTracks[0]); }}>{collectionHasCurrent && player.isPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button><button className={`round-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={!visibleTracks.length} onClick={() => void run(api.shuffle)}><Shuffle size={18}/></button>{selectedPlaylist && <><button className="text-action" onClick={() => newPlaylist(undefined, selectedPlaylist)}><Pencil size={14}/>Rename</button><button className="icon-button" aria-label="Delete playlist" onClick={() => confirmDeletePlaylist(selectedPlaylist)}><Trash2 size={16}/></button></>}</div><div className="collection-tools-right"><label className="collection-search"><Search size={15}/><input aria-label={`Search in ${heading}`} placeholder={`Search in ${heading}`} value={inlineSearch} onChange={(event) => setInlineSearch(event.target.value)}/>{inlineSearch && <button className="icon-button" aria-label="Clear collection search" onClick={() => setInlineSearch("")}><X size={14}/></button>}</label><div className="sort-control"><button className={`sort-trigger ${sortMenuOpen ? "open" : ""}`} aria-label={`Sort by ${trackSortOptions.find((option) => option.key === sortBy)?.label}`} aria-expanded={sortMenuOpen} onClick={() => setSortMenuOpen((open) => !open)}><span>{trackSortOptions.find((option) => option.key === sortBy)?.label}</span><ListFilter size={15}/></button>{sortMenuOpen && <div className="sort-menu" role="menu"><strong className="sort-menu-heading">Sort by</strong>{trackSortOptions.map((option) => <button key={option.key} role="menuitemradio" aria-checked={sortBy === option.key} className={`sort-menu-option ${sortBy === option.key ? "selected" : ""}`} onClick={() => { setSortBy(option.key); saveStoredData("collection-sort", JSON.stringify(option.key)); setSortMenuOpen(false); }}><span>{option.label}</span>{sortBy === option.key && <Check size={15}/>}</button>)}<span className="sort-menu-divider"/><strong className="sort-menu-heading">View as</strong><button role="menuitemradio" aria-checked={!compact} className={`sort-menu-option view-option ${!compact ? "selected" : ""}`} onClick={() => { setCompact(false); setSortMenuOpen(false); }}><List size={15}/><span>List</span>{!compact && <Check size={15}/>}</button><button role="menuitemradio" aria-checked={compact} className={`sort-menu-option view-option ${compact ? "selected" : ""}`} onClick={() => { setCompact(true); setSortMenuOpen(false); }}><AlignJustify size={15}/><span>Compact</span>{compact && <Check size={15}/>}</button></div>}</div></div></div>{rows(sortedVisibleTracks, page.section === "Favorites" ? "No favorites yet" : page.section === "Recently Played" ? "No listening history yet" : "No songs here")}</> : page.section === "Home" ? <HomeScreen
              albums={albums}
              artists={artists}
              availableTracks={availableTracks}
              playlists={playlists}
              folders={folders}
              isScanning={scanning}
              navigate={(section) => navigate({ section })}
              openYoutube={openYoutubePage}
              chooseLibrarySource={chooseLibrarySource}
              openFolder={(item) => openDetail("Home", "folder", item)}
              openPlaylist={(item) => openDetail("Playlists", "playlist", { key: item.id, title: item.name, subtitle: "", tracks: [] })}
              openAlbum={(item) => openDetail("Albums", "album", item)}
              openArtist={(item) => openDetail("Artists", "artist", item)}
            /> : page.section === "Albums" ? <CollectionGrid collections={albums} kind="album" onOpen={(item) => openDetail("Albums", "album", item)}/> : page.section === "Artists" ? <CollectionGrid collections={artists} kind="artist" onOpen={(item) => openDetail("Artists", "artist", item)}/> : page.section === "Folders" ? <div className="home-section"><div className="section-title-row"><h2>Folders</h2><button className="outline-button" disabled={scanning} onClick={chooseLibrarySource}><Plus size={15}/>Add folder</button></div><CollectionGrid collections={folders} kind="folder" onOpen={(item) => openDetail("Home", "folder", item)} onPlay={playCardCollection} isCurrentCollection={isCollectionCurrent} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!folders.length && <Empty title={scanning ? "Scanning music…" : "No folders yet"} description="Add a music folder to browse its songs."/>}</div> : <div className="home-section"><div className="section-title-row"><h2>Your playlists</h2><button className="outline-button" onClick={() => newPlaylist()}><Plus size={15}/>Create playlist</button></div><CollectionGrid collections={playlists.map((item) => ({ key: item.id, title: item.name, subtitle: "", tracks: item.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : []) }))} kind="playlist" onOpen={(item) => openDetail("Playlists", "playlist", item)} onPlay={playCardCollection} isCurrentCollection={isCollectionCurrent} playingId={player.currentTrackId} isPlaying={player.isPlaying}/>{!playlists.length && <Empty title="No playlists yet" description="Create a playlist and add songs from their action menu."/>}</div>}
          </>}
        </section>
        {showPanel && <><div className="resize-handle panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" onPointerDown={(event) => startResize("panel", event)}/><aside className="now-panel" aria-label={panelView === "downloads" ? "Downloads" : "Now playing and queue"}>
          <div className="now-panel-head"><button className="icon-button now-panel-close" aria-label="Hide side panel" title="Hide side panel" onClick={() => setShowPanel(false)}><PanelRightClose size={16}/></button><div className="side-panel-tabs" role="tablist" aria-label="Side panel"><button role="tab" aria-selected={panelView === "now-playing"} className={panelView === "now-playing" ? "selected" : ""} onClick={() => setPanelView("now-playing")}>Now playing</button><button role="tab" aria-selected={panelView === "downloads"} className={panelView === "downloads" ? "selected" : ""} onClick={() => setPanelView("downloads")}>Downloads{youtubeDownloads.some((item) => item.status === "downloading" || item.status === "queued") && <span className="download-tab-count">{youtubeDownloads.filter((item) => item.status === "downloading" || item.status === "queued").length}</span>}</button></div><div className="now-panel-tools">{panelView === "now-playing" ? <button className="icon-button" aria-label="More options for current song" title="More options" disabled={!nowPlayingTrack} onClick={(event) => { if (nowPlayingTrack) openTrackMenu(nowPlayingTrack, event); }}><MoreHorizontal size={18}/></button> : null}</div></div>
          {panelView === "downloads" ? <div className="download-manager" aria-live="polite"><div className="download-manager-heading"><strong>Your downloads</strong><span>{youtubeDownloads.filter((item) => item.status === "downloading" || item.status === "queued").length} active</span>{clearableYoutubeDownloads && <button className="download-clear-button" onClick={() => void clearYoutubeDownloads()}><Trash2 size={13}/>Clear</button>}</div>{youtubeDownloads.length ? youtubeDownloads.map((item) => <article className={`download-item status-${item.status}`} key={item.id}><div className="download-item-main"><div className="download-item-art">{item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/>}<Youtube size={17}/>{item.status === "completed" && <button className="download-art-play" aria-label={`Play ${item.title}`} title="Play downloaded audio" onClick={() => void playYoutubeDownload(item)}><Play size={15} fill="currentColor"/></button>}</div><div className="download-item-copy"><strong>{item.title}</strong>{youtubeDownloadDescription(item) && <small>{youtubeDownloadDescription(item)}</small>}</div></div><div className="download-item-progress"><span style={{ width: `${item.percent ?? (item.status === "downloading" ? 5 : 0)}%` }}/></div><div className="download-item-actions"><span className={`download-status-label ${item.status}`}>{item.status === "completed" ? "Completed" : item.status}</span>{item.status === "completed" ? <button className="icon-button download-menu-trigger" aria-label={`More actions for ${item.title}`} title={`More actions for ${item.title}`} onClick={(event) => openDownloadedTrackMenu(item, event)}><MoreVertical size={16}/></button> : <>{item.status === "downloading" || item.status === "queued" ? <button className="icon-button" aria-label={`Pause ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "pause")}><Pause size={14}/></button> : item.status === "paused" || item.status === "failed" ? <button className="icon-button" aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "resume")}><Play size={14}/></button> : null}{["queued", "downloading", "paused"].includes(item.status) ? <button className="icon-button" aria-label={`Cancel ${item.title}`} onClick={() => void controlYoutubeDownload(item.id, "cancel")}><X size={14}/></button> : <button className="icon-button" aria-label={`Remove ${item.title} from downloads`} onClick={() => void controlYoutubeDownload(item.id, "remove")}><X size={14}/></button>}</>}</div></article>) : <div className="download-manager-empty"><Download size={27}/><strong>No downloads yet</strong><span>Choose a video from YouTube search to add it here.</span></div>}</div> : <>{nowPlayingTrack ? <div className={`now-track ${nowPlayingIsActive ? "is-active" : ""}`}><Cover className="now-cover" keys={[nowPlayingTrack.artworkKey]}/><div className="now-title"><div className="now-track-copy"><strong>{nowPlayingTrack.title}</strong><span>{nowPlayingTrack.artist}</span></div><button className={`row-action visible ${favorites.includes(nowPlayingTrack.id) ? "selected" : ""}`} aria-label="Toggle favorite" onClick={() => toggleFavorite(nowPlayingTrack.id)}><Heart size={17} fill={favorites.includes(nowPlayingTrack.id) ? "currentColor" : "none"}/></button></div></div> : <div className="now-empty"><span className="now-empty-icon"><AudioLines size={23}/></span><div className="now-empty-copy"><strong>Ready when you are</strong><span>Pick a song from your library to start listening.</span></div><button className="now-empty-action" onClick={() => navigate({ section: "Songs" })}><Music2 size={14}/>Browse songs<ArrowRight size={14}/></button></div>}<div className="queue-hint"><ListMusic size={16}/><span>Up next</span><span className="queue-empty">{player.queue.length} songs</span></div><div className="queue-list">{visibleQueue.map((id, index) => { const track = trackMap.get(id); return track ? <div key={id} draggable className={`queue-row ${draggedQueue === index ? "dragging" : ""} ${queueDrop === index ? "drop-target" : ""} ${player.priorityQueue.includes(id) ? "priority" : ""}`} onDragStart={(event) => { setDraggedQueue(index); event.dataTransfer.setData("application/michoplay-queue", String(index)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggedQueue !== null) { event.preventDefault(); setQueueDrop(index); } }} onDrop={(event) => { event.preventDefault(); if (draggedQueue !== null && draggedQueue !== index) void run(() => api.queueMove(draggedQueue, index)); setDraggedQueue(null); setQueueDrop(null); }} onDragEnd={() => { setDraggedQueue(null); setQueueDrop(null); }}><GripVertical className="queue-grip" size={13}/><button className="queue-song" onClick={() => void run(() => api.play(id))}><Cover className="queue-cover" keys={[track.artworkKey]}/><span className="queue-song-copy"><span className="queue-label queue-label-title">{track.title}</span><span className="queue-label queue-label-artist">{track.artist}</span></span></button><div className="queue-actions"><button className="icon-button" aria-label={`Move ${track.title} up`} disabled={index === 0} onClick={() => void run(() => api.queueMove(index, index - 1))}><ChevronUp size={13}/></button><button className="icon-button" aria-label={`Move ${track.title} down`} disabled={index === player.queue.length - 1} onClick={() => void run(() => api.queueMove(index, index + 1))}><ChevronDown size={13}/></button><button className="icon-button" aria-label={`Remove ${track.title} from queue`} onClick={() => void run(() => api.queueRemove(index))}><X size={13}/></button></div></div> : null; })}</div>{!queueExpanded && player.queue.length > visibleQueue.length && <button className="queue-expand-button" onClick={() => setQueueExpanded(true)}>Show all {player.queue.length} queued songs</button>}{queueExpanded && player.queue.length > 80 && <button className="queue-expand-button" onClick={() => setQueueExpanded(false)}>Show fewer queued songs</button>}{!player.queue.length && <p className="queue-notice">Add songs to the queue from their action menu.</p>}</>}</aside></>}
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
          <aside className="full-mode-side"><div className="full-mode-tabs" role="tablist" aria-label="Full mode side panel"><button role="tab" aria-selected={fullPanelTab === "queue"} className={fullPanelTab === "queue" ? "active" : ""} onClick={() => setFullPanelTab("queue")}>Queue</button><button role="tab" aria-selected={fullPanelTab === "browse"} className={fullPanelTab === "browse" ? "active" : ""} onClick={() => setFullPanelTab("browse")}>Browse</button></div>{fullPanelTab === "queue" ? <div className="full-mode-list"><h2>Now playing</h2>{footerTrack && <button className="full-mode-track current" onClick={() => { if (current) void run(api.toggle); }}><Cover className="full-mode-track-cover" keys={[footerTrack.artworkKey]}/><span><strong>{footerTrack.title}</strong><small>{footerTrack.artist}</small></span></button>}<h2>Up next</h2>{visibleQueue.map((id) => { const track = trackMap.get(id); return track ? <button className="full-mode-track" key={id} onClick={() => void run(() => api.play(id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button> : null; })}{!player.queue.length && <p className="full-mode-empty">Nothing queued</p>}</div> : <div className="full-mode-list full-mode-browse">{fullBrowsePlaylistId ? <><button className="full-mode-back" onClick={() => setFullBrowsePlaylistId(null)}><ChevronLeft size={14}/><span>{fullBrowsePlaylist?.name ?? "Playlists"}</span></button>{fullBrowsePlaylistTracks.slice(0, fullBrowseVisibleLimit).map((track) => <button className="full-mode-track" key={track.id} onClick={() => void run(() => api.playCollection(fullBrowsePlaylistTracks.map((item) => item.id), track.id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>)}{fullBrowsePlaylistTracks.length > fullBrowseVisibleLimit && <button className="queue-expand-button" onClick={() => setFullBrowseVisibleLimit((prior) => prior + 100)}>Show more songs ({fullBrowsePlaylistTracks.length - fullBrowseVisibleLimit} remaining)</button>}{!fullBrowsePlaylistTracks.length && <p className="full-mode-empty">This playlist has no songs yet.</p>}</> : <><div className="full-mode-browse-tabs" role="tablist" aria-label="Browse your music"><button role="tab" aria-selected={fullBrowseTab === "playlists"} className={fullBrowseTab === "playlists" ? "active" : ""} onClick={() => setFullBrowseTab("playlists")}>Playlists</button><button role="tab" aria-selected={fullBrowseTab === "library"} className={fullBrowseTab === "library" ? "active" : ""} onClick={() => setFullBrowseTab("library")}>Library</button></div>{fullBrowseTab === "playlists" ? <><h2>Your playlists</h2>{playlists.map((playlist) => { const playlistTracks = playlist.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : []); return <button className="full-mode-track full-mode-playlist" key={playlist.id} onClick={() => setFullBrowsePlaylistId(playlist.id)}><Cover className="full-mode-track-cover" keys={coverKeys(playlistTracks)} icon={<ListMusic size={18}/>}/><span><strong>{playlist.name}</strong><small>{playlistTracks.length} {playlistTracks.length === 1 ? "song" : "songs"}</small></span><ChevronRight className="full-mode-playlist-chevron" size={15}/></button>; })}{!playlists.length && <p className="full-mode-empty">Your playlists will appear here.</p>}</> : <><h2>All songs</h2>{availableTracks.slice(0, fullBrowseVisibleLimit).map((track) => <button className="full-mode-track" key={track.id} onClick={() => void run(() => api.playCollection(availableTracks.map((item) => item.id), track.id))}><Cover className="full-mode-track-cover" keys={[track.artworkKey]}/><span><strong>{track.title}</strong><small>{track.artist}</small></span></button>)}{availableTracks.length > fullBrowseVisibleLimit && <button className="queue-expand-button" onClick={() => setFullBrowseVisibleLimit((prior) => prior + 100)}>Show more songs ({availableTracks.length - fullBrowseVisibleLimit} remaining)</button>}{!availableTracks.length && <p className="full-mode-empty">Import songs to browse your library.</p>}</>}</>}</div>}</aside>
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
      <div className="playlist-menu-wrap" onMouseEnter={() => setPlaylistSubmenu(true)}><button role="menuitem" aria-expanded={playlistSubmenu} onClick={() => setPlaylistSubmenu(!playlistSubmenu)}><Plus size={15}/>Add to playlist<ChevronRight size={14} className="menu-arrow"/></button>{playlistSubmenu && <div ref={playlistSubmenuRef} className={`playlist-submenu ${submenuPlacement}`}><label className="playlist-find"><Search size={15}/><input autoFocus placeholder="Find a playlist" aria-label="Find a playlist" value={playlistSearch} onChange={(event) => setPlaylistSearch(event.target.value)}/></label><button onClick={() => newPlaylist(menu.track)}><ListMusic size={15}/>New playlist</button><div className="menu-separator"/><div className="playlist-options">{playlists.filter((item) => item.name.toLocaleLowerCase().includes(playlistSearch.toLocaleLowerCase())).map((item) => <button key={item.id} onClick={() => addToPlaylist(item, menu.track)}><ListMusic size={15}/>{item.name}</button>)}</div>{!playlists.length && <p>Create your first playlist above.</p>}</div>}</div>{selectedPlaylist && <button role="menuitem" onClick={() => confirmRemovePlaylistTrack(selectedPlaylist, menu.track)}><Trash2 size={15}/>Remove from playlist</button>}<button role="menuitem" onClick={() => { toggleFavorite(menu.track.id); setMenu(null); }}><Heart size={15}/>{favorites.includes(menu.track.id) ? "Remove from favorites" : "Save to favorites"}</button><button role="menuitem" onClick={() => { void run(() => api.queueAdd(menu.track.id)); setMenu(null); }}><ListMusic size={15}/>Add to queue</button><button role="menuitem" onClick={() => { playCollection(menu.track); setMenu(null); }}><Play size={15}/>Play now</button><button role="menuitem" onClick={() => hideTrack(menu.track)}><EyeOff size={15}/>Hide song</button><div className="menu-separator"/><button role="menuitem" onClick={() => navigate({ section: "Artists", detail: { kind: "artist", key: menu.track.artist, title: menu.track.artist } })}><AudioLines size={15}/>Go to artist</button><button role="menuitem" onClick={() => navigate({ section: "Albums", detail: { kind: "album", key: albumKey(menu.track), title: menu.track.album } })}><Disc3 size={15}/>Go to album</button>
    </div></>, isAndroid ? appFrameRef.current ?? document.body : document.body)}
    {updatePromptOpen && availableUpdate && <div className="update-dialog-overlay"><section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" aria-describedby="update-dialog-description">
      <header className="update-dialog-heading"><span className="update-dialog-title-copy"><h2 id="update-dialog-title">Update Available</h2><p id="update-dialog-description">A new version is ready</p></span></header>
      <div className="update-version-comparison" aria-label={`Current version ${appVersion}; new version ${availableUpdate}`}><div className="update-version-item"><span>Current</span><strong>v{appVersion}</strong></div><ArrowRight size={20} aria-hidden="true"/><div className="update-version-item"><span>New</span><strong>v{availableUpdate}</strong></div></div>
      <button className="update-install-button" onClick={openUpdateDownload}><Download size={17}/>Download</button>
      <button className="update-later-button" onClick={deferUpdatePrompt}>Later</button>
    </section></div>}
    {aboutOpen && <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title"><div className="about-dialog-head"><span className="about-dialog-kicker">About</span><button className="icon-button" aria-label="Close About" title="Close" onClick={() => setAboutOpen(false)}><X size={19}/></button></div><div className="about-dialog-hero"><span className="about-mark"><AudioLines size={46}/></span><h2 id="about-title">MichoPlay</h2><span className="about-version-pill">Version {appVersion}</span><div className="about-dialog-actions"><button onClick={() => openAboutUrl(michoplayGithubUrl)}><Github size={16}/>GitHub</button><button onClick={() => openAboutUrl(michoplayIssueUrl)}><Bug size={16}/>Report issue</button></div></div><section className="about-dialog-section"><h3>Links</h3><div className="about-dialog-links"><button onClick={() => openAboutUrl(michoplayDeveloperUrl)}><Globe2 size={18}/><span>Developer</span><ChevronRight size={17}/></button><button onClick={() => openAboutUrl(michoplayWebsiteUrl)}><AudioLines size={18}/><span>Website</span><ChevronRight size={17}/></button></div></section></section></div>}
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
