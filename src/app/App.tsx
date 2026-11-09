import {
  Fragment,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { addPluginListener, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion, onBackButtonPress } from "@tauri-apps/api/app";
import {
  AudioLines,
  ArrowRight,
  Disc3,
  Heart,
  ListMusic,
  Music2,
  Play,
  Plus,
  Search,
  Shuffle,
  Mic2,
  SkipBack,
  SkipForward,
  Settings2,
  MoreHorizontal,
  FolderOpen,
  Pause,
  Trash2,
  X,
  PanelRightClose,
  PanelRightOpen,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  GripVertical,
  RefreshCw,
  Pencil,
  Youtube,
  ListFilter,
  List,
  AlignJustify,
  Check,
  Timer,
  Download,
  EyeOff,
  Maximize2,
  Minimize2,
  MoreVertical,
  Github,
  Globe2,
  Bug,
} from "lucide-react";
import { api } from "../lib/api";
import { saveStoredData, stored } from "../lib/storage";
import type {
  PlayerSnapshot,
  Track,
  YoutubeDownload,
  YoutubeDownloadPlaylist,
  YoutubeSearchResult,
} from "../lib/api";
import {
  MobileAboutPage,
  MobileSettingsPage,
  SettingsPage,
} from "../screens/settings";
import { HomeScreen } from "../screens/home";
import { MobileDownloadsScreen } from "../screens/downloads";
import { MobileLibraryScreen } from "../screens/library";
import { TrackRows } from "../screens/library/TrackRows";
import { MobileSearchScreen } from "../screens/search";
import { SearchResultButton as GlobalSearchResultButton } from "../screens/search/GlobalSearchResultButton";
import { Empty } from "../components/EmptyState";
import { CollectionGrid } from "../components/library/CollectionGrid";
import packageInfo from "../../package.json";
import { youtubeDownloadErrorText } from "../lib/youtube-size";
import {
  youtubeDownloadDescription,
  youtubeDownloadIsPending,
  youtubeDownloadProgress,
} from "../components/downloads/DownloadStatus";
import { Cover, useArtwork } from "./Artwork";
import { LyricsBadge } from "../components/LyricsBadge";
import { LyricsView } from "../screens/lyrics/LyricsView";
import { PlaylistSelection } from "../components/downloads/PlaylistSelection";
import { PlaylistDownloadProgress } from "../components/downloads/PlaylistDownloadProgress";
import { BufferedYoutubeSearch, DesktopGlobalSearch } from "./components/SearchInputs";
import { SleepTimerControl, sleepTimerLabel } from "./components/SleepTimerControl";
import { VolumeControl } from "./components/VolumeControl";
import { MobileNav } from "./components/MobileNav";
import { TransportControls } from "./components/TransportControls";
import { useYoutubeSearch } from "./useYoutubeSearch";
import type { Collection, Detail, DownloadFeedback, GlobalSearchResult, ListeningRecord, Page, Playlist, SavedPlaybackSession, Section, TrackMenu, TrackSort } from "./types";
import { trackSortOptions } from "./types";
import { albumKey, coverKeys, durationLabel, fileToBase64, headingTime, initialPlayer, initialZoomLevel, isFinishedYoutubeDownload, isNewerVersion, navigation, normalizeZoom, playlistSubmenuPlacement, sameYoutubeDownloads, storedLibraryRoots, time, tracksForDownload, youtubeFolderInitialResultLimit, youtubeGlobalInitialResultLimit, youtubeResultSize, youtubeSearchPageSize, latestReleaseApiUrl, michoplayDeveloperUrl, michoplayGithubUrl, michoplayIssueUrl, michoplayWebsiteUrl, defaultVolume } from "./utils";

export default function App() {
  const [history, setHistory] = useState({
    entries: [{ section: "Home" } as Page],
    index: 0,
  });
  const page = history.entries[history.index];
  const [roots, setRoots] = useState<string[]>(storedLibraryRoots);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [hiddenTrackIds, setHiddenTrackIds] = useState<number[]>(() => {
    const saved = stored<unknown>("hidden-tracks", []);
    return Array.isArray(saved)
      ? saved.filter((id): id is number => Number.isSafeInteger(id))
      : [];
  });
  const [player, setPlayer] = useState<PlayerSnapshot>(initialPlayer);
  const lastAudibleVolume = useRef(
    Math.max(0.01, stored("volume", defaultVolume())),
  );
  const [fullMode, setFullMode] = useState(false);
  const [fullModeLyrics, setFullModeLyrics] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [mobileLyricsExpanded, setMobileLyricsExpanded] = useState(false);
  const [mobilePlayerLyricsOpen, setMobilePlayerLyricsOpen] = useState(false);
  const [mobileTrackSwipeOffset, setMobileTrackSwipeOffset] = useState(0);
  const [mobileTrackIsDragging, setMobileTrackIsDragging] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileAboutOpen, setMobileAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(packageInfo.version);
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null);
  const [deferredUpdatePrompt, setDeferredUpdatePrompt] = useState<
    string | null
  >(null);
  const [fullPanelTab, setFullPanelTab] = useState<"queue" | "browse">("queue");
  const [fullBrowseTab, setFullBrowseTab] = useState<"playlists" | "library">(
    "playlists",
  );
  const [fullBrowsePlaylistId, setFullBrowsePlaylistId] = useState<
    string | null
  >(null);
  const [fullBrowseVisibleLimit, setFullBrowseVisibleLimit] = useState(100);
  const [keepScreenAwake, setKeepScreenAwake] = useState(() =>
    stored("keep-screen-awake-in-full-mode", false),
  );
  const [equalizerBands, setEqualizerBands] = useState<number[]>(() => {
    const saved = stored<number[]>("equalizer-bands", Array(6).fill(0));
    if (!Array.isArray(saved)) return Array(6).fill(0);
    const migrated =
      saved.length === 10
        ? [
            saved[1],
            (saved[2] + saved[3]) / 2,
            saved[4],
            saved[5],
            (saved[6] + saved[7]) / 2,
            saved[9],
          ]
        : saved;
    return migrated.length === 6
      ? migrated.map((value) => Math.max(-12, Math.min(12, Number(value) || 0)))
      : Array(6).fill(0);
  });
  const [equalizerEnabled, setEqualizerEnabled] = useState(() =>
    stored("equalizer-enabled", false),
  );
  const [favorites, setFavorites] = useState<number[]>(() =>
    stored("favorites", []),
  );
  const [playlists, setPlaylists] = useState<Playlist[]>(() =>
    stored("playlists", []),
  );
  const [listeningHistory, setListeningHistory] = useState<ListeningRecord[]>(
    () => stored("listening-history", []),
  );
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const seekCommitTimer = useRef<number | null>(null);
  const seekCommitVersion = useRef(0);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [globalYoutubeSearchEnabled, setGlobalYoutubeSearchEnabled] = useState(
    () => stored("global-youtube-search-enabled", true),
  );
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    const saved = stored<unknown>("recent-searches", []);
    return Array.isArray(saved)
      ? saved
          .filter((value): value is string => typeof value === "string")
          .slice(0, 8)
      : [];
  });
  const [inlineSearch, setInlineSearch] = useState("");
  const [playlistSearchOpen, setPlaylistSearchOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanNotificationDismissed, setScanNotificationDismissed] =
    useState(false);
  const [scanProgress, setScanProgress] = useState<{
    phase: string;
    processed: number;
    total: number;
  } | null>(null);
  const [startupLoading, setStartupLoading] = useState(() => isTauri());
  const [startupPhase, setStartupPhase] = useState("Preparing your library…");
  useEffect(() => {
    if (scanning) setScanNotificationDismissed(false);
  }, [scanning]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ phase: string; processed: number; total: number }>(
      "library-scan-progress",
      ({ payload }) => {
        if (!active) return;
        if (["Complete", "Cancelled", "Failed"].includes(payload.phase))
          setScanProgress(null);
        else setScanProgress(payload);
      },
    ).then((dispose) => {
      unlisten = dispose;
      if (!active) dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  const [menu, setMenu] = useState<TrackMenu | null>(null);
  const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);
  const [metadataDraft, setMetadataDraft] = useState({
    title: "",
    artist: "",
    album: "",
    releaseDate: "",
  });
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [metadataSheetDragY, setMetadataSheetDragY] = useState(0);
  const [metadataSheetDragging, setMetadataSheetDragging] = useState(false);
  const metadataSheetDrag = useRef<{
    startY: number;
    lastY: number;
    lastAt: number;
    velocity: number;
  } | null>(null);
  const appFrameRef = useRef<HTMLElement>(null);
  const trackMenuRef = useRef<HTMLDivElement>(null);
  const playlistSubmenuRef = useRef<HTMLDivElement>(null);
  const [playlistSubmenu, setPlaylistSubmenu] = useState(false);
  const [playlistSearch, setPlaylistSearch] = useState("");
  const [appMenu, setAppMenu] = useState(false);
  const [playlistActionsOpen, setPlaylistActionsOpen] = useState(false);
  const [dialog, setDialog] = useState<{
    target?: Track;
    playlist?: Playlist;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    label: string;
    confirm: () => void | boolean | Promise<void | boolean>;
  } | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null,
  );
  const [playlistName, setPlaylistName] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.max(184, Math.min(360, stored<number>("sidebar-width", 248))),
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(250, Math.min(460, stored<number>("panel-width", 320))),
  );
  const [showPanel, setShowPanel] = useState(() =>
    stored("show-now-playing", false),
  );
  const [panelView, setPanelView] = useState<"now-playing" | "downloads">(
    "now-playing",
  );
  const [compact, setCompact] = useState(() => stored("compact", false));
  const [sortBy, setSortBy] = useState<TrackSort>(() => {
    const saved = stored<string>("collection-sort", "recentlyAdded");
    if (saved === "title") return "titleAsc";
    if (saved === "duration") return "durationAsc";
    return trackSortOptions.some((option) => option.key === saved)
      ? (saved as TrackSort)
      : "recentlyAdded";
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<
    "home" | "search" | "library" | "youtube" | "downloads"
  >("home");
  const [mobileLibraryActionsOpen, setMobileLibraryActionsOpen] =
    useState(false);
  const [sidebarLibrarySearch, setSidebarLibrarySearch] = useState("");
  const [sidebarLibrarySort, setSidebarLibrarySort] = useState<"recent" | "az">(
    "recent",
  );
  const [mobilePlayerOpen, setMobilePlayerOpen] = useState(false);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const [mobileQueueEditing, setMobileQueueEditing] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [mobileQueueReorder, setMobileQueueReorder] = useState<{
    from: number;
    to: number;
    offset: number;
    active: boolean;
  } | null>(null);
  const mobileQueueReorderRef = useRef<{
    from: number;
    to: number;
    offset: number;
    active: boolean;
    pointerId: number;
    startY: number;
    timer: number | null;
  } | null>(null);
  const mobileQueueListRef = useRef<HTMLDivElement>(null);
  const [mobileSleepTimerOpen, setMobileSleepTimerOpen] = useState(false);
  const [addSongsPlaylistId, setAddSongsPlaylistId] = useState<string | null>(
    null,
  );
  const [addSongsSelected, setAddSongsSelected] = useState<number[]>([]);
  const [addSongsSearch, setAddSongsSearch] = useState("");
  const [addSongsVisibleLimit, setAddSongsVisibleLimit] = useState(100);
  const [mobileSheetDrag, setMobileSheetDrag] = useState<{
    sheet: string;
    offset: number;
    dragging: boolean;
  } | null>(null);
  const mobileSheetDragState = useRef<{
    sheet: string;
    startY: number;
    lastY: number;
    lastAt: number;
    velocity: number;
  } | null>(null);
  const mobileTrackSwipeStartX = useRef<number | null>(null);
  const mobileTrackSwipeMoved = useRef(false);
  const [youtubeDirectory, setYoutubeDirectory] = useState("");
  const [youtubeFolderScanned, setYoutubeFolderScanned] = useState(false);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeDownloads, setYoutubeDownloads] = useState<YoutubeDownload[]>(
    [],
  );
  const [playlistSelection, setPlaylistSelection] = useState<YoutubeSearchResult | null>(null);
  const latestYoutubeDownloads = useRef<YoutubeDownload[]>([]);
  const youtubeDownloadsVersion = useRef(0);
  const [unseenDownloadIds, setUnseenDownloadIds] = useState<string[]>([]);
  const [downloadFeedback, setDownloadFeedback] =
    useState<DownloadFeedback | null>(null);
  const [globalYoutubeDownloadRequested, setGlobalYoutubeDownloadRequested] =
    useState<string[]>([]);
  const [zoomLevel, setZoomLevel] = useState(initialZoomLevel);
  const [draggedQueue, setDraggedQueue] = useState<number | null>(null);
  const [queueDrop, setQueueDrop] = useState<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const downloadNavRef = useRef<HTMLButtonElement>(null);
  const downloadFeedbackVersion = useRef(0);
  const lastStartedTrack = useRef<number | null>(null);
  const playbackRestoreStarted = useRef(false);
  const playbackRestoreComplete = useRef(false);
  const lastPlaybackSaveAt = useRef(0);
  const latestPlayerSnapshot = useRef<PlayerSnapshot>(initialPlayer);
  const youtubeSearchCache = useRef(
    new Map<
      string,
      { results: YoutubeSearchResult[]; savedAt: number; hasMore?: boolean }
    >(),
  );
  const youtubeLyricsProbes = useRef(new Set<string>());
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const completedYoutubeDownloads = useRef(new Set<string>());
  const isAndroid = useMemo(() => /android/i.test(navigator.userAgent), []);
  function enrichYoutubeLyrics(
    query: string,
    offset: number,
    results: YoutubeSearchResult[],
  ) {
    if (
      !results.length ||
      results.every((result) => result.hasLyrics || result.isPlaylist)
    )
      return;
    const cacheKey = query.toLocaleLowerCase();
    const probeKey = `${cacheKey}:${offset}:${results.length}`;
    if (youtubeLyricsProbes.current.has(probeKey)) return;
    youtubeLyricsProbes.current.add(probeKey);
    void api
      .youtubeSearch(query, results.length, offset, true)
      .then((details) => {
        const idsWithLyrics = new Set(
          details
            .filter((result) => result.hasLyrics)
            .map((result) => result.id),
        );
        if (!idsWithLyrics.size) return;
        const update = (items: YoutubeSearchResult[]) =>
          items.map((result) =>
            idsWithLyrics.has(result.id) && !result.hasLyrics
              ? { ...result, hasLyrics: true }
              : result,
          );
        setYoutubeResults(update);
        setGlobalYoutubeResults(update);
        const cached = youtubeSearchCache.current.get(cacheKey);
        if (cached)
          youtubeSearchCache.current.set(cacheKey, {
            ...cached,
            results: update(cached.results),
          });
      })
      .catch(() => {
        /* Search results remain usable if caption details cannot load. */
      })
      .finally(() => {
        youtubeLyricsProbes.current.delete(probeKey);
      });
  }
  useLayoutEffect(() => {
    if (!menu || isAndroid) return;
    const menuElement = trackMenuRef.current;
    if (!menuElement) return;
    const menuTop = Math.max(
      8,
      Math.min(menu.y, window.innerHeight - menuElement.offsetHeight - 8),
    );
    menuElement.style.top = `${menuTop}px`;
    const submenu = playlistSubmenuRef.current;
    if (!submenu || submenu.classList.contains("submenu-inline")) return;
    const bounds = submenu.getBoundingClientRect();
    const adjustment =
      bounds.bottom > window.innerHeight - 8
        ? window.innerHeight - 8 - bounds.bottom
        : bounds.top < 8
          ? 8 - bounds.top
          : 0;
    submenu.style.transform = `translateY(${adjustment}px)`;
  }, [menu, playlistSubmenu, isAndroid]);
  useEffect(() => {
    if (!menu || isAndroid) return;
    const closeOnResize = () => setMenu(null);
    window.addEventListener("resize", closeOnResize);
    return () => window.removeEventListener("resize", closeOnResize);
  }, [menu, isAndroid]);
  const clearableYoutubeDownloads = youtubeDownloads.some(
    isFinishedYoutubeDownload,
  );
  const activeYoutubeDownloadCount = youtubeDownloads.filter(
    (item) => item.status === "queued" || item.status === "downloading",
  ).length;
  const hasActiveYoutubeDownloads = activeYoutubeDownloadCount > 0;
  const mobileDownloadBadgeCount = Math.max(
    activeYoutubeDownloadCount,
    unseenDownloadIds.length,
  );
  const selectedPlaylist =
    page.detail?.kind === "playlist"
      ? playlists.find((item) => item.id === page.detail?.key)
      : undefined;
  const addSongsSearchTerm = addSongsSearch.trim().toLocaleLowerCase();
  const youtubePlaylist = playlists.find(
    (item) => item.name.trim().toLocaleLowerCase() === "youtube",
  );
  const isYoutubePlaylist =
    selectedPlaylist?.name.trim().toLocaleLowerCase() === "youtube";

  const folderYoutubeSearch = useYoutubeSearch({
    query: youtubeQuery,
    enabled: isYoutubePlaylist,
    online: browserOnline,
    cache: youtubeSearchCache,
    initialLimit: youtubeFolderInitialResultLimit,
    pageSize: youtubeSearchPageSize,
    minimumQueryLength: 1,
    debounceMs: 500,
    offlineMessage: "YouTube search needs an internet connection.",
    requestErrorMessage: "Couldn't search YouTube. Try again.",
    onEnrich: enrichYoutubeLyrics,
    onLoadMoreError: () => setMessage("Couldn't load more YouTube results. Try again."),
  });
  const globalYoutubeSearch = useYoutubeSearch({
    query: search,
    enabled: isTauri() && globalYoutubeSearchEnabled,
    online: browserOnline,
    cache: youtubeSearchCache,
    initialLimit: youtubeGlobalInitialResultLimit,
    pageSize: youtubeSearchPageSize,
    minimumQueryLength: 2,
    debounceMs: 450,
    offlineMessage: "YouTube search is unavailable offline. Your local matches are still shown.",
    requestErrorMessage: "YouTube search couldn't load. Check your connection and try again.",
    onEnrich: enrichYoutubeLyrics,
    onLoadMoreError: () => setMessage("Couldn't load more YouTube results. Try again."),
  });
  const youtubeResults = folderYoutubeSearch.results;
  const setYoutubeResults = folderYoutubeSearch.setResults;
  const youtubeSearching = folderYoutubeSearch.searching;
  const youtubeSearchError = folderYoutubeSearch.error;
  const youtubeVisibleLimit = folderYoutubeSearch.visibleLimit;
  const youtubeHasMore = folderYoutubeSearch.hasMore;
  const youtubeLoadingMore = folderYoutubeSearch.loadingMore;
  const globalYoutubeResults = globalYoutubeSearch.results;
  const setGlobalYoutubeResults = globalYoutubeSearch.setResults;
  const globalYoutubeSearching = globalYoutubeSearch.searching;
  const globalYoutubeError = globalYoutubeSearch.error;
  const globalYoutubeVisibleLimit = globalYoutubeSearch.visibleLimit;
  const globalYoutubeHasMore = globalYoutubeSearch.hasMore;
  const globalYoutubeLoadingMore = globalYoutubeSearch.loadingMore;

  const navigate = useCallback((next: Page) => {
    setHistory((prior) => ({
      entries: [...prior.entries.slice(0, prior.index + 1), next],
      index: prior.index + 1,
    }));
    setSearch("");
    setInlineSearch("");
    setMenu(null);
    setAppMenu(false);
    setSortMenuOpen(false);
    setSearchOpen(false);
  }, []);
  function travel(delta: number) {
    setHistory((prior) => ({
      ...prior,
      index: Math.max(
        0,
        Math.min(prior.entries.length - 1, prior.index + delta),
      ),
    }));
    setSearch("");
    setInlineSearch("");
    setMenu(null);
    setAppMenu(false);
    setSortMenuOpen(false);
    setSearchOpen(false);
  }
  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setPlayer(await api.state());
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  }, []);
  function openMetadataEditor(track: Track) {
    setMenu(null);
    setMetadataTrack(track);
    setMetadataSheetDragY(0);
    setMetadataSheetDragging(false);
    setMetadataDraft({
      title: track.title,
      artist: track.artist,
      album: track.album,
      releaseDate: track.releaseDate,
    });
    setMetadataError("");
  }
  async function saveMetadata() {
    if (!metadataTrack || metadataSaving) return;
    setMetadataSaving(true);
    setMetadataError("");
    try {
      const updated = await api.updateTrackMetadata(
        metadataTrack.id,
        metadataDraft,
      );
      setTracks((prior) =>
        prior.map((track) =>
          track.id === updated.track.id ? updated.track : track,
        ),
      );
      setMetadataTrack(null);
      setMessage(
        updated.savedToFile
          ? "Metadata saved to the song file."
          : `Metadata saved in MichoPlay. The song file was not changed: ${updated.writeError || "Android denied write access."}`,
      );
    } catch (error) {
      setMetadataError(String(error));
    } finally {
      setMetadataSaving(false);
    }
  }
  useEffect(() => {
    if (player.volume > 0) lastAudibleVolume.current = player.volume;
  }, [player.volume]);
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
    if (seekCommitTimer.current !== null)
      window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = window.setTimeout(() => {
      seekCommitTimer.current = null;
      void commitSeek(target);
    }, 180);
  }
  function toggleFullMode() {
    if (fullMode) {
      setFullMode(false);
      if (document.fullscreenElement)
        void document.exitFullscreen().catch(() => {});
      return;
    }
    setFullMode(true);
    if (document.documentElement.requestFullscreen)
      void document.documentElement.requestFullscreen().catch(() => {});
  }
  const refresh = useCallback(
    async (folders: string[] = roots) => {
      if (!isTauri()) {
        setMessage("Open the desktop app to load local music.");
        return;
      }
      setScanning(true);
      setMessage("");
      try {
        const scanned = await api.refresh(folders);
        setTracks(scanned);
        setPlayer(await api.state());
        if (youtubeDirectory && folders.includes(youtubeDirectory))
          setYoutubeFolderScanned(true);
      } catch (error) {
        setMessage(String(error));
      } finally {
        setScanning(false);
      }
    },
    [roots, youtubeDirectory],
  );
  const syncYoutubeLibrary = useCallback(async () => {
    if (!isTauri() || !youtubeDirectory) return [];
    const nextRoots = [...new Set([...roots, youtubeDirectory])];
    const knownIds = new Set(
      tracks
        .filter((track) => track.rootPath === youtubeDirectory)
        .map((track) => track.id),
    );
    setScanning(true);
    try {
      const scanned = await api.refresh(nextRoots);
      setRoots(nextRoots);
      setTracks(scanned);
      setPlayer(await api.state());
      setYoutubeFolderScanned(true);
      const newIds = scanned
        .filter(
          (track) =>
            track.rootPath === youtubeDirectory && !knownIds.has(track.id),
        )
        .map((track) => track.id);
      if (newIds.length)
        setMessage(
          `Saved ${newIds.length} ${newIds.length === 1 ? "song" : "songs"} to Music/MichoPlay`,
        );
      return scanned;
    } catch (error) {
      setMessage(String(error));
      return [];
    } finally {
      setScanning(false);
    }
  }, [youtubeDirectory, roots, tracks]);
  useEffect(() => {
    if (!youtubeDirectory || !youtubeFolderScanned) return;
    const folderTrackIds = tracks
      .filter((track) => track.rootPath === youtubeDirectory)
      .map((track) => track.id);
    setPlaylists((prior) => {
      const existing = prior.find(
        (item) => item.name.trim().toLocaleLowerCase() === "youtube",
      );
      if (!existing)
        return [
          {
            id: "michoplay-youtube",
            name: "YouTube",
            trackIds: folderTrackIds,
          },
          ...prior,
        ];
      if (
        existing.trackIds.length === folderTrackIds.length &&
        existing.trackIds.every((id, index) => id === folderTrackIds[index])
      )
        return prior;
      return prior.map((item) =>
        item.id === existing.id ? { ...item, trackIds: folderTrackIds } : item,
      );
    });
  }, [tracks, youtubeDirectory, youtubeFolderScanned]);
  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
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
        if (!release || typeof release !== "object" || !("tag_name" in release))
          return;
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
    const onOnline = () => {
      void checkForUpdate();
    };
    void checkForUpdate();
    const interval = window.setInterval(
      () => {
        void checkForUpdate();
      },
      12 * 60 * 60 * 1000,
    );
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
    void api.volume(stored("volume", defaultVolume()));
    void api.autoplay(stored("autoplay", true));
    void api.equalizer(equalizerBands, equalizerEnabled);
    // Restore library and playback preferences once on launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!isTauri()) {
      setStartupLoading(false);
      return;
    }
    let active = true;
    setStartupPhase("Preparing your library…");
    void api
      .youtubeMusicDirectory()
      .then(async (directory) => {
        if (!active) return;
        setStartupPhase("Loading saved music…");
        const savedRoots = await api.librarySavedRoots().catch(() => []);
        const discoveredRoots = isAndroid
          ? await api.discoverMusicFolders().catch((error) => {
              if (active) setMessage(String(error));
              return [];
            })
          : [];
        if (!active) return;
        setYoutubeDirectory(directory);
        setYoutubeFolderScanned(false);
        const nextRoots = [
          ...new Set([
            ...(savedRoots.length ? savedRoots : roots),
            ...discoveredRoots,
            directory,
          ]),
        ];
        setRoots(nextRoots);
        setPlaylists((prior) =>
          prior.some(
            (item) => item.name.trim().toLocaleLowerCase() === "youtube",
          )
            ? prior
            : [
                { id: "michoplay-youtube", name: "YouTube", trackIds: [] },
                ...prior,
              ],
        );
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
      })
      .catch((error) => {
        if (active) {
          setMessage(String(error));
          setStartupLoading(false);
        }
      });
    return () => {
      active = false;
    };
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
    if (!downloadFeedback) return;
    const timeout = window.setTimeout(() => {
      setDownloadFeedback((current) =>
        current?.key === downloadFeedback.key ? null : current,
      );
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [downloadFeedback]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const applyDownloads = async (items: YoutubeDownload[]) => {
      if (!active) return;
      const previous = latestYoutubeDownloads.current;
      latestYoutubeDownloads.current = items;
      const version = ++youtubeDownloadsVersion.current;
      const progressOnly =
        previous.length === items.length &&
        items.every(
          (item, index) =>
            item.id === previous[index].id &&
            item.status === previous[index].status &&
            item.phase === previous[index].phase,
        );
      const update = () =>
        setYoutubeDownloads((prior) =>
          version === youtubeDownloadsVersion.current &&
          !sameYoutubeDownloads(prior, items)
            ? items
            : prior,
        );
      if (progressOnly) startTransition(update);
      else update();
      const settledUrls = new Set(
        items
          .filter(
            (item) => item.status === "failed" || item.status === "cancelled",
          )
          .map((item) => item.url),
      );
      if (settledUrls.size)
        setGlobalYoutubeDownloadRequested((prior) => {
          const next = prior.filter((url) => !settledUrls.has(url));
          return next.length === prior.length ? prior : next;
        });
      const newlyCompletedIds = items
        .filter(
          (item) =>
            item.status === "completed" &&
            !completedYoutubeDownloads.current.has(item.id),
        )
        .map((item) => item.id);
      items
        .filter((item) => item.status === "completed")
        .forEach((item) => completedYoutubeDownloads.current.add(item.id));
      if (newlyCompletedIds.length) {
        const completed = items.filter((item) =>
          newlyCompletedIds.includes(item.id),
        );
        const audioPaths = completed.flatMap((item) => item.filePaths ?? []);
        try {
          if (audioPaths.length) await api.embedDownloadedLyrics(audioPaths);
        } catch {
          /* Keep completed downloads available even if optional lyrics metadata cannot be written. */
        }
        await syncYoutubeLibrary();
      }
    };
    const initialVersion = youtubeDownloadsVersion.current;
    void api
      .youtubeDownloadsState()
      .then((items) => {
        if (!active || initialVersion !== youtubeDownloadsVersion.current)
          return;
        latestYoutubeDownloads.current = items;
        setYoutubeDownloads((prior) =>
          sameYoutubeDownloads(prior, items) ? prior : items,
        );
        completedYoutubeDownloads.current = new Set(
          items
            .filter((item) => item.status === "completed")
            .map((item) => item.id),
        );
        if (isAndroid) {
          const paths = items
            .filter((item) => item.status === "completed")
            .flatMap((item) => item.filePaths ?? []);
          void api
            .embedDownloadedLyrics(paths)
            .then((embedded) => {
              if (active && embedded.length) void syncYoutubeLibrary();
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    let poll: number | undefined;
    if (isAndroid && hasActiveYoutubeDownloads) {
      const refresh = async () => {
        try {
          applyDownloads(await api.youtubeDownloadsState());
        } catch {
          /* Keep the latest download state until the bridge responds. */
        }
        if (active && hasActiveYoutubeDownloads)
          poll = window.setTimeout(() => {
            void refresh();
          }, 2500);
      };
      poll = window.setTimeout(() => {
        void refresh();
      }, 1200);
    }
    if (isAndroid) {
      void addPluginListener<{ items: YoutubeDownload[] }>(
        "michoplay-media",
        "youtube-downloads-updated",
        ({ items }) => { if (active && Array.isArray(items)) void applyDownloads(items); },
      ).then((listener) => {
        if (active) unlisten = () => { void listener.unregister(); };
        else void listener.unregister();
      }).catch(() => {});
    } else {
      void listen<YoutubeDownload[]>(
        "youtube-downloads-updated",
        ({ payload }) => applyDownloads(payload),
      ).then((dispose) => {
        unlisten = dispose;
      });
    }
    return () => {
      active = false;
      if (poll !== undefined) window.clearTimeout(poll);
      unlisten?.();
    };
  }, [isAndroid, hasActiveYoutubeDownloads, syncYoutubeLibrary]);
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const openDesktopFiles = async (paths: string[]) => {
      if (!paths.length || !active) return;
      setScanning(true);
      setMessage("");
      try {
        const scanned = await api.openAudioFiles(paths);
        if (!active) return;
        setTracks(scanned);
        setPlayer(await api.state());
        const folders = paths.map((path) => path.replace(/[\\/][^\\/]+$/, ""));
        setRoots((prior) => [...new Set([...prior, ...folders])]);
        setMessage("");
      } catch (error) {
        if (active) setMessage(String(error));
      } finally {
        if (active) setScanning(false);
      }
    };
    const drainDesktopFiles = () =>
      api
        .takePendingAudioOpens()
        .then((paths) => openDesktopFiles(paths))
        .catch((error) => setMessage(String(error)));
    void listen("open-audio-files-ready", () => {
      void drainDesktopFiles();
    }).then((stop) => {
      unlisten = stop;
      if (!isAndroid) void drainDesktopFiles();
      else
        void api
          .takeOpenedAudio()
          .then((paths) => {
            if (paths.length && active) void openDesktopFiles(paths);
          })
          .catch((error) => setMessage(String(error)));
    });
    return () => {
      active = false;
      unlisten?.();
    };
    // The file-open bridge should only be installed once per app launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog'], button, a",
        )
      )
        return;
      const key = event.key.toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      if (modified && !event.altKey && !event.shiftKey && key === "arrowleft") {
        event.preventDefault();
        if (tracks.length) void run(api.previous);
      } else if (
        modified &&
        !event.altKey &&
        !event.shiftKey &&
        key === "arrowright"
      ) {
        event.preventDefault();
        if (tracks.length) void run(api.next);
      } else if (modified && !event.altKey && event.shiftKey && key === "s") {
        event.preventDefault();
        if (tracks.length) void run(api.shuffle);
      } else if (modified && !event.altKey && !event.shiftKey && key === "r") {
        event.preventDefault();
        if (tracks.length) void run(api.repeat);
      } else if (modified && !event.altKey && !event.shiftKey && key === "k") {
        event.preventDefault();
        setSearchOpen(true);
        document.querySelector<HTMLInputElement>(".search-box input")?.focus();
      } else if (
        !modified &&
        !event.altKey &&
        !event.shiftKey &&
        event.code === "Space"
      ) {
        event.preventDefault();
        if (player.currentTrackId !== null) void run(api.toggle);
      } else if (
        !modified &&
        !event.altKey &&
        !event.shiftKey &&
        (key === "arrowleft" || key === "arrowright")
      ) {
        if (player.currentTrackId === null || !player.durationMs) return;
        event.preventDefault();
        const offset = key === "arrowleft" ? -5000 : 5000;
        void run(() =>
          api.seek(
            Math.max(
              0,
              Math.min(player.durationMs, player.positionMs + offset),
            ),
          ),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    player.currentTrackId,
    player.durationMs,
    player.positionMs,
    run,
    tracks.length,
  ]);
  useEffect(() => {
    if (isAndroid) return;
    const blockRestrictedShortcuts = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modified = event.ctrlKey || event.metaKey;
      const openDevtools =
        key === "f12" ||
        (modified && event.shiftKey && ["i", "j", "c", "k"].includes(key)) ||
        (event.metaKey && event.altKey && ["i", "j", "c"].includes(key));
      if (openDevtools) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", blockRestrictedShortcuts, true);
    return () => {
      window.removeEventListener("keydown", blockRestrictedShortcuts, true);
    };
  }, [isAndroid]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const savePlaybackSession = (state: PlayerSnapshot) => {
      const queue =
        state.currentTrackId === null
          ? state.queue
          : [state.currentTrackId, ...state.queue];
      saveStoredData(
        "playback-session",
        JSON.stringify({
          currentTrackId: state.currentTrackId,
          queue,
          positionMs: state.positionMs,
          isPlaying: state.isPlaying,
        } satisfies SavedPlaybackSession),
      );
    };
    const flushPlaybackSession = () => {
      if (!playbackRestoreComplete.current || tracks.length === 0) return;
      savePlaybackSession(latestPlayerSnapshot.current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPlaybackSession();
    };
    window.addEventListener("pagehide", flushPlaybackSession);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const tick = async () => {
      try {
        let state = await api.state();
        if (!active) return;
        if (!playbackRestoreStarted.current && tracks.length > 0) {
          playbackRestoreStarted.current = true;
          const saved = stored<SavedPlaybackSession | null>(
            "playback-session",
            null,
          );
          const available = new Set(
            tracks
              .filter((track) => !hiddenTrackIds.includes(track.id))
              .map((track) => track.id),
          );
          const queue = [
            ...new Set((saved?.queue ?? []).filter((id) => available.has(id))),
          ];
          if (state.currentTrackId === null && queue.length > 0 && saved) {
            const startId =
              saved.currentTrackId !== null &&
              queue.includes(saved.currentTrackId)
                ? saved.currentTrackId
                : null;
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
        if (
          playbackRestoreComplete.current &&
          now - lastPlaybackSaveAt.current >= 5000
        ) {
          lastPlaybackSaveAt.current = now;
          savePlaybackSession(state);
        }
      } catch {
        if (!playbackRestoreComplete.current)
          playbackRestoreStarted.current = false;
        /* The player can become available after the library loads. */
      }
    };
    tick();
    const timer = window.setInterval(tick, 400);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", flushPlaybackSession);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tracks, hiddenTrackIds]);
  useEffect(() => {
    saveStoredData("library-roots", JSON.stringify(roots));
  }, [roots]);
  useEffect(() => {
    if (!sortMenuOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".sort-control")
      )
        setSortMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortMenuOpen]);
  useEffect(() => {
    saveStoredData("zoom-level", JSON.stringify(zoomLevel));
    saveStoredData("zoom-level-customized", "true");
    const applyZoom = () => {
      const scale = zoomLevel / 100;
      document.documentElement.style.setProperty("--app-zoom", String(scale));
      document.documentElement.style.setProperty(
        "--app-frame-width",
        `${window.innerWidth / scale}px`,
      );
      document.documentElement.style.setProperty(
        "--app-frame-height",
        `${window.innerHeight / scale}px`,
      );
      document.documentElement.style.setProperty(
        "--app-frame-min-height",
        `${500 / scale}px`,
      );
    };
    applyZoom();
    window.addEventListener("resize", applyZoom);
    return () => window.removeEventListener("resize", applyZoom);
  }, [zoomLevel]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']"))
        return;
      if (["-", "_", "Subtract", "NumpadSubtract"].includes(event.key)) {
        event.preventDefault();
        setZoomLevel((value) => normalizeZoom(value - 10));
      } else if (["+", "=", "Add", "NumpadAdd"].includes(event.key)) {
        event.preventDefault();
        setZoomLevel((value) => normalizeZoom(value + 10));
      } else if (event.key === "0") {
        event.preventDefault();
        setZoomLevel(isAndroid ? 120 : 100);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAndroid]);
  useEffect(() => {
    saveStoredData("favorites", JSON.stringify(favorites));
  }, [favorites]);
  useEffect(() => {
    saveStoredData("hidden-tracks", JSON.stringify(hiddenTrackIds));
  }, [hiddenTrackIds]);
  useEffect(() => {
    saveStoredData("playlists", JSON.stringify(playlists));
  }, [playlists]);
  useEffect(() => {
    saveStoredData("listening-history", JSON.stringify(listeningHistory));
  }, [listeningHistory]);
  useEffect(() => {
    saveStoredData("recent-searches", JSON.stringify(recentSearches));
  }, [recentSearches]);
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".global-search, .track-menu")
      )
        setSearchOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSearchOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [searchOpen]);
  useEffect(() => {
    const trackId = player.currentTrackId;
    if (trackId === null) {
      lastStartedTrack.current = null;
      return;
    }
    if (lastStartedTrack.current === trackId) return;
    lastStartedTrack.current = trackId;
    setListeningHistory((prior) => {
      const now = Date.now();
      const current = tracks.find((track) => track.id === trackId);
      const existing = prior.find((entry) => entry.trackId === trackId);
      const entry: ListeningRecord = {
        trackId,
        lastPlayedAt: now,
        playCount: (existing?.playCount ?? 0) + 1,
        positionMs: 0,
        durationMs: current?.durationMs ?? existing?.durationMs ?? 0,
      };
      return [entry, ...prior.filter((item) => item.trackId !== trackId)].slice(
        0,
        500,
      );
    });
  }, [player.currentTrackId, tracks]);
  useEffect(() => {
    if (player.currentTrackId === null || player.positionMs < 1000) return;
    setListeningHistory((prior) => {
      const entry = prior.find(
        (item) => item.trackId === player.currentTrackId,
      );
      if (
        !entry ||
        (player.isPlaying &&
          Math.abs(player.positionMs - entry.positionMs) < 5000)
      )
        return prior;
      return prior.map((item) =>
        item.trackId === player.currentTrackId
          ? {
              ...item,
              positionMs: player.positionMs,
              durationMs: player.durationMs || item.durationMs,
            }
          : item,
      );
    });
  }, [
    player.currentTrackId,
    player.positionMs,
    player.durationMs,
    player.isPlaying,
  ]);
  useEffect(() => {
    saveStoredData("sidebar-width", JSON.stringify(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    saveStoredData("panel-width", JSON.stringify(panelWidth));
  }, [panelWidth]);
  useEffect(() => {
    saveStoredData("show-now-playing", JSON.stringify(showPanel));
  }, [showPanel]);
  useEffect(() => {
    saveStoredData(
      "keep-screen-awake-in-full-mode",
      JSON.stringify(keepScreenAwake),
    );
  }, [keepScreenAwake]);
  useEffect(() => {
    let active = true;
    type WakeLockSentinelLike = {
      release: () => Promise<void>;
      addEventListener?: (type: "release", listener: () => void) => void;
    };
    type WakeLockNavigator = Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    };
    const requestWakeLock = async () => {
      if (
        !fullMode ||
        !keepScreenAwake ||
        document.visibilityState !== "visible" ||
        wakeLockRef.current
      )
        return;
      try {
        const wakeLock = await (
          navigator as WakeLockNavigator
        ).wakeLock?.request("screen");
        if (!wakeLock) return;
        if (!active) await wakeLock.release();
        else {
          wakeLockRef.current = wakeLock;
          wakeLock.addEventListener?.("release", () => {
            if (wakeLockRef.current === wakeLock) wakeLockRef.current = null;
          });
        }
      } catch {
        /* Screen wake lock is optional on unsupported desktop webviews. */
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void requestWakeLock();
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && fullMode) setFullMode(false);
    };
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
  useEffect(() => {
    saveStoredData("compact", JSON.stringify(compact));
  }, [compact]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (
        !(event.target as HTMLElement).closest(
          ".action-menu, .menu-trigger, .playlist-actions-trigger",
        )
      ) {
        setMenu(null);
        setAppMenu(false);
        setPlaylistActionsOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileQueueOpen(false);
        setMenu(null);
        setAppMenu(false);
        setPlaylistActionsOpen(false);
        setDialog(null);
        if (!confirmationBusy) setConfirmation(null);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [confirmationBusy]);

  useEffect(() => {
    if (!isAndroid) return;
    let disposed = false;
    let unregister: (() => void) | undefined;
    void onBackButtonPress(() => {
      if (confirmationBusy) return;
      if (mobileQueueOpen) {
        setMobileQueueOpen(false);
        return;
      }
      if (mobilePlayerOpen) {
        setMobilePlayerOpen(false);
        return;
      }
      if (fullMode) {
        setFullMode(false);
        if (document.fullscreenElement)
          void document.exitFullscreen().catch(() => {});
        return;
      }
      if (dialog || confirmation || menu || appMenu || sortMenuOpen) {
        setDialog(null);
        setConfirmation(null);
        setMenu(null);
        setAppMenu(false);
        setSortMenuOpen(false);
        return;
      }
      if (mobileTab !== "home") {
        setMobileTab("home");
        setSearch("");
        if (history.index > 0) travel(-1);
        return;
      }
      if (history.index > 0) {
        travel(-1);
        return;
      }
      if (page.section !== "Home" || page.detail) {
        setHistory({ entries: [{ section: "Home" }], index: 0 });
      }
    })
      .then((listener) => {
        if (disposed) void listener.unregister();
        else
          unregister = () => {
            void listener.unregister();
          };
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unregister?.();
    };
  }, [
    isAndroid,
    mobileQueueOpen,
    mobilePlayerOpen,
    fullMode,
    dialog,
    confirmation,
    confirmationBusy,
    menu,
    appMenu,
    sortMenuOpen,
    mobileTab,
    history,
    page,
  ]);

  function mobileSheetStyle(sheet: string): CSSProperties {
    const active = mobileSheetDrag?.sheet === sheet;
    return {
      "--mobile-sheet-drag": active ? `${mobileSheetDrag.offset}px` : "0px",
      transition: active && mobileSheetDrag.dragging ? "none" : undefined,
    } as CSSProperties;
  }
  function beginMobileSheetDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    sheet: string,
  ) {
    const now = performance.now();
    mobileSheetDragState.current = {
      sheet,
      startY: event.clientY,
      lastY: event.clientY,
      lastAt: now,
      velocity: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveMobileSheetDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    sheet: string,
  ) {
    const drag = mobileSheetDragState.current;
    if (!drag || drag.sheet !== sheet) return;
    const now = performance.now();
    drag.velocity =
      (event.clientY - drag.lastY) / Math.max(1, now - drag.lastAt);
    drag.lastY = event.clientY;
    drag.lastAt = now;
    setMobileSheetDrag({
      sheet,
      offset: Math.max(0, event.clientY - drag.startY),
      dragging: true,
    });
  }
  function finishMobileSheetDrag(sheet: string, close: () => void) {
    const drag = mobileSheetDragState.current;
    if (!drag || drag.sheet !== sheet) return;
    mobileSheetDragState.current = null;
    const shouldClose = drag.lastY - drag.startY > 85 || drag.velocity > 0.55;
    setMobileSheetDrag({
      sheet,
      offset: shouldClose ? window.innerHeight : 0,
      dragging: false,
    });
    window.setTimeout(
      () => {
        if (shouldClose) close();
        setMobileSheetDrag((current) =>
          current?.sheet === sheet ? null : current,
        );
      },
      shouldClose ? 270 : 260,
    );
  }
  function cancelMobileSheetDrag(sheet: string) {
    mobileSheetDragState.current = null;
    setMobileSheetDrag((current) =>
      current?.sheet === sheet
        ? { sheet, offset: 0, dragging: false }
        : current,
    );
    window.setTimeout(
      () =>
        setMobileSheetDrag((current) =>
          current?.sheet === sheet ? null : current,
        ),
      260,
    );
  }
  function beginMobileQueueReorder(
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
  ) {
    event.stopPropagation();
    const handle = event.currentTarget;
    const reorder = {
      from: index,
      to: index,
      offset: 0,
      active: false,
      pointerId: event.pointerId,
      startY: event.clientY,
      timer: null as number | null,
    };
    mobileQueueReorderRef.current = reorder;
    reorder.timer = window.setTimeout(() => {
      const current = mobileQueueReorderRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.active = true;
      handle.setPointerCapture(event.pointerId);
      setMobileQueueReorder({
        from: current.from,
        to: current.to,
        offset: current.offset,
        active: true,
      });
      navigator.vibrate?.(12);
    }, 380);
  }
  function moveMobileQueueReorder(event: ReactPointerEvent<HTMLButtonElement>) {
    const reorder = mobileQueueReorderRef.current;
    const list = mobileQueueListRef.current;
    if (!reorder || reorder.pointerId !== event.pointerId) return;
    if (!reorder.active) {
      if (Math.abs(event.clientY - reorder.startY) > 9) {
        if (reorder.timer !== null) window.clearTimeout(reorder.timer);
        mobileQueueReorderRef.current = null;
      }
      return;
    }
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 34) list.scrollTop -= 12;
    else if (event.clientY > bounds.bottom - 34) list.scrollTop += 12;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>("[data-queue-index]"),
    );
    const targetRow = rows
      .filter((row) => Number(row.dataset.queueIndex) !== reorder.from)
      .sort((first, second) => {
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        const firstShift =
          Number.parseFloat(
            getComputedStyle(first).getPropertyValue("--queue-shift-y"),
          ) || 0;
        const secondShift =
          Number.parseFloat(
            getComputedStyle(second).getPropertyValue("--queue-shift-y"),
          ) || 0;
        return (
          Math.abs(
            event.clientY - (firstRect.top + firstRect.height / 2 - firstShift),
          ) -
          Math.abs(
            event.clientY -
              (secondRect.top + secondRect.height / 2 - secondShift),
          )
        );
      })[0];
    let to = reorder.to;
    if (targetRow) to = Number(targetRow.dataset.queueIndex);
    else if (rows.length) {
      const first = rows[0].getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (event.clientY < first.top) to = Number(rows[0].dataset.queueIndex);
      else if (event.clientY > last.bottom)
        to = Number(rows[rows.length - 1].dataset.queueIndex);
    }
    reorder.to = to;
    reorder.offset = event.clientY - reorder.startY;
    setMobileQueueReorder({
      from: reorder.from,
      to: reorder.to,
      offset: reorder.offset,
      active: true,
    });
  }
  function finishMobileQueueReorder(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const reorder = mobileQueueReorderRef.current;
    if (reorder?.timer !== null && reorder?.timer !== undefined)
      window.clearTimeout(reorder.timer);
    mobileQueueReorderRef.current = null;
    setMobileQueueReorder(null);
    if (
      reorder?.active &&
      reorder.pointerId === event.pointerId &&
      reorder.from !== reorder.to
    )
      void run(() => api.queueMove(reorder.from, reorder.to));
  }
  function cancelMobileQueueReorder() {
    if (
      mobileQueueReorderRef.current?.timer !== null &&
      mobileQueueReorderRef.current?.timer !== undefined
    )
      window.clearTimeout(mobileQueueReorderRef.current.timer);
    mobileQueueReorderRef.current = null;
    setMobileQueueReorder(null);
  }
  function beginMetadataSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const now = performance.now();
    metadataSheetDrag.current = {
      startY: event.clientY,
      lastY: event.clientY,
      lastAt: now,
      velocity: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setMetadataSheetDragging(true);
  }
  function moveMetadataSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = metadataSheetDrag.current;
    if (!drag) return;
    const now = performance.now();
    drag.velocity =
      (event.clientY - drag.lastY) / Math.max(1, now - drag.lastAt);
    drag.lastY = event.clientY;
    drag.lastAt = now;
    setMetadataSheetDragY(Math.max(0, event.clientY - drag.startY));
  }
  function endMetadataSheetDrag() {
    const drag = metadataSheetDrag.current;
    metadataSheetDrag.current = null;
    setMetadataSheetDragging(false);
    if (drag && (drag.lastY - drag.startY > 105 || drag.velocity > 0.58)) {
      setMetadataSheetDragY(0);
      setMetadataTrack(null);
    } else {
      setMetadataSheetDragY(0);
    }
  }

  async function chooseFolder() {
    if (!isTauri()) {
      setMessage("Open the desktop app to choose music folders.");
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a music folder",
      });
      if (typeof selected !== "string") return;
      setScanning(true);
      setMessage("");
      const scanned = await api.scanFolder(selected);
      setTracks(scanned);
      setPlayer(await api.state());
      const canonical =
        scanned.find((track) => track.rootPath === selected)?.rootPath ??
        selected;
      setRoots((prior) =>
        prior.includes(canonical) ? prior : [...prior, canonical],
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setScanning(false);
    }
  }
  async function importAudioPayloads(
    payloads: { name: string; dataBase64: string }[],
    playImported = false,
  ) {
    if (!isTauri()) {
      setMessage("Open MichoPlay to import local audio.");
      return;
    }
    const supported = payloads.filter((file) =>
      /\.(mp3|flac|wav|ogg|opus|m4a|aac|aiff|aif)$/i.test(file.name),
    );
    if (!supported.length) {
      setMessage("Choose one or more supported audio files.");
      return;
    }
    if (supported.length > 100) {
      setMessage("Choose no more than 100 audio files at a time.");
      return;
    }
    setScanning(true);
    setMessage("");
    try {
      if (playImported) {
        const scanned = await api.importAndPlayFiles(supported);
        setTracks(scanned);
        setPlayer(await api.state());
        setRoots((prior) => [
          ...new Set([...prior, ...scanned.map((track) => track.rootPath)]),
        ]);
        setMessage(
          `Opened ${supported.length} ${supported.length === 1 ? "song" : "songs"}.`,
        );
        return;
      }
      let imported = 0;
      const failures: string[] = [];
      for (const [index, file] of supported.entries()) {
        setMessage(`Importing ${index + 1} of ${supported.length}…`);
        try {
          await api.importFiles([file]);
          imported++;
        } catch (error) {
          failures.push(`${file.name}: ${String(error)}`);
        }
      }
      if (!imported)
        throw new Error(
          failures[0] ?? "No selected audio files could be imported.",
        );
      const musicDirectory = await api.importDirectory();
      const scanned = await api.scanFolder(musicDirectory);
      setTracks(scanned);
      setPlayer(await api.state());
      setRoots((prior) =>
        prior.includes(musicDirectory) ? prior : [...prior, musicDirectory],
      );
      setMessage(
        `Imported ${imported} ${imported === 1 ? "song" : "songs"}.${failures.length ? ` ${failures.length} file${failures.length === 1 ? "" : "s"} skipped.` : ""}`,
      );
    } catch (error) {
      setMessage(`Music import failed: ${String(error)}`);
    } finally {
      setScanning(false);
    }
  }
  async function importAudioFiles(files: File[]) {
    const supported = files.filter(
      (file) =>
        file.type.startsWith("audio/") ||
        /\.(mp3|flac|wav|ogg|opus|m4a|aac|aiff|aif)$/i.test(file.name),
    );
    if (!supported.length) {
      setMessage("Choose one or more supported audio files.");
      return;
    }
    if (supported.some((file) => file.size > 256 * 1024 * 1024)) {
      setMessage("Each audio file must be 256 MB or smaller.");
      return;
    }
    const payloads = await Promise.all(
      supported.map(async (file) => ({
        name: file.name,
        dataBase64: await fileToBase64(file),
      })),
    );
    await importAudioPayloads(payloads);
  }
  function showMobileDownloadFeedback(
    source?: DOMRect,
    label = "Added to Downloads",
  ) {
    const target = downloadNavRef.current?.getBoundingClientRect();
    const x = Math.max(
      16,
      Math.min(
        window.innerWidth - 16,
        source ? source.left + source.width / 2 : window.innerWidth / 2,
      ),
    );
    const y = Math.max(
      24,
      Math.min(
        window.innerHeight - 80,
        source ? source.top + source.height / 2 : window.innerHeight / 2,
      ),
    );
    const targetX = target
      ? target.left + target.width / 2
      : window.innerWidth * 0.9;
    const targetY = target
      ? target.top + target.height / 2
      : window.innerHeight - 44;
    setDownloadFeedback({
      key: ++downloadFeedbackVersion.current,
      label,
      x,
      y,
      targetX,
      targetY,
    });
  }
  function openMobileDownloads() {
    setMobileTab("downloads");
    setUnseenDownloadIds([]);
    setDownloadFeedback(null);
  }
  async function queueYoutubeDownload(
    selected: YoutubeSearchResult,
    source?: DOMRect,
    playlist?: YoutubeDownloadPlaylist,
  ) {
    setMessage("");
    try {
      const item = await api.youtubeDownloadEnqueue(
        selected.url,
        selected.title,
        selected.thumbnail,
        selected.isPlaylist,
        playlist,
      );
      setYoutubeDownloads((prior) =>
        prior.some((download) => download.id === item.id)
          ? prior
          : [...prior, item],
      );
      if (isAndroid) {
        setUnseenDownloadIds((prior) =>
          prior.includes(item.id) ? prior : [...prior, item.id],
        );
        if (!playlist) showMobileDownloadFeedback(source);
      } else {
        setPanelView("downloads");
        setShowPanel(true);
      }
      return true;
    } catch (error) {
      setMessage(youtubeDownloadErrorText(String(error), selected.isPlaylist));
      return false;
    }
  }
  function requestYoutubeDownload(
    selected: YoutubeSearchResult,
    query?: string,
    source?: DOMRect,
  ) {
    if (query) rememberSearch(query);
    if (selected.isPlaylist) {
      setPlaylistSelection(selected);
      return;
    }
    const existing = youtubeDownloads.find(
      (download) =>
        download.url === selected.url &&
        !["failed", "cancelled"].includes(download.status),
    );
    if (existing) {
      if (isAndroid) {
        setUnseenDownloadIds((prior) =>
          prior.includes(existing.id) ? prior : [...prior, existing.id],
        );
        showMobileDownloadFeedback(source, "Already in Downloads");
      }
      return;
    }
    if (globalYoutubeDownloadRequested.includes(selected.url)) return;
    setGlobalYoutubeDownloadRequested((prior) =>
      prior.includes(selected.url) ? prior : [...prior, selected.url],
    );
    void queueYoutubeDownload(selected, source).then((queued) => {
      if (!queued)
        setGlobalYoutubeDownloadRequested((prior) =>
          prior.filter((url) => url !== selected.url),
        );
    });
  }

  async function queueSelectedPlaylistSongs(songs: YoutubeSearchResult[]) {
    const playlist = playlistSelection;
    setPlaylistSelection(null);
    if (!playlist || songs.length === 0) return;
    const playlistId = playlist.id || playlist.url;
    const queueable = songs.filter((song) => !youtubeDownloads.some((item) => item.url === song.url && !["failed", "cancelled"].includes(item.status)));
    let queued = 0;
    for (const [index, song] of queueable.entries()) {
      const context: YoutubeDownloadPlaylist = {
        id: playlistId,
        title: playlist.title,
        index: index + 1,
        total: queueable.length,
      };
      if (await queueYoutubeDownload(song, undefined, context)) queued += 1;
    }
    if (isAndroid) {
      setMobileTab("downloads");
      if (queued > 0) showMobileDownloadFeedback(undefined, `Added ${queued} ${queued === 1 ? "song" : "songs"}`);
    } else {
      setPanelView("downloads");
      setShowPanel(true);
      if (queued > 0) setMessage(`Added ${queued} ${queued === 1 ? "song" : "songs"} from “${playlist.title}”.`);
    }
  }

  async function playYoutubeDownload(item: YoutubeDownload) {
    let matching = tracksForDownload(item, tracks, youtubeDirectory);
    if (!matching.length)
      matching = tracksForDownload(
        item,
        await syncYoutubeLibrary(),
        youtubeDirectory,
      );
    if (matching.length) {
      const trackIds = matching.map((track) => track.id);
      if (matching[0].id === player.currentTrackId) {
        await run(api.toggle);
        return;
      }
      await run(() => api.playCollection(trackIds, trackIds[0]));
    } else
      setMessage(
        "The downloaded audio could not be found in Music/MichoPlay. Try refreshing the library.",
      );
  }
  function openDownloadedTrackMenu(item: YoutubeDownload, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const track = tracksForDownload(item, tracks, youtubeDirectory)[0];
    if (track) {
      openTrackMenuAt(track, rect);
      return;
    }
    if (!youtubeDirectory) {
      setMessage(
        "This download is still being added to your library. Try again shortly.",
      );
      return;
    }
    void syncYoutubeLibrary()
      .then((scanned) => {
        const target = tracksForDownload(item, scanned, youtubeDirectory)[0];
        if (target) openTrackMenuAt(target, rect);
        else
          setMessage(
            "The downloaded song could not be found in Music/MichoPlay.",
          );
      })
      .catch((error) => setMessage(String(error)));
  }
  async function controlYoutubeDownload(
    id: string,
    action: "pause" | "resume" | "cancel" | "remove",
  ) {
    try {
      const item = youtubeDownloads.find((download) => download.id === id);
      if (action === "pause") await api.youtubeDownloadPause(id);
      else if (action === "resume") await api.youtubeDownloadResume(id);
      else if (action === "cancel") await api.youtubeDownloadCancel(id);
      else await api.youtubeDownloadRemove(id);
      if (item && (action === "cancel" || action === "remove"))
        setGlobalYoutubeDownloadRequested((prior) =>
          prior.filter((url) => url !== item.url),
        );
    } catch (error) {
      setMessage(youtubeDownloadErrorText(String(error)));
    }
  }
  async function clearYoutubeDownloads() {
    try {
      const finished = youtubeDownloads.filter(isFinishedYoutubeDownload);
      if (!finished.length) return;
      for (const item of finished) await api.youtubeDownloadRemove(item.id);
      const remaining = await api.youtubeDownloadsState();
      const remainingUrls = new Set(remaining.map((item) => item.url));
      setYoutubeDownloads(remaining);
      setGlobalYoutubeDownloadRequested((prior) =>
        prior.filter((url) => remainingUrls.has(url)),
      );
    } catch (error) {
      setMessage(String(error));
    }
  }
  function chooseLibrarySource() {
    if (isAndroid) {
      setScanning(true);
      setMessage("");
      void api
        .pickMusicFolder()
        .then(async ({ path, count, name }) => {
          const nextRoots = [...new Set([...roots, path])];
          const scanned = await api.refresh(nextRoots);
          setTracks(scanned);
          setPlayer(await api.state());
          setRoots(nextRoots);
          setMessage(
            `Added ${count} ${count === 1 ? "song" : "songs"} from ${name}.`,
          );
        })
        .catch((error) => {
          if (!String(error).toLowerCase().includes("cancel"))
            setMessage(String(error));
        })
        .finally(() => setScanning(false));
    } else void chooseFolder();
  }
  async function chooseAndroidAudioFiles() {
    setScanning(true);
    setMessage("");
    try {
      const paths = await api.pickAudioFiles();
      if (!paths.length) return;
      const scanned = await api.addAudioFiles(paths);
      setTracks(scanned);
      setPlayer(await api.state());
      setRoots((prior) => [
        ...new Set([
          ...prior,
          ...paths.map((path) => path.replace(/[\\/][^\\/]+$/, "")),
        ]),
      ]);
      setMessage(
        `Added ${paths.length} selected ${paths.length === 1 ? "song" : "songs"} and scanned their folders.`,
      );
    } catch (error) {
      if (!String(error).toLowerCase().includes("cancel"))
        setMessage(String(error));
    } finally {
      setScanning(false);
    }
  }
  function openYoutubePage() {
    const youtube = youtubePlaylist ?? {
      id: "michoplay-youtube",
      name: "YouTube",
      trackIds: [],
    };
    if (!youtubePlaylist)
      setPlaylists((prior) =>
        prior.some((item) => item.name.trim().toLocaleLowerCase() === "youtube")
          ? prior
          : [youtube, ...prior],
      );
    setSearch("");
    setMobileTab(isAndroid ? "youtube" : "home");
    navigate({
      section: "Playlists",
      detail: { kind: "playlist", key: youtube.id, title: youtube.name },
    });
  }

  async function removeFolder(folder: string) {
    try {
      const remaining = await api.removeFolder(folder);
      setTracks(remaining);
      setRoots((prior) => prior.filter((root) => root !== folder));
      setMessage("");
      void api
        .state()
        .then(setPlayer)
        .catch((error) => setMessage(String(error)));
      return true;
    } catch (error) {
      setConfirmationError(String(error));
      return false;
    }
  }
  async function completeConfirmation() {
    if (!confirmation || confirmationBusy) return;
    const accepted = confirmation;
    setConfirmationError(null);
    setConfirmationBusy(true);
    try {
      if ((await accepted.confirm()) !== false) {
        setConfirmation((current) => (current === accepted ? null : current));
      }
    } finally {
      setConfirmationBusy(false);
    }
  }
  function confirmRemoveFolder(folder: string) {
    setConfirmationError(null);
    setConfirmation({
      title: "Remove music folder?",
      message: `“${folder}” will be removed from your library. The files on disk will stay untouched.`,
      label: "Remove folder",
      confirm: () => removeFolder(folder),
    });
  }
  async function deleteAudioTrack(track: Track) {
    try {
      const remaining = await api.deleteTrack(track.id);
      setTracks(remaining);
      setPlayer(await api.state());
      setMessage(`Deleted “${track.title}” from your device.`);
      return true;
    } catch (error) {
      if (isAndroid) setMessage(String(error));
      else setConfirmationError(String(error));
      return false;
    }
  }
  function confirmDeleteAudioTrack(track: Track) {
    setMenu(null);
    setConfirmationError(null);
    setConfirmation({
      title: "Delete from device?",
      message: `“${track.title}” will be permanently deleted from your device.`,
      label: "Delete from device",
      confirm: () => deleteAudioTrack(track),
    });
  }
  function confirmDeletePlaylist(playlist: Playlist) {
    setConfirmationError(null);
    setConfirmation({
      title: "Delete playlist?",
      message: `“${playlist.name}” and its song list will be removed. Your music files will stay untouched.`,
      label: "Delete playlist",
      confirm: () => {
        setPlaylists((prior) =>
          prior.filter((item) => item.id !== playlist.id),
        );
        setHistory((prior) => ({
          entries: [
            ...prior.entries.slice(0, prior.index + 1),
            { section: "Playlists" },
          ],
          index: prior.index + 1,
        }));
        setConfirmation(null);
        setPlaylistActionsOpen(false);
      },
    });
  }
  function confirmRemovePlaylistTrack(playlist: Playlist, track: Track) {
    setConfirmationError(null);
    setConfirmation({
      title: "Remove song from playlist?",
      message: `“${track.title}” will be removed from “${playlist.name}”.`,
      label: "Remove song",
      confirm: () => {
        setPlaylists((prior) =>
          prior.map((item) =>
            item.id === playlist.id
              ? {
                  ...item,
                  trackIds: item.trackIds.filter((id) => id !== track.id),
                }
              : item,
          ),
        );
        setConfirmation(null);
        setMenu(null);
      },
    });
  }
  function toggleFavorite(id: number) {
    setFavorites((prior) =>
      prior.includes(id) ? prior.filter((item) => item !== id) : [...prior, id],
    );
  }
  function hideTrack(track: Track) {
    setHiddenTrackIds((prior) =>
      prior.includes(track.id) ? prior : [...prior, track.id],
    );
    setMenu(null);
    void api
      .state()
      .then(async (state) => {
        const queuedIndexes = state.queue
          .flatMap((id, index) => (id === track.id ? [index] : []))
          .reverse();
        for (const index of queuedIndexes) await api.queueRemove(index);
        if (state.currentTrackId === track.id && state.isPlaying)
          await api.setPlaying(false);
        setPlayer(await api.state());
      })
      .catch((error) =>
        setMessage(
          `Could not remove the hidden song from the queue: ${String(error)}`,
        ),
      );
  }
  function restoreTrack(id: number) {
    setHiddenTrackIds((prior) => prior.filter((trackId) => trackId !== id));
  }
  function startResize(which: "sidebar" | "panel", event: ReactPointerEvent) {
    event.preventDefault();
    const start = event.clientX;
    const width = which === "sidebar" ? sidebarWidth : panelWidth;
    const move = (next: globalThis.PointerEvent) => {
      if (which === "sidebar")
        setSidebarWidth(
          Math.max(184, Math.min(360, width + next.clientX - start)),
        );
      else
        setPanelWidth(
          Math.max(250, Math.min(460, width - next.clientX + start)),
        );
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  }

  const trackMap = useMemo(
    () => new Map(tracks.map((track) => [track.id, track])),
    [tracks],
  );
  const hiddenTrackSet = useMemo(
    () => new Set(hiddenTrackIds),
    [hiddenTrackIds],
  );
  const availableTracks = useMemo(
    () => tracks.filter((track) => !hiddenTrackSet.has(track.id)),
    [tracks, hiddenTrackSet],
  );
  const hiddenTracks = useMemo(
    () => tracks.filter((track) => hiddenTrackSet.has(track.id)),
    [tracks, hiddenTrackSet],
  );
  const normalizedTrackSearch = useMemo(
    () =>
      new Map(
        tracks.map((track) => [
          track.id,
          `${track.title} ${track.artist} ${track.album} ${track.folderName}`.toLocaleLowerCase(),
        ]),
      ),
    [tracks],
  );
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const addSongsFilteredTracks = useMemo(() => {
    if (!addSongsPlaylistId) return [];
    return availableTracks.filter(
      (track) =>
        !addSongsSearchTerm ||
        normalizedTrackSearch.get(track.id)?.includes(addSongsSearchTerm),
    );
  }, [
    addSongsPlaylistId,
    availableTracks,
    addSongsSearchTerm,
    normalizedTrackSearch,
  ]);
  const addSongsVisibleTracks = addSongsFilteredTracks.slice(
    0,
    addSongsVisibleLimit,
  );
  const addSongsSelectedSet = useMemo(
    () => new Set(addSongsSelected),
    [addSongsSelected],
  );
  const addSongsAlreadyAddedSet = useMemo(
    () =>
      new Set(
        playlists.find((item) => item.id === addSongsPlaylistId)?.trackIds ??
          [],
      ),
    [playlists, addSongsPlaylistId],
  );
  const visibleQueue = queueExpanded ? player.queue : player.queue.slice(0, 80);
  const fullBrowsePlaylist =
    playlists.find((playlist) => playlist.id === fullBrowsePlaylistId) ?? null;
  const fullBrowsePlaylistTracks = useMemo(
    () =>
      fullBrowsePlaylist?.trackIds.flatMap((id) =>
        !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : [],
      ) ?? [],
    [fullBrowsePlaylist, trackMap, hiddenTrackSet],
  );
  const current =
    player.currentTrackId === null
      ? null
      : (trackMap.get(player.currentTrackId) ?? null);
  useEffect(() => {
    let live = true;
    setLyricsText(null);
    if (current?.hasLyrics)
      void api
        .lyricsRead(current.id)
        .then((text) => {
          if (live) setLyricsText(text);
        })
        .catch(() => {
          if (live) setLyricsText(null);
        });
    return () => {
      live = false;
    };
  }, [current?.id, current?.hasLyrics]);
  const currentArtworkDataUrl = useArtwork(current?.artworkKey);
  const recentTracks = useMemo(
    () =>
      listeningHistory
        .slice()
        .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
        .flatMap((entry) =>
          !hiddenTrackSet.has(entry.trackId) && trackMap.has(entry.trackId)
            ? [trackMap.get(entry.trackId)!]
            : [],
        ),
    [listeningHistory, trackMap, hiddenTrackSet],
  );
  const nowPlayingTrack = current;
  const nowPlayingIsActive = current !== null && player.isPlaying;
  const footerTrack = current ?? recentTracks[0] ?? null;
  useEffect(() => {
    document
      .querySelectorAll<HTMLElement>(".download-item, .mobile-download-row")
      .forEach((row, index) => {
        const item = youtubeDownloads[index];
        const button = row.querySelector<HTMLButtonElement>(
          ".download-art-play, .mobile-download-art > button",
        );
        if (!item || !button) return;
        const isPlaying =
          item.status === "completed" &&
          player.isPlaying &&
          tracksForDownload(item, tracks, youtubeDirectory).some(
            (track) => track.id === player.currentTrackId,
          );
        button.dataset.playing = String(isPlaying);
        button.setAttribute(
          "aria-label",
          `${isPlaying ? "Pause" : "Play"} ${item.title}`,
        );
        button.title = isPlaying
          ? "Pause downloaded audio"
          : "Play downloaded audio";
      });
  }, [
    isAndroid,
    mobileTab,
    panelView,
    showPanel,
    youtubeDownloads,
    tracks,
    youtubeDirectory,
    player.currentTrackId,
    player.isPlaying,
  ]);
  const mobileSwipeNextTrack =
    player.priorityQueue
      .concat(player.queue)
      .map((id) => trackMap.get(id))
      .find((track) => track && track.id !== footerTrack?.id) ?? null;
  const mobileSwipePreviousTrack =
    recentTracks.find((track) => track.id !== footerTrack?.id) ?? null;
  useEffect(() => {
    if (current && player.isPlaying) {
      setShowPanel(true);
    }
  }, [current?.id, player.isPlaying]);
  const folders = useMemo(() => {
    const groups = new Map<string, Collection>();
    const rootsWithDirectSongs = new Set(
      availableTracks
        .filter((track) => track.folderPath === track.rootPath)
        .map((track) => track.rootPath),
    );
    for (const track of availableTracks)
      for (const folder of track.folders) {
        // Include roots only when they have direct songs, and include every music-bearing descendant.
        if (
          folder.path === track.rootPath &&
          !rootsWithDirectSongs.has(track.rootPath)
        )
          continue;
        if (!groups.has(folder.path))
          groups.set(folder.path, {
            key: folder.path,
            title: folder.name,
            subtitle: folder.path,
            tracks: [],
          });
        groups.get(folder.path)!.tracks.push(track);
      }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const albums = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of availableTracks) {
      const key = albumKey(track);
      if (!groups.has(key))
        groups.set(key, {
          key,
          title: track.album,
          subtitle: track.artist,
          tracks: [],
        });
      groups.get(key)!.tracks.push(track);
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const artists = useMemo(() => {
    const groups = new Map<string, Collection>();
    for (const track of availableTracks) {
      if (!groups.has(track.artist))
        groups.set(track.artist, {
          key: track.artist,
          title: track.artist,
          subtitle: "",
          tracks: [],
        });
      groups.get(track.artist)!.tracks.push(track);
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [availableTracks]);
  const sidebarPlaylistItems = useMemo(() => {
    const items = playlists.filter(
      (item) =>
        item.name.trim().toLocaleLowerCase() !== "youtube" &&
        item.name
          .toLocaleLowerCase()
          .includes(sidebarLibrarySearch.trim().toLocaleLowerCase()),
    );
    if (sidebarLibrarySort === "az")
      items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }, [playlists, sidebarLibrarySearch, sidebarLibrarySort]);
  const collectionTracks = useMemo(() => {
    const detail = page.detail;
    if (page.section === "Recently Played") return recentTracks;
    if (detail?.kind === "folder")
      return availableTracks.filter((track) =>
        track.folders.some((folder) => folder.path === detail.key),
      );
    if (detail?.kind === "album")
      return availableTracks.filter((track) => albumKey(track) === detail.key);
    if (detail?.kind === "artist")
      return availableTracks.filter((track) => track.artist === detail.key);
    if (detail?.kind === "playlist")
      return (selectedPlaylist?.trackIds ?? []).flatMap((id) =>
        !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : [],
      );
    return page.section === "Favorites"
      ? availableTracks.filter((track) => favoriteSet.has(track.id))
      : availableTracks;
  }, [
    page,
    availableTracks,
    selectedPlaylist,
    trackMap,
    favoriteSet,
    recentTracks,
    hiddenTrackSet,
  ]);
  const deferredInlineSearch = useDeferredValue(inlineSearch);
  const inlineSearchTerm = deferredInlineSearch.trim().toLocaleLowerCase();
  const visibleTracks = useMemo(
    () =>
      collectionTracks.filter(
        (track) =>
          !inlineSearchTerm ||
          normalizedTrackSearch.get(track.id)?.includes(inlineSearchTerm),
      ),
    [collectionTracks, inlineSearchTerm, normalizedTrackSearch],
  );
  const playlistSearchMatches = useMemo(
    () =>
      inlineSearchTerm
        ? collectionTracks
            .filter((track) =>
              normalizedTrackSearch.get(track.id)?.includes(inlineSearchTerm),
            )
            .slice(0, 8)
        : [],
    [collectionTracks, inlineSearchTerm, normalizedTrackSearch],
  );
  const collectionDurationMs = useMemo(
    () => collectionTracks.reduce((sum, track) => sum + track.durationMs, 0),
    [collectionTracks],
  );
  const collectionHasCurrent = useMemo(
    () => collectionTracks.some((track) => track.id === player.currentTrackId),
    [collectionTracks, player.currentTrackId],
  );
  const sortedVisibleTracks = useMemo(() => {
    const sorted = [...visibleTracks];
    const compareTitle = (a: Track, b: Track) =>
      a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    if (sortBy === "titleAsc") sorted.sort(compareTitle);
    else if (sortBy === "titleDesc") sorted.sort((a, b) => compareTitle(b, a));
    else if (sortBy === "recentlyAdded")
      sorted.sort((a, b) => b.addedAt - a.addedAt || compareTitle(a, b));
    else if (sortBy === "durationAsc")
      sorted.sort((a, b) => a.durationMs - b.durationMs || compareTitle(a, b));
    else if (sortBy === "durationDesc")
      sorted.sort((a, b) => b.durationMs - a.durationMs || compareTitle(a, b));
    return sorted;
  }, [visibleTracks, sortBy]);
  const heading = selectedPlaylist?.name ?? page.detail?.title ?? page.section;
  const firstArt = useMemo(
    () => collectionTracks.find((track) => track.artworkKey)?.artworkKey,
    [collectionTracks],
  );
  const headingArt = useArtwork(firstArt);
  const listPage =
    Boolean(page.detail) ||
    page.section === "Songs" ||
    page.section === "Favorites" ||
    page.section === "Recently Played";
  const showAllPage =
    !listPage &&
    ["Folders", "Playlists", "Albums", "Artists"].includes(page.section);
  useEffect(() => {
    setPlaylistSearchOpen(false);
  }, [page.section, page.detail?.key]);
  const globalSearchIndex = useMemo(() => {
    type SearchEntry = { searchText: string; result: GlobalSearchResult };
    const songs: SearchEntry[] = availableTracks.map((track) => ({
      searchText: normalizedTrackSearch.get(track.id) ?? "",
      result: {
        type: "Song",
        title: track.title,
        subtitle: `Song · ${track.artist}`,
        artworkKey: track.artworkKey,
        trackId: track.id,
        hasLyrics: track.hasLyrics,
      },
    }));
    const artistEntries: SearchEntry[] = artists.map((item) => ({
      searchText: item.title.toLocaleLowerCase(),
      result: {
        type: "Artist",
        title: item.title,
        subtitle: `Artist · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`,
        artworkKey:
          item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
        page: {
          section: "Artists",
          detail: { kind: "artist", key: item.key, title: item.title },
        },
      },
    }));
    const albumEntries: SearchEntry[] = albums.map((item) => ({
      searchText: `${item.title} ${item.subtitle}`.toLocaleLowerCase(),
      result: {
        type: "Album",
        title: item.title,
        subtitle: `Album · ${item.subtitle}`,
        artworkKey:
          item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
        page: {
          section: "Albums",
          detail: { kind: "album", key: item.key, title: item.title },
        },
      },
    }));
    const folderEntries: SearchEntry[] = folders.map((item) => ({
      searchText: `${item.title} ${item.subtitle}`.toLocaleLowerCase(),
      result: {
        type: "Folder",
        title: item.title,
        subtitle: `Folder · ${item.tracks.length} ${item.tracks.length === 1 ? "song" : "songs"}`,
        artworkKey:
          item.tracks.find((track) => track.artworkKey)?.artworkKey ?? null,
        page: {
          section: "Home",
          detail: { kind: "folder", key: item.key, title: item.title },
        },
      },
    }));
    const playlistEntries: SearchEntry[] = playlists.map((playlist) => {
      const playlistTracks = playlist.trackIds.flatMap((id) =>
        !hiddenTrackSet.has(id) && trackMap.has(id) ? [trackMap.get(id)!] : [],
      );
      return {
        searchText:
          `${playlist.name} ${playlistTracks.map((track) => normalizedTrackSearch.get(track.id) ?? "").join(" ")}`.toLocaleLowerCase(),
        result: {
          type: "Playlist",
          title: playlist.name,
          subtitle: `Playlist · ${playlistTracks.length} ${playlistTracks.length === 1 ? "song" : "songs"}`,
          artworkKey:
            playlistTracks.find((track) => track.artworkKey)?.artworkKey ??
            null,
          page: {
            section: "Playlists",
            detail: {
              kind: "playlist",
              key: playlist.id,
              title: playlist.name,
            },
          },
        } satisfies GlobalSearchResult,
      };
    });
    return {
      songs,
      artists: artistEntries,
      albums: albumEntries,
      folders: folderEntries,
      playlists: playlistEntries,
    };
  }, [
    availableTracks,
    artists,
    albums,
    folders,
    playlists,
    trackMap,
    normalizedTrackSearch,
    hiddenTrackSet,
  ]);
  const buildSearchResults = useCallback(
    (value: string): GlobalSearchResult[] => {
      const query = value.trim().toLocaleLowerCase();
      if (!query) return [];
      const matches = (
        entries: { searchText: string; result: GlobalSearchResult }[],
        limit: number,
      ) => {
        const found: GlobalSearchResult[] = [];
        for (const entry of entries) {
          if (entry.searchText.includes(query)) found.push(entry.result);
          if (found.length === limit) break;
        }
        return found;
      };
      return [
        ...matches(globalSearchIndex.songs, 4),
        ...matches(globalSearchIndex.artists, 2),
        ...matches(globalSearchIndex.albums, 2),
        ...matches(globalSearchIndex.folders, 2),
        ...matches(globalSearchIndex.playlists, 2),
      ];
    },
    [globalSearchIndex],
  );
  const deferredSearch = useDeferredValue(search);
  const searchResults = useMemo(
    () => buildSearchResults(deferredSearch),
    [buildSearchResults, deferredSearch],
  );
  const recentSearchResults = useMemo(
    () =>
      recentSearches.map((query) => ({
        query,
        result: buildSearchResults(query)[0] ?? null,
      })),
    [recentSearches, buildSearchResults],
  );

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
        if (Number.isFinite(delta))
          void run(async () => {
            const state = await api.state();
            await api.seek(
              Math.max(0, Math.min(state.durationMs, state.positionMs + delta)),
            );
          });
        return;
      }
      switch (action) {
        case "open-audio":
          void api
            .takeOpenedAudio()
            .then(async (paths) => {
              if (!paths.length) return;
              const scanned = await api.openAudioFiles(paths);
              setTracks(scanned);
              setPlayer(await api.state());
              setRoots((prior) => [
                ...new Set([
                  ...prior,
                  ...paths.map((path) => path.replace(/[\\/][^\\/]+$/, "")),
                ]),
              ]);
            })
            .catch((error) => setMessage(String(error)));
          break;
        case "toggle":
          void run(api.toggle);
          break;
        case "play":
          void run(() => api.setPlaying(true));
          break;
        case "pause":
          void run(() => api.setPlaying(false));
          break;
        case "previous":
          void run(api.previous);
          break;
        case "next":
          void run(api.next);
          break;
      }
    };
    if (isAndroid) {
      // Android media actions are handled by the Rust playback loop so they
      // continue to reach the audio engine while this WebView is backgrounded.
      let unlistenFavorites: (() => void) | undefined;
      let active = true;
      const receiveFavorites = (ids: number[]) => {
        if (
          !Array.isArray(ids) ||
          !ids.every((id) => Number.isSafeInteger(id) && id >= 0)
        )
          return;
        setFavorites((prior) =>
          prior.length === ids.length &&
          prior.every((id, index) => id === ids[index])
            ? prior
            : ids,
        );
      };
      const refreshPlayerState = () => {
        if (document.visibilityState !== "visible") return;
        void api
          .state()
          .then(setPlayer)
          .catch(() => {});
      };
      const refreshOnResume = () => {
        refreshPlayerState();
        if (document.visibilityState !== "visible") return;
        void api
          .appDataLoad()
          .then((saved) => {
            if (!active || !saved.favorites) return;
            try {
              receiveFavorites(JSON.parse(saved.favorites));
            } catch {
              /* Keep the current favorites if saved data is unreadable. */
            }
          })
          .catch(() => {});
      };
      void listen<string>("android-player-state", refreshPlayerState).then(
        (dispose) => {
          if (active) unlisten = dispose;
          else dispose();
        },
      );
      void listen<number[]>("android-favorites-changed", ({ payload }) =>
        receiveFavorites(payload),
      ).then((dispose) => {
        if (active) unlistenFavorites = dispose;
        else dispose();
      });
      document.addEventListener("visibilitychange", refreshOnResume);
      window.addEventListener("focus", refreshOnResume);
      return () => {
        active = false;
        unlisten?.();
        unlistenFavorites?.();
        document.removeEventListener("visibilitychange", refreshOnResume);
        window.removeEventListener("focus", refreshOnResume);
      };
    }
    void listen<string>("system-media-control", ({ payload }) =>
      handleAction(payload),
    ).then((dispose) => {
      unlisten = dispose;
    });
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
        await api.mediaUpdate(
          current,
          state.isPlaying,
          state.durationMs,
          state.positionMs,
          currentArtworkDataUrl,
        );
      } catch {
        /* The player can start before Android creates the service. */
      }
    };
    void update();
    const timer = window.setInterval(() => {
      void update();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    isAndroid,
    current?.id,
    current?.title,
    current?.artist,
    currentArtworkDataUrl,
    player.isPlaying,
  ]);
  const playCollection = (track: Track, items = sortedVisibleTracks) => {
    if (track.id === player.currentTrackId) {
      void run(api.toggle);
      return;
    }
    void run(() =>
      api.playCollection(
        items.map((item) => item.id),
        track.id,
      ),
    );
  };
  const isCollectionCurrent = (item: Collection) => {
    const trackIds = new Set(item.tracks.map((track) => track.id));
    return (
      player.currentTrackId !== null &&
      trackIds.has(player.currentTrackId) &&
      player.queue.every((id) => trackIds.has(id))
    );
  };
  const playCardCollection = (item: Collection) => {
    const trackIds = item.tracks.map((track) => track.id);
    if (!trackIds.length) return;
    if (isCollectionCurrent(item)) void run(api.toggle);
    else void run(() => api.playCollection(trackIds, trackIds[0]));
  };
  function openTrackMenu(track: Track, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openTrackMenuAt(track, rect);
  }
  function openTrackMenuAt(track: Track, rect: DOMRect) {
    setMenu({
      track,
      x: Math.max(8, Math.min(window.innerWidth - 235, rect.right - 225)),
      y: Math.max(8, Math.min(window.innerHeight - 390, rect.bottom + 5)),
    });
    setPlaylistSubmenu(false);
    setPlaylistSearch("");
    setAppMenu(false);
  }
  async function shareMichoPlay() {
    const title = "MichoPlay";
    const text =
      "Check out MichoPlay, a free music player for Android, Windows, macOS, and Linux.";
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
      try {
        await navigator.share(details);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    try {
      await navigator.clipboard.writeText(text + "\n\n" + michoplayWebsiteUrl);
      setMessage("MichoPlay website copied to the clipboard.");
    } catch {
      setMessage(
        "Copy this message to share MichoPlay: " +
          text +
          " " +
          michoplayWebsiteUrl,
      );
    }
  }
  function openAboutUrl(url: string) {
    void openUrl(url).catch((error) =>
      setMessage(`Could not open the link: ${String(error)}`),
    );
  }
  function newPlaylist(target?: Track, playlist?: Playlist) {
    setDialog({ target, playlist });
    setPlaylistName(playlist?.name ?? "");
    setMenu(null);
  }
  function savePlaylist() {
    const name = playlistName.trim();
    if (!name || !dialog) return;
    if (dialog.playlist)
      setPlaylists((prior) =>
        prior.map((item) =>
          item.id === dialog.playlist!.id ? { ...item, name } : item,
        ),
      );
    else {
      const playlist: Playlist = {
        id: crypto.randomUUID(),
        name,
        trackIds: dialog.target ? [dialog.target.id] : [],
      };
      setPlaylists((prior) => [...prior, playlist]);
      if (!dialog.target) {
        if (isAndroid) setMobileTab("home");
        navigate({
          section: "Playlists",
          detail: { kind: "playlist", key: playlist.id, title: name },
        });
      }
    }
    setDialog(null);
  }
  function addToPlaylist(playlist: Playlist, track: Track) {
    setPlaylists((prior) =>
      prior.map((item) =>
        item.id === playlist.id && !item.trackIds.includes(track.id)
          ? { ...item, trackIds: [...item.trackIds, track.id] }
          : item,
      ),
    );
    setMenu(null);
    setMessage(`Added to ${playlist.name}.`);
  }
  function openDetail(
    section: Section,
    kind: Detail["kind"],
    item: Collection,
  ) {
    if (isAndroid) setMobileTab("home");
    navigate({ section, detail: { kind, key: item.key, title: item.title } });
  }
  function rememberSearch(query: string) {
    const normalized = query.trim();
    if (!normalized) return;
    const next = [
      normalized,
      ...recentSearches.filter(
        (item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
      ),
    ].slice(0, 8);
    setRecentSearches(next);
    saveStoredData("recent-searches", JSON.stringify(next));
  }
  function chooseSearchResult(result: GlobalSearchResult) {
    rememberSearch(search || result.title);
    if (result.trackId !== undefined) {
      if (isAndroid) setSearch("");
      setSearchOpen(!isAndroid);
      if (result.trackId === player.currentTrackId) void run(api.toggle);
      else void run(() => api.play(result.trackId!));
    } else if (result.page) {
      if (isAndroid) setMobileTab("home");
      navigate(result.page);
    }
  }
  function openSearchResultMenu(
    result: GlobalSearchResult,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    const track =
      result.trackId === undefined ? null : trackMap.get(result.trackId);
    if (!track) return;
    openTrackMenu(track, event);
  }
  const playCounts = useMemo(
    () =>
      new Map(
        listeningHistory.map((entry) => [entry.trackId, entry.playCount]),
      ),
    [listeningHistory],
  );
  const rows = (items: Track[], emptyTitle = "No songs here") => (
    <TrackRows
      items={items}
      player={player}
      favorites={favoriteSet}
      compact={compact}
      rowHeight={isAndroid ? 64 : undefined}
      playCounts={playCounts}
      showPlayCount={page.section === "Recently Played"}
      onPlay={(track) => playCollection(track, items)}
      onFavorite={toggleFavorite}
      onMenu={openTrackMenu}
      emptyTitle={
        scanning
          ? "Scanning music…"
          : search || inlineSearch
            ? "No results"
            : emptyTitle
      }
      emptyMessage={
        scanning
          ? "Reading local audio and artwork."
          : search || inlineSearch
            ? "Try another search."
            : page.section === "Favorites"
              ? "Save songs with the heart in their action menu."
              : page.section === "Recently Played"
                ? "Songs will appear here after you play them."
                : page.detail?.kind === "playlist"
                  ? "Add songs to this playlist from your library."
                  : "Add a music folder to get started."
      }
      emptyAction={
        !scanning &&
        !search &&
        !inlineSearch &&
        selectedPlaylist &&
        selectedPlaylist.name.toLocaleLowerCase() !== "youtube" ? (
          <button
            className="primary-button playlist-add-songs"
            onClick={() => {
              setAddSongsPlaylistId(selectedPlaylist.id);
              setAddSongsSelected([]);
              setAddSongsSearch("");
              setAddSongsVisibleLimit(100);
            }}
          >
            <Plus size={15} />
            Add songs
          </button>
        ) : undefined
      }
    />
  );
  const globalSearchContent = search.trim() ? (
    <>
      {!isAndroid &&
        isTauri() &&
        globalYoutubeSearchEnabled &&
        search.trim().length >= 2 && (
          <section className="global-search-group global-youtube-search-group">
            <h2>YouTube</h2>
            {globalYoutubeSearching ? (
              Array.from({ length: 3 }, (_, index) => (
                <div className="global-search-youtube-skeleton" key={index}>
                  <span />
                  <i />
                  <i />
                </div>
              ))
            ) : globalYoutubeError ? (
              <p className="global-search-status" role="status">
                {globalYoutubeError}
              </p>
            ) : globalYoutubeResults.length ? (
              <>
                <div
                  className="global-youtube-results-scroll"
                  role="region"
                  aria-label="YouTube search results"
                >
                  {globalYoutubeResults
                    .slice(0, globalYoutubeVisibleLimit)
                    .map((result) => (
                      <div
                        className="global-youtube-result-row"
                        key={result.id}
                      >
                        <button
                          className="global-search-result global-youtube-result"
                          role="option"
                          aria-label={`Download ${result.title} from YouTube`}
                          onClick={(event) =>
                            requestYoutubeDownload(
                              result,
                              search,
                              event.currentTarget.getBoundingClientRect(),
                            )
                          }
                        >
                          {result.thumbnail ? (
                            <img
                              className="cover global-search-cover"
                              src={result.thumbnail}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span className="cover global-search-cover global-youtube-placeholder">
                              <Youtube size={18} />
                            </span>
                          )}
                          <span className="search-result-copy">
                            <strong>{result.title}</strong>
                            <small>
                              {result.hasLyrics && (
                                <LyricsBadge />
                              )}
                              YouTube ·{" "}
                              {result.isPlaylist
                                ? "Playlist"
                                : `${result.durationSeconds == null ? "Audio" : durationLabel(result.durationSeconds)} · ${youtubeResultSize(result)}`}
                            </small>
                          </span>
                        </button>
                        {!globalYoutubeDownloadRequested.includes(result.url) &&
                          !youtubeDownloads.some(
                            (download) =>
                              download.url === result.url &&
                              !["failed", "cancelled"].includes(
                                download.status,
                              ),
                          ) && (
                            <button
                              className="global-youtube-download"
                              aria-label={`Download ${result.title}`}
                              title="Download audio"
                              onClick={(event) =>
                                requestYoutubeDownload(
                                  result,
                                  search,
                                  event.currentTarget.getBoundingClientRect(),
                                )
                              }
                            >
                              <Download size={16} />
                            </button>
                          )}
                      </div>
                    ))}
                </div>
                {globalYoutubeHasMore && (
                  <button
                    className="youtube-load-more global-youtube-load-more"
                    disabled={globalYoutubeLoadingMore}
                    onClick={() => void globalYoutubeSearch.loadMore()}
                  >
                    {globalYoutubeLoadingMore
                      ? "Loading YouTube results…"
                      : "Load more"}
                  </button>
                )}
              </>
            ) : !globalYoutubeSearching && !globalYoutubeError ? (
              <p className="global-search-status">No YouTube matches.</p>
            ) : null}
          </section>
        )}
      {searchResults.length ? (
        ["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => {
          const group = searchResults.filter((result) => result.type === type);
          return group.length ? (
            <section className="global-search-group" key={type}>
              <h2>{type === "Song" ? "Songs" : `${type}s`}</h2>
              {group.map((result) => (
                <GlobalSearchResultButton
                  key={`${result.type}-${result.title}-${result.subtitle}`}
                  result={result}
                  onClick={() => chooseSearchResult(result)}
                  onMenu={
                    result.type === "Song"
                      ? (event) => openSearchResultMenu(result, event)
                      : undefined
                  }
                  isPlaying={
                    result.trackId === player.currentTrackId && player.isPlaying
                  }
                  showPlayHover={false}
                />
              ))}
            </section>
          ) : null;
        })
      ) : (
        <div className="global-search-empty">
          <strong>No matches in your library for “{search}”</strong>
          <span>Try a song, artist, album, folder, or playlist name.</span>
        </div>
      )}
    </>
  ) : recentSearchResults.length ? (
    <section className="global-search-group">
      <div className="global-search-heading">
        <h2>Recent searches</h2>
        <button
          onClick={() => {
            setRecentSearches([]);
            saveStoredData("recent-searches", "[]");
          }}
        >
          Clear
        </button>
      </div>
      {recentSearchResults.map(({ query, result }) =>
        result ? (
          <GlobalSearchResultButton
            key={query}
            result={result}
            onClick={() => {
              setSearch(query);
              setSearchOpen(true);
            }}
            onMenu={
              result.type === "Song"
                ? (event) => openSearchResultMenu(result, event)
                : undefined
            }
            showPlayHover={false}
          />
        ) : (
          <button
            className="global-search-result recent-query"
            key={query}
            role="option"
            onClick={() => {
              setSearch(query);
              setSearchOpen(true);
            }}
          >
            <span className="search-result-symbol">
              <Search size={17} />
            </span>
            <span className="search-result-copy">
              <strong>{query}</strong>
              <small>Recent search</small>
            </span>
          </button>
        ),
      )}
    </section>
  ) : (
    <div className="global-search-empty">
      <strong>Search your library</strong>
      <span>Find songs, artists, albums, folders, and playlists.</span>
    </div>
  );

  const submenuPlacement =
    menu && !isAndroid ? playlistSubmenuPlacement(menu.x) : "";
  const updatePromptOpen = Boolean(
    availableUpdate && deferredUpdatePrompt !== availableUpdate,
  );
  const deferUpdatePrompt = () => {
    if (availableUpdate) setDeferredUpdatePrompt(availableUpdate);
  };
  const openUpdateDownload = () => {
    void openUrl(michoplayWebsiteUrl)
      .then(deferUpdatePrompt)
      .catch((error) => {
        setMessage(`Could not open the MichoPlay website: ${String(error)}`);
        deferUpdatePrompt();
      });
  };
  return (
    <main
      ref={appFrameRef}
      className={`app-frame ${compact ? "compact" : ""} ${isAndroid ? "android-app" : "desktop-app"}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--panel-width": `${panelWidth}px`,
        } as CSSProperties
      }
    >
      <svg className="mobile-svg-defs" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient
            id="michoplay-brand-gradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#f5c6be" />
            <stop offset="64%" stopColor="#f5eee8" />
            <stop offset="100%" stopColor="#d8eee4" />
          </linearGradient>
        </defs>
      </svg>
      {startupLoading && (
        <div
          className="startup-loading"
          role="status"
          aria-live="polite"
          aria-label="Loading MichoPlay"
        >
          <div className="startup-loading-card">
            <span className="startup-loading-mark">
              <AudioLines size={24} />
            </span>
            <div className="startup-loading-copy">
              <strong>Loading MichoPlay</strong>
              <span>{scanProgress?.phase ?? startupPhase}</span>
              {scanProgress?.total ? (
                <small>
                  {scanProgress.processed.toLocaleString()} of{" "}
                  {scanProgress.total.toLocaleString()} audio files
                </small>
              ) : (
                <small>Preparing your library…</small>
              )}
            </div>
            <span className="startup-loading-spinner" aria-hidden="true" />
          </div>
        </div>
      )}
      {!isAndroid && (
        <input
          ref={importInput}
          className="audio-import-input"
          type="file"
          accept="audio/*,.mp3,.flac,.wav,.ogg,.opus,.m4a,.aac,.aiff,.aif"
          multiple
          aria-label="Choose audio files"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void importAudioFiles(files);
          }}
        />
      )}
      <aside className="sidebar" aria-label="Main navigation">
        <button className="brand" onClick={() => navigate({ section: "Home" })}>
          <span className="brand-mark">
            <AudioLines size={19} />
          </span>
          <span>
            Micho<span className="brand-light">Play</span>
          </span>
        </button>
        <nav className="nav-list" aria-label="Library">
          {navigation.map(({ label, icon: Icon }) => (
            <Fragment key={label}>
              <button
                className={`nav-item ${page.section === label && !(label === "Playlists" && isYoutubePlaylist) ? "active" : ""}`}
                aria-label={label}
                title={label}
                aria-current={
                  page.section === label &&
                  !(label === "Playlists" && isYoutubePlaylist)
                    ? "page"
                    : undefined
                }
                onClick={() => {
                  setSearch("");
                  navigate({ section: label });
                }}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
              {label === "Favorites" && !isAndroid && (
                <button
                  className={`nav-item ${isYoutubePlaylist ? "active" : ""}`}
                  aria-label="YouTube"
                  title="YouTube"
                  aria-current={isYoutubePlaylist ? "page" : undefined}
                  onClick={() => {
                    const youtube = youtubePlaylist ?? {
                      id: "michoplay-youtube",
                      name: "YouTube",
                      trackIds: [],
                    };
                    if (!youtubePlaylist)
                      setPlaylists((prior) =>
                        prior.some(
                          (item) =>
                            item.name.trim().toLocaleLowerCase() === "youtube",
                        )
                          ? prior
                          : [youtube, ...prior],
                      );
                    setSearch("");
                    navigate({
                      section: "Playlists",
                      detail: {
                        kind: "playlist",
                        key: youtube.id,
                        title: youtube.name,
                      },
                    });
                  }}
                >
                  <Youtube size={18} />
                  <span>YouTube</span>
                </button>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-rule" />
        <div className="library-heading">
          <span className="side-label">Your Library</span>
          <div className="library-heading-actions">
            <button
              className="icon-button small"
              aria-label="Create playlist"
              title="Create playlist"
              onClick={() => newPlaylist()}
            >
              <Plus size={15} />
            </button>
            <button
              className="icon-button small"
              aria-label="Open playlists"
              title="Open playlists"
              onClick={() => navigate({ section: "Playlists" })}
            >
              <Maximize2 size={12} />
            </button>
          </div>
        </div>
        <div className="library-tools">
          <label className="library-search">
            <Search size={16} />
            <input
              aria-label="Search your library"
              placeholder="Search"
              value={sidebarLibrarySearch}
              onChange={(event) => setSidebarLibrarySearch(event.target.value)}
            />
            {sidebarLibrarySearch && (
              <button
                aria-label="Clear library search"
                onClick={() => setSidebarLibrarySearch("")}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <button
            className="library-sort"
            aria-label={`Sort ${sidebarLibrarySort === "recent" ? "recently added" : "alphabetically"}; click to change`}
            title="Change sort order"
            onClick={() =>
              setSidebarLibrarySort((value) =>
                value === "recent" ? "az" : "recent",
              )
            }
          >
            <span>{sidebarLibrarySort === "recent" ? "Recents" : "A–Z"}</span>
            <List size={16} />
          </button>
        </div>
        <div className="sidebar-playlists" aria-live="polite">
          {sidebarPlaylistItems.map((playlist) => {
            const firstTrack = playlist.trackIds
              .map((id) => trackMap.get(id))
              .find((track): track is Track => Boolean(track));
            const selected = selectedPlaylist?.id === playlist.id;
            return (
              <button
                key={playlist.id}
                className={`library-item ${selected ? "selected" : ""}`}
                onClick={() =>
                  navigate({
                    section: "Playlists",
                    detail: {
                      kind: "playlist",
                      key: playlist.id,
                      title: playlist.name,
                    },
                  })
                }
              >
                {firstTrack ? (
                  <Cover
                    className="library-item-art"
                    keys={[firstTrack.artworkKey]}
                  />
                ) : (
                  <span className="library-item-placeholder">
                    <ListMusic size={20} />
                  </span>
                )}
                <span className="library-item-copy">
                  <strong>{playlist.name}</strong>
                  <small className="library-item-meta">
                    <ListMusic size={12} />
                    <span className="library-item-count">
                      {playlist.trackIds.length}{" "}
                      {playlist.trackIds.length === 1 ? "song" : "songs"}
                    </span>
                  </small>
                </span>
              </button>
            );
          })}
          {!sidebarPlaylistItems.length && (
            <div className="library-empty">
              {sidebarLibrarySearch
                ? "No matching playlists"
                : "Create a playlist to keep songs together."}
            </div>
          )}
        </div>
      </aside>
      <div
        className="resize-handle sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) => startResize("sidebar", event)}
      />
      <section className="workspace">
        {isAndroid &&
          !mobilePlayerOpen &&
          page.section !== "Settings" &&
          !(listPage && (mobileTab === "home" || mobileTab === "youtube")) && (
            <header className="mobile-header">
              <div className="mobile-header-title">
                {showAllPage ? (
                  <button
                    className="mobile-header-back"
                    aria-label="Back to Home"
                    onClick={() => navigate({ section: "Home" })}
                  >
                    <ChevronLeft size={24} />
                  </button>
                ) : (
                  <span className="brand-mark">
                    <AudioLines size={19} />
                  </span>
                )}
                <h1>
                  {mobileTab === "downloads"
                    ? "Downloads"
                    : page.section === "Home"
                      ? mobileTab === "home"
                        ? "MichoPlay"
                        : mobileTab === "search"
                          ? "Search"
                          : mobileTab === "youtube"
                            ? "YouTube"
                            : "Your Library"
                      : page.section}
                </h1>
              </div>
              <div className="mobile-header-actions">
                {mobileTab === "home" && (
                  <button
                    className="mobile-icon-button"
                    aria-label="Search music"
                    onClick={() => {
                      setMobileTab("search");
                      setSearch("");
                    }}
                  >
                    <Search size={24} />
                  </button>
                )}
                {mobileTab === "library" && (
                  <button
                    className="mobile-icon-button"
                    aria-label="Create playlist or import music"
                    onClick={() => setMobileLibraryActionsOpen(true)}
                  >
                    <Plus size={25} />
                  </button>
                )}
                {mobileTab === "youtube" && (
                  <button
                    className="mobile-icon-button"
                    aria-label="Search YouTube"
                    onClick={() => {
                      setMobileTab("search");
                      setSearch("");
                    }}
                  >
                    <Search size={24} />
                  </button>
                )}
                <button
                  className="mobile-icon-button"
                  aria-label="Settings"
                  onClick={() => {
                    setMobileTab("home");
                    navigate({ section: "Settings" });
                  }}
                >
                  <Settings2 size={20} />
                </button>
              </div>
            </header>
          )}
        <header className="topbar">
          <div className="history-nav">
            <div className="app-menu-anchor">
              <button
                className="icon-button menu-trigger"
                aria-label="Application menu"
                aria-expanded={appMenu}
                onClick={() => {
                  setAppMenu(!appMenu);
                  setMenu(null);
                }}
              >
                <MoreHorizontal size={22} />
              </button>
              {appMenu && (
                <div className="action-menu app-menu">
                  <button
                    onClick={() => {
                      chooseLibrarySource();
                      setAppMenu(false);
                    }}
                  >
                    <Plus size={15} />
                    Add music folder
                  </button>
                  <button
                    onClick={() => {
                      void refresh();
                      setAppMenu(false);
                    }}
                  >
                    <RefreshCw size={15} />
                    Refresh library
                  </button>
                  <button onClick={() => newPlaylist()}>
                    <ListMusic size={15} />
                    New playlist
                  </button>
                  <div className="menu-separator" />
                  <button onClick={() => navigate({ section: "Settings" })}>
                    <Settings2 size={15} />
                    Settings
                  </button>
                  <button
                    onClick={() => {
                      setAboutOpen(true);
                      setAppMenu(false);
                    }}
                  >
                    <AudioLines size={15} />
                    About MichoPlay
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-button"
              aria-label="Go back"
              disabled={history.index === 0}
              onClick={() => travel(-1)}
            >
              <ChevronLeft size={24} />
            </button>
            <button
              className="icon-button"
              aria-label="Go forward"
              disabled={history.index === history.entries.length - 1}
              onClick={() => travel(1)}
            >
              <ChevronRight size={24} />
            </button>
          </div>
          <DesktopGlobalSearch
            value={search}
            open={searchOpen}
            content={globalSearchContent}
            onChange={setSearch}
            onOpenChange={setSearchOpen}
          />
          <button
            className={`topbar-downloads ${showPanel && panelView === "downloads" ? "active" : ""}`}
            aria-label="Downloads"
            title="Downloads"
            onClick={() => {
              setPanelView("downloads");
              setShowPanel(true);
            }}
          >
            <Download size={18} />
          </button>
          <button
            className={`topbar-settings ${page.section === "Settings" ? "active" : ""}`}
            aria-label="Settings"
            title="Settings"
            onClick={() => navigate({ section: "Settings" })}
          >
            <Settings2 size={18} />
          </button>
        </header>
        <div
          className={`work-area ${showPanel ? "with-panel" : "without-panel"}`}
        >
          <section className="content-scroll" aria-label={heading}>
            {!isAndroid && lyricsOpen && footerTrack?.hasLyrics ? (
              <div className="desktop-lyrics-stage">
                <LyricsView
                  track={footerTrack}
                  text={lyricsText ?? ""}
                  positionMs={player.positionMs}
                  onSeek={(positionMs) => void run(() => api.seek(positionMs))}
                />
              </div>
            ) : (
              <>
                {isAndroid && page.section === "Settings" ? (
                  mobileAboutOpen ? (
                    <MobileAboutPage
                      version={appVersion}
                      onBack={() => setMobileAboutOpen(false)}
                      onOpenUrl={(url) => {
                        void openUrl(url).catch((error) =>
                          setMessage(
                            `Could not open the link: ${String(error)}`,
                          ),
                        );
                      }}
                      onShare={() => {
                        void shareMichoPlay();
                      }}
                    />
                  ) : (
                    <MobileSettingsPage
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
                      onBack={() => {
                        setMobileTab("home");
                        if (history.index > 0) travel(-1);
                        else navigate({ section: "Home" });
                      }}
                      onKeepScreenAwake={setKeepScreenAwake}
                      onEqualizer={(onEqualizer) => {
                        setEqualizerBands(onEqualizer);
                        saveStoredData(
                          "equalizer-bands",
                          JSON.stringify(onEqualizer),
                        );
                        return api
                          .equalizer(onEqualizer, equalizerEnabled)
                          .catch((error) => setMessage(String(error)));
                      }}
                      onEqualizerPreview={(bands) =>
                        api
                          .equalizer(bands, equalizerEnabled)
                          .catch((error) => setMessage(String(error)))
                      }
                      onEqualizerToggle={(enabled) => {
                        setEqualizerEnabled(enabled);
                        saveStoredData(
                          "equalizer-enabled",
                          JSON.stringify(enabled),
                        );
                        void run(() => api.equalizer(equalizerBands, enabled));
                      }}
                      onCompact={setCompact}
                      onAdd={chooseLibrarySource}
                      onRemove={confirmRemoveFolder}
                      onRefresh={() => void refresh()}
                      onVolume={(volume) => {
                        saveStoredData("volume", JSON.stringify(volume));
                        void run(() => api.volume(volume));
                      }}
                      onSleepTimer={(minutes, atTrackEnd) =>
                        void run(() => api.sleepTimer(minutes, atTrackEnd))
                      }
                      onZoom={setZoomLevel}
                      onAbout={() => setMobileAboutOpen(true)}
                    />
                  )
                ) : isAndroid && mobileTab === "downloads" ? (
                  <MobileDownloadsScreen
                    downloads={youtubeDownloads}
                    clearable={clearableYoutubeDownloads}
                    onClear={() => void clearYoutubeDownloads()}
                    onControl={(id, action) =>
                      void controlYoutubeDownload(id, action)
                    }
                    onPlay={(item) => void playYoutubeDownload(item)}
                    onMenu={(item, event) =>
                      openDownloadedTrackMenu(item, event)
                    }
                    onOpenYoutube={openYoutubePage}
                  />
                ) : isAndroid && mobileTab === "search" ? (
                  <MobileSearchScreen
                    search={search}
                    onSearch={setSearch}
                    youtubeEnabled={globalYoutubeSearchEnabled}
                    youtubeSearching={globalYoutubeSearching}
                    youtubeResults={globalYoutubeResults}
                    youtubeLimit={globalYoutubeVisibleLimit}
                    youtubeHasMore={globalYoutubeHasMore}
                    youtubeLoadingMore={globalYoutubeLoadingMore}
                    youtubeError={globalYoutubeError}
                    onYoutubeDownload={(result, query, source) =>
                      requestYoutubeDownload(result, query, source)
                    }
                    onLoadMoreYoutube={() =>
                      void globalYoutubeSearch.loadMore()
                    }
                    searchResults={searchResults}
                    recentSearchResults={recentSearchResults}
                    onChooseResult={chooseSearchResult}
                    onResultMenu={openSearchResultMenu}
                    onLoadRecentSearch={(query) => setSearch(query)}
                    onClearRecentSearches={() => {
                      setRecentSearches([]);
                      saveStoredData("recent-searches", "[]");
                    }}
                    currentTrackId={player.currentTrackId}
                    isPlaying={player.isPlaying}
                  />
                ) : isAndroid && mobileTab === "library" ? (
                  <MobileLibraryScreen
                    favorites={favorites}
                    availableTracks={availableTracks}
                    playlists={playlists}
                    youtubePlaylist={youtubePlaylist}
                    trackMap={trackMap}
                    hiddenTrackSet={hiddenTrackSet}
                    onOpenFavorites={() => {
                      setMobileTab("home");
                      navigate({ section: "Favorites" });
                    }}
                    onOpenSongs={() => {
                      setMobileTab("home");
                      navigate({ section: "Songs" });
                    }}
                    onOpenPlaylist={(item) => {
                      setMobileTab("home");
                      openDetail("Playlists", "playlist", item);
                    }}
                  />
                ) : page.section === "Settings" ? (
                  <SettingsPage
                    roots={roots}
                    player={player}
                    equalizerBands={equalizerBands}
                    equalizerEnabled={equalizerEnabled}
                    compact={compact}
                    showPanel={showPanel}
                    keepScreenAwake={keepScreenAwake}
                    onKeepScreenAwake={setKeepScreenAwake}
                    globalYoutubeSearchEnabled={globalYoutubeSearchEnabled}
                    onGlobalYoutubeSearch={(enabled) => {
                      setGlobalYoutubeSearchEnabled(enabled);
                      saveStoredData(
                        "global-youtube-search-enabled",
                        JSON.stringify(enabled),
                      );
                    }}
                    scanning={scanning}
                    mobile={isAndroid}
                    zoomLevel={zoomLevel}
                    hiddenTracks={hiddenTracks}
                    onRestoreTrack={restoreTrack}
                    onZoom={setZoomLevel}
                    onEqualizer={(bands) => {
                      setEqualizerBands(bands);
                      saveStoredData("equalizer-bands", JSON.stringify(bands));
                      return api
                        .equalizer(bands, equalizerEnabled)
                        .catch((error) => setMessage(String(error)));
                    }}
                    onEqualizerPreview={(bands) =>
                      api
                        .equalizer(bands, equalizerEnabled)
                        .catch((error) => setMessage(String(error)))
                    }
                    onEqualizerToggle={(enabled) => {
                      setEqualizerEnabled(enabled);
                      saveStoredData(
                        "equalizer-enabled",
                        JSON.stringify(enabled),
                      );
                      void run(() => api.equalizer(equalizerBands, enabled));
                    }}
                    onCompact={setCompact}
                    onPanel={setShowPanel}
                    onAdd={chooseLibrarySource}
                    onRemove={confirmRemoveFolder}
                    onRefresh={() => void refresh()}
                    onVolume={(volume) => {
                      saveStoredData("volume", JSON.stringify(volume));
                      void run(() => api.volume(volume));
                    }}
                    onAutoplay={(enabled) => {
                      saveStoredData("autoplay", JSON.stringify(enabled));
                      void run(() => api.autoplay(enabled));
                    }}
                    onSleepTimer={(minutes, atTrackEnd) =>
                      void run(() => api.sleepTimer(minutes, atTrackEnd))
                    }
                    onDefaultPlayer={() =>
                      isAndroid
                        ? setMessage(
                            "Open an audio file from your file manager, choose MichoPlay, then tap Always to make it the default.",
                          )
                        : void run(() => api.setDefaultPlayer())
                    }
                  />
                ) : (
                  <>
                    <div
                      className={`collection-heading ${listPage ? "detail-heading" : ""}`}
                    >
                      {headingArt && listPage && (
                        <div
                          className="cover-backdrop"
                          style={{ backgroundImage: `url("${headingArt}")` }}
                        />
                      )}
                      {isAndroid && listPage && (
                        <button
                          className="mobile-detail-back"
                          aria-label="Back"
                          onClick={() => {
                            if (history.index > 0) travel(-1);
                            else navigate({ section: "Home" });
                          }}
                        >
                          <ChevronLeft size={24} />
                        </button>
                      )}
                      <div className="heading-foreground">
                        {listPage && (
                          <Cover
                            className="heading-cover"
                            keys={coverKeys(collectionTracks)}
                            icon={
                              isYoutubePlaylist ? (
                                <Youtube size={36} />
                              ) : page.detail?.kind === "folder" ? (
                                <FolderOpen size={40} />
                              ) : page.section === "Favorites" ? (
                                <Heart size={36} fill="currentColor" />
                              ) : (
                                <Music2 size={36} />
                              )
                            }
                          />
                        )}
                        <div className="heading-copy">
                          <h1>{heading}</h1>
                          <p>
                            {isYoutubePlaylist
                              ? "Download audio from YouTube by searching or pasting a link."
                              : listPage
                                ? `${collectionTracks.length} ${collectionTracks.length === 1 ? "Song" : "Songs"} · ${headingTime(collectionDurationMs)}`
                                : page.section === "Home"
                                  ? `${folders.length} music folders`
                                  : page.section === "Albums"
                                    ? `${albums.length} albums`
                                    : page.section === "Artists"
                                      ? `${artists.length} artists`
                                      : page.section === "Folders"
                                        ? `${folders.length} folders`
                                        : `${playlists.length} playlists`}
                          </p>
                          {page.detail?.kind === "playlist" &&
                            !isYoutubePlaylist &&
                            !isAndroid && (
                              <div className="playlist-heading-search">
                                <label className="search-box playlist-search-control">
                                  <Search size={16} />
                                  <input
                                    aria-label={`Search ${heading}`}
                                    placeholder={`Search ${heading}`}
                                    value={inlineSearch}
                                    onFocus={() => setPlaylistSearchOpen(true)}
                                    onChange={(event) => {
                                      setInlineSearch(event.target.value);
                                      setPlaylistSearchOpen(true);
                                    }}
                                  />
                                  {inlineSearch && (
                                    <button
                                      aria-label="Clear playlist search"
                                      onClick={() => {
                                        setInlineSearch("");
                                        setPlaylistSearchOpen(false);
                                      }}
                                    >
                                      <X size={13} />
                                    </button>
                                  )}
                                </label>
                                {playlistSearchOpen && inlineSearchTerm && (
                                  <div
                                    className="playlist-heading-search-menu"
                                    role="listbox"
                                    aria-label={`Songs matching ${inlineSearch}`}
                                  >
                                    {playlistSearchMatches.map((track) => (
                                      <button
                                        key={track.id}
                                        role="option"
                                        onMouseDown={(event) =>
                                          event.preventDefault()
                                        }
                                        onClick={() => {
                                          void playCollection(
                                            track,
                                            collectionTracks,
                                          );
                                          setPlaylistSearchOpen(false);
                                        }}
                                      >
                                        <Cover keys={[track.artworkKey]} />
                                        <span>
                                          <strong>{track.title}</strong>
                                          <small>
                                            {track.hasLyrics && (
                                              <LyricsBadge />
                                            )}
                                            {track.artist}
                                          </small>
                                        </span>
                                      </button>
                                    ))}
                                    {!playlistSearchMatches.length && (
                                      <p>No songs found.</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                        </div>
                      </div>
                    </div>
                    {listPage ? (
                      <>
                        {isYoutubePlaylist && (
                          <section
                            className="youtube-downloader"
                            aria-label="Search YouTube audio"
                          >
                            <div className="youtube-search-header">
                              <form
                                className="youtube-search-form"
                                onSubmit={(event) => event.preventDefault()}
                              >
                                {isAndroid ? (
                                  <label className="search-box youtube-global-search">
                                    <Search size={17} />
                                    <input
                                      type="text"
                                      aria-label="Search YouTube"
                                      placeholder="Song, artist, or paste a link"
                                      value={youtubeQuery}
                                      onChange={(event) =>
                                        setYoutubeQuery(event.target.value)
                                      }
                                    />
                                    {youtubeQuery && (
                                      <button
                                        type="button"
                                        aria-label="Clear YouTube search"
                                        onClick={() => setYoutubeQuery("")}
                                      >
                                        <X size={15} />
                                      </button>
                                    )}
                                  </label>
                                ) : (
                                  <BufferedYoutubeSearch
                                    value={youtubeQuery}
                                    onChange={setYoutubeQuery}
                                  />
                                )}
                              </form>
                            </div>
                            {youtubeSearching ? (
                              <div
                                className="youtube-search-grid is-loading"
                                aria-label="Loading YouTube results"
                              >
                                {Array.from({ length: 8 }, (_, index) => (
                                  <div
                                    className="youtube-result-skeleton"
                                    key={index}
                                  >
                                    <span />
                                    <div>
                                      <i />
                                      <i />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : youtubeSearchError ? (
                              <p className="youtube-search-empty" role="alert">
                                {youtubeSearchError}
                              </p>
                            ) : youtubeQuery.trim() && youtubeResults.length ? (
                              <>
                                <div
                                  className="youtube-results-scroll"
                                  role="region"
                                  aria-label="YouTube search results"
                                >
                                  <div className="youtube-search-grid">
                                    {youtubeResults
                                      .slice(0, youtubeVisibleLimit)
                                      .map((result) => (
                                        <article
                                          className="youtube-result-card"
                                          key={result.id}
                                        >
                                          <div className="youtube-result-preview">
                                            <span className="youtube-result-art">
                                              {result.thumbnail ? (
                                                <img
                                                  src={result.thumbnail}
                                                  alt=""
                                                  loading="lazy"
                                                  onError={(event) => {
                                                    event.currentTarget.hidden = true;
                                                  }}
                                                />
                                              ) : (
                                                <Youtube size={24} />
                                              )}
                                              <span className="youtube-result-duration">
                                                {result.durationSeconds === null
                                                  ? result.isPlaylist
                                                    ? "Playlist"
                                                    : "YouTube"
                                                  : durationLabel(
                                                      result.durationSeconds,
                                                    )}
                                              </span>
                                            </span>
                                            <span className="youtube-result-copy">
                                              <strong>{result.title}</strong>
                                              <small>
                                                {result.hasLyrics && (
                                                  <LyricsBadge />
                                                )}
                                                {result.isPlaylist
                                                  ? "Playlist · MP3 audio"
                                                  : `Video · ${youtubeResultSize(result)}`}
                                              </small>
                                            </span>
                                          </div>
                                          <button
                                            className="youtube-result-download"
                                            aria-label={`Download ${result.title}`}
                                            onClick={(event) =>
                                              requestYoutubeDownload(
                                                result,
                                                undefined,
                                                event.currentTarget.getBoundingClientRect(),
                                              )
                                            }
                                            disabled={
                                              globalYoutubeDownloadRequested.includes(
                                                result.url,
                                              ) ||
                                              youtubeDownloads.some(
                                                (download) =>
                                                  download.url === result.url &&
                                                  ![
                                                    "failed",
                                                    "cancelled",
                                                  ].includes(download.status),
                                              )
                                            }
                                          >
                                            <Download size={14} />
                                            <span>
                                              {globalYoutubeDownloadRequested.includes(
                                                result.url,
                                              ) ||
                                              youtubeDownloads.some(
                                                (download) =>
                                                  download.url === result.url &&
                                                  ![
                                                    "failed",
                                                    "cancelled",
                                                  ].includes(download.status),
                                              )
                                                ? "Queued"
                                                : "Download"}
                                            </span>
                                          </button>
                                        </article>
                                      ))}
                                  </div>
                                </div>
                                {youtubeHasMore && (
                                  <button
                                    className="youtube-load-more"
                                    disabled={youtubeLoadingMore}
                                    onClick={() =>
                                      void folderYoutubeSearch.loadMore()
                                    }
                                  >
                                    {youtubeLoadingMore
                                      ? "Loading YouTube results…"
                                      : "Load more"}
                                  </button>
                                )}
                              </>
                            ) : youtubeQuery.trim() ? (
                              <p className="youtube-search-empty">
                                No videos found. Try a different title or link.
                              </p>
                            ) : null}
                          </section>
                        )}
                        <div
                          className={`collection-tools ${playlistSearchOpen ? "mobile-collection-search-open" : ""}`}
                        >
                          <div className="play-actions">
                            <button
                              className={`primary-play ${collectionHasCurrent ? "is-playing" : ""}`}
                              aria-label={
                                collectionHasCurrent && player.isPlaying
                                  ? `Pause ${heading}`
                                  : `Play ${heading}`
                              }
                              disabled={!visibleTracks.length}
                              onClick={() => {
                                if (collectionHasCurrent) void run(api.toggle);
                                else if (sortedVisibleTracks[0])
                                  playCollection(sortedVisibleTracks[0]);
                              }}
                            >
                              {collectionHasCurrent && player.isPlaying ? (
                                <Pause size={20} fill="currentColor" />
                              ) : (
                                <Play size={20} fill="currentColor" />
                              )}
                            </button>
                            <button
                              className={`round-button shuffle-control ${player.shuffle ? "active" : ""}`}
                              aria-label="Shuffle"
                              disabled={!visibleTracks.length}
                              onClick={() => void run(api.shuffle)}
                            >
                              <Shuffle size={18} />
                            </button>
                            {listPage && !isYoutubePlaylist && (
                              <button
                                className="icon-button playlist-search-toggle"
                                aria-label={
                                  playlistSearchOpen
                                    ? "Hide playlist search"
                                    : "Search playlist"
                                }
                                aria-expanded={playlistSearchOpen}
                                onClick={() =>
                                  setPlaylistSearchOpen((open) => !open)
                                }
                              >
                                <Search size={18} />
                              </button>
                            )}
                          </div>
                          <div className="collection-tools-right">
                            <label className="collection-search">
                              <Search size={15} />
                              <input
                                aria-label={`Search in ${heading}`}
                                placeholder={`Search in ${heading}`}
                                value={inlineSearch}
                                onChange={(event) =>
                                  setInlineSearch(event.target.value)
                                }
                              />
                              {inlineSearch && (
                                <button
                                  className="icon-button"
                                  aria-label="Clear collection search"
                                  onClick={() => setInlineSearch("")}
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </label>
                            <div className="sort-control">
                              <button
                                className={`sort-trigger ${sortMenuOpen ? "open" : ""}`}
                                aria-label={`Sort by ${trackSortOptions.find((option) => option.key === sortBy)?.label}`}
                                aria-expanded={sortMenuOpen}
                                onClick={() => setSortMenuOpen((open) => !open)}
                              >
                                <span>
                                  {
                                    trackSortOptions.find(
                                      (option) => option.key === sortBy,
                                    )?.label
                                  }
                                </span>
                                <ListFilter size={15} />
                              </button>
                              {sortMenuOpen && (
                                <div className="sort-menu" role="menu">
                                  <strong className="sort-menu-heading">
                                    Sort by
                                  </strong>
                                  {trackSortOptions.map((option) => (
                                    <button
                                      key={option.key}
                                      role="menuitemradio"
                                      aria-checked={sortBy === option.key}
                                      className={`sort-menu-option ${sortBy === option.key ? "selected" : ""}`}
                                      onClick={() => {
                                        setSortBy(option.key);
                                        saveStoredData(
                                          "collection-sort",
                                          JSON.stringify(option.key),
                                        );
                                        setSortMenuOpen(false);
                                      }}
                                    >
                                      <span>{option.label}</span>
                                      {sortBy === option.key && (
                                        <Check size={15} />
                                      )}
                                    </button>
                                  ))}
                                  <span className="sort-menu-divider" />
                                  <strong className="sort-menu-heading">
                                    View as
                                  </strong>
                                  <button
                                    role="menuitemradio"
                                    aria-checked={!compact}
                                    className={`sort-menu-option view-option ${!compact ? "selected" : ""}`}
                                    onClick={() => {
                                      setCompact(false);
                                      setSortMenuOpen(false);
                                    }}
                                  >
                                    <List size={15} />
                                    <span>List</span>
                                    {!compact && <Check size={15} />}
                                  </button>
                                  <button
                                    role="menuitemradio"
                                    aria-checked={compact}
                                    className={`sort-menu-option view-option ${compact ? "selected" : ""}`}
                                    onClick={() => {
                                      setCompact(true);
                                      setSortMenuOpen(false);
                                    }}
                                  >
                                    <AlignJustify size={15} />
                                    <span>Compact</span>
                                    {compact && <Check size={15} />}
                                  </button>
                                </div>
                              )}
                            </div>
                            {selectedPlaylist &&
                              selectedPlaylist.name.toLocaleLowerCase() !==
                                "youtube" && (
                                <div className="playlist-actions-wrap">
                                  <button
                                    className="icon-button playlist-actions-trigger"
                                    aria-label="Playlist actions"
                                    aria-expanded={playlistActionsOpen}
                                    onClick={() =>
                                      setPlaylistActionsOpen((open) => !open)
                                    }
                                  >
                                    <MoreVertical size={20} />
                                  </button>
                                  {playlistActionsOpen && (
                                    <div
                                      className="action-menu playlist-actions-menu"
                                      role="menu"
                                    >
                                      <button
                                        role="menuitem"
                                        onClick={() => {
                                          setPlaylistActionsOpen(false);
                                          setAddSongsPlaylistId(
                                            selectedPlaylist.id,
                                          );
                                          setAddSongsSelected([]);
                                          setAddSongsSearch("");
                                          setAddSongsVisibleLimit(100);
                                        }}
                                      >
                                        <Plus size={15} />
                                        Add songs
                                      </button>
                                      <button
                                        role="menuitem"
                                        onClick={() => {
                                          setPlaylistActionsOpen(false);
                                          newPlaylist(
                                            undefined,
                                            selectedPlaylist,
                                          );
                                        }}
                                      >
                                        <Pencil size={15} />
                                        Rename playlist
                                      </button>
                                      <div className="menu-separator" />
                                      <button
                                        role="menuitem"
                                        onClick={() => {
                                          setPlaylistActionsOpen(false);
                                          confirmDeletePlaylist(
                                            selectedPlaylist,
                                          );
                                        }}
                                      >
                                        <Trash2 size={15} />
                                        Delete playlist
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                          </div>
                        </div>
                        {rows(
                          sortedVisibleTracks,
                          page.section === "Favorites"
                            ? "No favorites yet"
                            : page.section === "Recently Played"
                              ? "No listening history yet"
                              : "No songs here",
                        )}
                      </>
                    ) : page.section === "Home" ? (
                      <HomeScreen
                        albums={albums}
                        artists={artists}
                        availableTracks={availableTracks}
                        folders={folders}
                        isScanning={scanning}
                        navigate={(section) => {
                          navigate({ section });
                        }}
                        openYoutube={openYoutubePage}
                        chooseLibrarySource={chooseLibrarySource}
                        openFolder={(item) =>
                          openDetail("Home", "folder", item)
                        }
                        openAlbum={(item) =>
                          openDetail("Albums", "album", item)
                        }
                        openArtist={(item) =>
                          openDetail("Artists", "artist", item)
                        }
                      />
                    ) : page.section === "Albums" ? (
                      <CollectionGrid
                        collections={albums}
                        kind="album"
                        onOpen={(item) => openDetail("Albums", "album", item)}
                      />
                    ) : page.section === "Artists" ? (
                      <CollectionGrid
                        collections={artists}
                        kind="artist"
                        onOpen={(item) => openDetail("Artists", "artist", item)}
                      />
                    ) : page.section === "Folders" ? (
                      <div className="home-section">
                        <div className="section-title-row">
                          <h2>Folders</h2>
                          <button
                            className="outline-button"
                            disabled={scanning}
                            onClick={chooseLibrarySource}
                          >
                            <Plus size={15} />
                            Add folder
                          </button>
                        </div>
                        <CollectionGrid
                          collections={folders}
                          kind="folder"
                          onOpen={(item) => openDetail("Home", "folder", item)}
                          onPlay={playCardCollection}
                          isCurrentCollection={isCollectionCurrent}
                          playingId={player.currentTrackId}
                          isPlaying={player.isPlaying}
                        />
                        {!folders.length && (
                          <Empty
                            title={
                              scanning ? "Scanning music…" : "No folders yet"
                            }
                            description="Add a music folder to browse its songs."
                          />
                        )}
                      </div>
                    ) : (
                      <div className="home-section">
                        <div className="section-title-row">
                          <h2>Your playlists</h2>
                          <button
                            className="outline-button"
                            onClick={() => newPlaylist()}
                          >
                            <Plus size={15} />
                            Create playlist
                          </button>
                        </div>
                        <CollectionGrid
                          collections={playlists.map((item) => ({
                            key: item.id,
                            title: item.name,
                            subtitle: "",
                            tracks: item.trackIds.flatMap((id) =>
                              !hiddenTrackSet.has(id) && trackMap.get(id)
                                ? [trackMap.get(id)!]
                                : [],
                            ),
                          }))}
                          kind="playlist"
                          onOpen={(item) =>
                            openDetail("Playlists", "playlist", item)
                          }
                          onPlay={playCardCollection}
                          isCurrentCollection={isCollectionCurrent}
                          playingId={player.currentTrackId}
                          isPlaying={player.isPlaying}
                        />
                        {!playlists.length && (
                          <Empty
                            title="No playlists yet"
                            description="Create a playlist and add songs from their action menu."
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>
          {showPanel && (
            <>
              <div
                className="resize-handle panel-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize side panel"
                onPointerDown={(event) => startResize("panel", event)}
              />
              <aside
                className="now-panel"
                aria-label={
                  panelView === "downloads"
                    ? "Downloads"
                    : "Now playing and queue"
                }
              >
                <div className="now-panel-head">
                  <button
                    className="icon-button now-panel-close"
                    aria-label="Hide side panel"
                    title="Hide side panel"
                    onClick={() => setShowPanel(false)}
                  >
                    <PanelRightClose size={16} />
                  </button>
                  <div
                    className="side-panel-tabs"
                    role="tablist"
                    aria-label="Side panel"
                  >
                    <button
                      role="tab"
                      aria-selected={panelView === "now-playing"}
                      className={panelView === "now-playing" ? "selected" : ""}
                      onClick={() => setPanelView("now-playing")}
                    >
                      Now playing
                    </button>
                    <button
                      role="tab"
                      aria-selected={panelView === "downloads"}
                      className={panelView === "downloads" ? "selected" : ""}
                      onClick={() => setPanelView("downloads")}
                    >
                      Downloads
                      {youtubeDownloads.some(
                        (item) =>
                          item.status === "downloading" ||
                          item.status === "queued",
                      ) && (
                        <span className="download-tab-count">
                          {
                            youtubeDownloads.filter(
                              (item) =>
                                item.status === "downloading" ||
                                item.status === "queued",
                            ).length
                          }
                        </span>
                      )}
                    </button>
                  </div>
                  <div className="now-panel-tools">
                    {panelView === "now-playing" ? (
                      <button
                        className="icon-button"
                        aria-label="More options for current song"
                        title="More options"
                        disabled={!nowPlayingTrack}
                        onClick={(event) => {
                          if (nowPlayingTrack)
                            openTrackMenu(nowPlayingTrack, event);
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    ) : null}
                  </div>
                </div>
                {panelView === "downloads" ? (
                  <div className="download-manager" aria-live="polite">
                    <div className="download-manager-heading">
                      <strong>Your downloads</strong>
                      <span>
                        {
                          youtubeDownloads.filter(
                            (item) =>
                              item.status === "downloading" ||
                              item.status === "queued",
                          ).length
                        }{" "}
                        active
                      </span>
                      {clearableYoutubeDownloads && (
                        <button
                          className="download-clear-button"
                          onClick={() => void clearYoutubeDownloads()}
                        >
                          <Trash2 size={13} />
                          Clear
                        </button>
                      )}
                    </div>
                    {youtubeDownloads.length ? (
                      <>
                      <PlaylistDownloadProgress downloads={youtubeDownloads} onControl={(id, action) => void controlYoutubeDownload(id, action)} onPlay={(item) => void playYoutubeDownload(item)} onMenu={(item, event) => openDownloadedTrackMenu(item, event)} />
                      {youtubeDownloads.filter((item) => !item.playlist).map((item) => (
                        <article
                          className={`download-item status-${item.status}`}
                          key={item.id}
                        >
                          <div className="download-item-main">
                            <div className="download-item-art">
                              {item.thumbnail && (
                                <img
                                  src={item.thumbnail}
                                  alt=""
                                  loading="lazy"
                                  onError={(event) => {
                                    event.currentTarget.hidden = true;
                                  }}
                                />
                              )}
                              {item.status === "completed" && (
                                <button
                                  className="download-art-play"
                                  aria-label={`Play ${item.title}`}
                                  title="Play downloaded audio"
                                  onClick={() => void playYoutubeDownload(item)}
                                >
                                  <Play size={15} fill="currentColor" />
                                </button>
                              )}
                            </div>
                            <div className="download-item-copy">
                              <strong>{item.title}</strong>
                              {youtubeDownloadDescription(item) && (
                                <small>
                                  {youtubeDownloadDescription(item)}
                                </small>
                              )}
                            </div>
                          </div>
                          <div className="download-item-progress">
                            <span
                              className={
                                youtubeDownloadIsPending(item)
                                  ? "is-pending"
                                  : ""
                              }
                              style={{
                                width: `${youtubeDownloadProgress(item)}%`,
                              }}
                            />
                          </div>
                          <div className="download-item-actions">
                            <span
                              className={`download-status-label ${item.status}`}
                            >
                              {item.status === "completed" ? null : item.status}
                            </span>
                            {item.status === "completed" ? (
                              <button
                                className="icon-button download-menu-trigger"
                                aria-label={`More actions for ${item.title}`}
                                title={`More actions for ${item.title}`}
                                onClick={(event) =>
                                  openDownloadedTrackMenu(item, event)
                                }
                              >
                                <MoreVertical size={16} />
                              </button>
                            ) : (
                              <>
                                {item.status === "downloading" ||
                                item.status === "queued" ? (
                                  <button
                                    className="icon-button"
                                    aria-label={`Pause ${item.title}`}
                                    onClick={() =>
                                      void controlYoutubeDownload(
                                        item.id,
                                        "pause",
                                      )
                                    }
                                  >
                                    <Pause size={14} />
                                  </button>
                                ) : item.status === "paused" ||
                                  item.status === "failed" ? (
                                  <button
                                    className="icon-button"
                                    aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`}
                                    onClick={() =>
                                      void controlYoutubeDownload(
                                        item.id,
                                        "resume",
                                      )
                                    }
                                  >
                                    <Play size={14} />
                                  </button>
                                ) : null}
                                {["queued", "downloading", "paused"].includes(
                                  item.status,
                                ) ? (
                                  <button
                                    className="icon-button"
                                    aria-label={`Cancel ${item.title}`}
                                    onClick={() =>
                                      void controlYoutubeDownload(
                                        item.id,
                                        "cancel",
                                      )
                                    }
                                  >
                                    <X size={14} />
                                  </button>
                                ) : (
                                  <button
                                    className="icon-button"
                                    aria-label={`Remove ${item.title} from downloads`}
                                    onClick={() =>
                                      void controlYoutubeDownload(
                                        item.id,
                                        "remove",
                                      )
                                    }
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </article>
                      ))}
                      </>
                    ) : (
                      <div className="download-manager-empty">
                        <strong>No downloads yet</strong>
                        <span>Find a song in Search to add it here.</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {nowPlayingTrack ? (
                      <div
                        className={`now-track ${nowPlayingIsActive ? "is-active" : ""}`}
                      >
                        <Cover
                          className="now-cover"
                          keys={[nowPlayingTrack.artworkKey]}
                        />
                        <div className="now-title">
                          <div className="now-track-copy">
                            <strong>{nowPlayingTrack.title}</strong>
                            <span>
                              {nowPlayingTrack.hasLyrics && (
                                <LyricsBadge />
                              )}
                              {nowPlayingTrack.artist}
                            </span>
                          </div>
                          <button
                            className={`row-action visible ${favorites.includes(nowPlayingTrack.id) ? "selected" : ""}`}
                            aria-label="Toggle favorite"
                            onClick={() => toggleFavorite(nowPlayingTrack.id)}
                          >
                            <Heart
                              size={17}
                              fill={
                                favorites.includes(nowPlayingTrack.id)
                                  ? "currentColor"
                                  : "none"
                              }
                            />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="now-empty">
                        <span className="now-empty-icon">
                          <AudioLines size={23} />
                        </span>
                        <div className="now-empty-copy">
                          <strong>Ready when you are</strong>
                          <span>
                            Pick a song from your library to start listening.
                          </span>
                        </div>
                        <button
                          className="now-empty-action"
                          onClick={() => navigate({ section: "Songs" })}
                        >
                          <Music2 size={14} />
                          Browse songs
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                    <div className="queue-hint">
                      <ListMusic size={16} />
                      <span>Up next</span>
                      <span className="queue-empty">
                        {player.queue.length} songs
                      </span>
                    </div>
                    <div className="queue-list">
                      {visibleQueue.map((id, index) => {
                        const track = trackMap.get(id);
                        return track ? (
                          <div
                            key={id}
                            draggable
                            className={`queue-row ${draggedQueue === index ? "dragging" : ""} ${queueDrop === index ? "drop-target" : ""} ${player.priorityQueue.includes(id) ? "priority" : ""}`}
                            onDragStart={(event) => {
                              setDraggedQueue(index);
                              event.dataTransfer.setData(
                                "application/michoplay-queue",
                                String(index),
                              );
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(event) => {
                              if (draggedQueue !== null) {
                                event.preventDefault();
                                setQueueDrop(index);
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (
                                draggedQueue !== null &&
                                draggedQueue !== index
                              )
                                void run(() =>
                                  api.queueMove(draggedQueue, index),
                                );
                              setDraggedQueue(null);
                              setQueueDrop(null);
                            }}
                            onDragEnd={() => {
                              setDraggedQueue(null);
                              setQueueDrop(null);
                            }}
                          >
                            <GripVertical className="queue-grip" size={13} />
                            <button
                              className="queue-song"
                              onClick={() => void run(() => api.play(id))}
                            >
                              <Cover
                                className="queue-cover"
                                keys={[track.artworkKey]}
                              />
                              <span className="queue-song-copy">
                                <span className="queue-label queue-label-title">
                                  {track.title}
                                </span>
                                <span className="queue-label queue-label-artist">
                                  {track.hasLyrics && (
                                    <LyricsBadge />
                                  )}
                                  {track.artist}
                                </span>
                              </span>
                            </button>
                            <div className="queue-actions">
                              <button
                                className="icon-button"
                                aria-label={`Move ${track.title} up`}
                                disabled={index === 0}
                                onClick={() =>
                                  void run(() =>
                                    api.queueMove(index, index - 1),
                                  )
                                }
                              >
                                <ChevronUp size={13} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`Move ${track.title} down`}
                                disabled={index === player.queue.length - 1}
                                onClick={() =>
                                  void run(() =>
                                    api.queueMove(index, index + 1),
                                  )
                                }
                              >
                                <ChevronDown size={13} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`Remove ${track.title} from queue`}
                                onClick={() =>
                                  void run(() => api.queueRemove(index))
                                }
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>
                        ) : null;
                      })}
                    </div>
                    {!queueExpanded &&
                      player.queue.length > visibleQueue.length && (
                        <button
                          className="queue-expand-button"
                          onClick={() => setQueueExpanded(true)}
                        >
                          Show all {player.queue.length} queued songs
                        </button>
                      )}
                    {queueExpanded && player.queue.length > 80 && (
                      <button
                        className="queue-expand-button"
                        onClick={() => setQueueExpanded(false)}
                      >
                        Show fewer queued songs
                      </button>
                    )}
                    {!player.queue.length && (
                      <p className="queue-notice">
                        Add songs to the queue from their action menu.
                      </p>
                    )}
                  </>
                )}
              </aside>
            </>
          )}
        </div>
        <footer className="player-bar" aria-label="Playback controls">
          <div className="now-playing-mini">
            {footerTrack && (
              <Cover className="mini-cover" keys={[footerTrack.artworkKey]} />
            )}
            <div className="track-copy">
              <span className="track-title">
                {footerTrack?.title ?? "Nothing playing"}
              </span>
              <span className="track-artist">
                {footerTrack?.hasLyrics && (
                  <LyricsBadge />
                )}
                {footerTrack?.artist ?? ""}
              </span>
            </div>
            {footerTrack && (
              <button
                className={`row-action visible ${favorites.includes(footerTrack.id) ? "selected" : ""}`}
                aria-label="Toggle favorite"
                onClick={() => toggleFavorite(footerTrack.id)}
              >
                <Heart
                  size={15}
                  fill={
                    favorites.includes(footerTrack.id) ? "currentColor" : "none"
                  }
                />
              </button>
            )}
          </div>
          <div className="transport">
            <TransportControls
              layout="bar"
              player={player}
              disabled={!tracks.length}
              onShuffle={() => void run(api.shuffle)}
              onPrevious={() => void run(api.previous)}
              onToggle={() => void run(current ? api.toggle : footerTrack ? () => api.play(footerTrack.id) : api.toggle)}
              onNext={() => void run(api.next)}
              onRepeat={() => void run(api.repeat)}
            />
            <div className="seek-row">
              <span>{time(seekPreviewMs ?? player.positionMs)}</span>
              <input
                type="range"
                min="0"
                max={Math.max(1, player.durationMs)}
                value={Math.min(
                  seekPreviewMs ?? player.positionMs,
                  player.durationMs,
                )}
                style={
                  {
                    "--range-value": `${Math.min(100, player.durationMs ? ((seekPreviewMs ?? player.positionMs) / player.durationMs) * 100 : 0)}%`,
                  } as CSSProperties
                }
                aria-label="Seek"
                disabled={!current}
                onChange={(event) => previewSeek(Number(event.target.value))}
                onPointerUp={(event) =>
                  void commitSeek(Number(event.currentTarget.value))
                }
                onKeyUp={(event) =>
                  void commitSeek(Number(event.currentTarget.value))
                }
              />
              <span>{time(player.durationMs)}</span>
            </div>
          </div>
          <div className="player-options">
            <SleepTimerControl
              player={player}
              onSet={(minutes, atTrackEnd) =>
                void run(() => api.sleepTimer(minutes, atTrackEnd))
              }
              placement="bar"
            />
            <button
              className={`icon-button lyrics-trigger ${lyricsOpen ? "active" : ""}`}
              aria-label={lyricsOpen ? "Close lyrics" : "Open lyrics"}
              aria-pressed={lyricsOpen}
              title={lyricsOpen ? "Close lyrics" : "Lyrics"}
              disabled={!footerTrack?.hasLyrics}
              onClick={() => {
                const next = !lyricsOpen;
                setLyricsOpen(next);
                if (next) {
                  setPanelView("now-playing");
                  setShowPanel(true);
                }
              }}
            >
              <Mic2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label={
                showPanel ? "Hide now playing panel" : "Show now playing panel"
              }
              onClick={() => setShowPanel(!showPanel)}
            >
              {showPanel ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
            </button>
            <VolumeControl volume={player.volume} onChange={setVolume} onToggleMute={toggleMute} />
            <button
              className={`transport-button full-mode-trigger ${fullMode ? "active" : ""}`}
              aria-label={fullMode ? "Exit full mode" : "Open full mode"}
              title={fullMode ? "Exit full mode" : "Full mode"}
              onClick={toggleFullMode}
            >
              {fullMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
          </div>
        </footer>
        {((scanning && !scanNotificationDismissed) || message) && (
          <div className="app-notification-stack" aria-live="polite">
            {scanning && !scanNotificationDismissed && (
              <div className="app-notification-badge scanning" role="status">
                <span className="app-notification-spinner loading-indicator" />
                <span className="app-notification-copy">
                  {scanProgress?.phase ?? "Scanning music and artwork…"}
                  {scanProgress?.phase === "Finding audio files" &&
                  scanProgress.processed
                    ? ` · ${scanProgress.processed.toLocaleString()} found`
                    : scanProgress?.total
                      ? ` · ${scanProgress.processed.toLocaleString()} of ${scanProgress.total.toLocaleString()}`
                      : ""}
                </span>
                <button
                  className="app-notification-action"
                  onClick={() => void api.cancelScan().catch(() => {})}
                >
                  Cancel
                </button>
                <button
                  className="app-notification-dismiss"
                  aria-label="Dismiss scan notification"
                  onClick={() => setScanNotificationDismissed(true)}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {message && (
              <div className="app-notification-badge" role="status">
                <span className="app-notification-copy">
                  {message.includes("Refresh the folder") ? (
                    <>
                      {message.split("Refresh the folder")[0]}
                      <button
                        className="inline-link"
                        onClick={() => void refresh()}
                      >
                        Refresh the folder
                      </button>
                      {message.split("Refresh the folder")[1]}
                    </>
                  ) : (
                    message
                  )}
                </span>
                <button
                  className="app-notification-dismiss"
                  aria-label="Dismiss notification"
                  onClick={() => setMessage("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
        )}
        {fullMode && (
          <section className="full-player-mode" aria-label="Full mode player">
            <div className="full-mode-backdrop">
              {footerTrack && (
                <Cover
                  className="full-mode-blur"
                  keys={[footerTrack.artworkKey]}
                />
              )}
            </div>
            <header className="full-mode-top">
              <span>
                <AudioLines size={18} /> MichoPlay
              </span>
              <div className="full-mode-top-actions">
                <SleepTimerControl
                  player={player}
                  onSet={(minutes, atTrackEnd) =>
                    void run(() => api.sleepTimer(minutes, atTrackEnd))
                  }
                  placement="full-mode"
                />
                <button className="full-mode-exit" onClick={toggleFullMode}>
                  <Minimize2 size={17} />
                  Exit full mode
                </button>
              </div>
            </header>
            <div className="full-mode-layout">
              <div className="full-mode-main">
                {fullModeLyrics && footerTrack ? (
                  <div className="full-mode-lyrics-wrap">
                    <LyricsView
                      track={footerTrack}
                      text={lyricsText ?? ""}
                      positionMs={player.positionMs}
                      onSeek={(positionMs) =>
                        void run(() => api.seek(positionMs))
                      }
                    />
                  </div>
                ) : (
                  <div className="full-mode-art-wrap">
                    {footerTrack ? (
                      <Cover
                        className="full-mode-art"
                        keys={[footerTrack.artworkKey]}
                      />
                    ) : (
                      <div className="full-mode-art full-mode-art-empty">
                        <Music2 size={60} />
                      </div>
                    )}
                  </div>
                )}
                <div className="full-mode-song">
                  <div>
                    <strong>{footerTrack?.title ?? "Nothing playing"}</strong>
                    <span>
                      {footerTrack?.artist ?? "Choose a song from your library"}
                    </span>
                  </div>
                  {footerTrack && (
                    <button
                      className={`full-mode-favorite ${favorites.includes(footerTrack.id) ? "active" : ""}`}
                      aria-label={
                        favorites.includes(footerTrack.id)
                          ? "Remove from favorites"
                          : "Add to favorites"
                      }
                      onClick={() => toggleFavorite(footerTrack.id)}
                    >
                      <Heart
                        size={22}
                        fill={
                          favorites.includes(footerTrack.id)
                            ? "currentColor"
                            : "none"
                        }
                      />
                    </button>
                  )}
                </div>
                <div className="full-mode-controls">
                  <TransportControls
                    layout="full"
                    player={player}
                    onShuffle={() => void run(api.shuffle)}
                    onPrevious={() => void run(api.previous)}
                    onToggle={() => void run(current ? api.toggle : footerTrack ? () => api.play(footerTrack.id) : api.toggle)}
                    onNext={() => void run(api.next)}
                    onRepeat={() => void run(api.repeat)}
                    lyricsActive={fullModeLyrics}
                    onLyrics={() => setFullModeLyrics((open) => !open)}
                  />
                  <div className="full-mode-seek">
                    <span>{time(seekPreviewMs ?? player.positionMs)}</span>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(1, player.durationMs)}
                      value={Math.min(
                        seekPreviewMs ?? player.positionMs,
                        player.durationMs,
                      )}
                      style={
                        {
                          "--range-value": `${Math.min(100, player.durationMs ? ((seekPreviewMs ?? player.positionMs) / player.durationMs) * 100 : 0)}%`,
                        } as CSSProperties
                      }
                      aria-label="Seek"
                      disabled={!current}
                      onChange={(event) =>
                        previewSeek(Number(event.target.value))
                      }
                      onPointerUp={(event) =>
                        void commitSeek(Number(event.currentTarget.value))
                      }
                      onKeyUp={(event) =>
                        void commitSeek(Number(event.currentTarget.value))
                      }
                    />
                    <span>{time(player.durationMs)}</span>
                  </div>
                  <div className="full-mode-volume">
                    <VolumeControl volume={player.volume} onChange={setVolume} onToggleMute={toggleMute} />
                  </div>
                </div>
              </div>
              <aside className="full-mode-side">
                <div
                  className="full-mode-tabs"
                  role="tablist"
                  aria-label="Full mode side panel"
                >
                  <button
                    role="tab"
                    aria-selected={fullPanelTab === "queue"}
                    className={fullPanelTab === "queue" ? "active" : ""}
                    onClick={() => setFullPanelTab("queue")}
                  >
                    Queue
                  </button>
                  <button
                    role="tab"
                    aria-selected={fullPanelTab === "browse"}
                    className={fullPanelTab === "browse" ? "active" : ""}
                    onClick={() => setFullPanelTab("browse")}
                  >
                    Browse
                  </button>
                </div>
                {fullPanelTab === "queue" ? (
                  <div className="full-mode-list">
                    <h2>Now playing</h2>
                    {footerTrack && (
                      <button
                        className="full-mode-track current"
                        onClick={() => {
                          if (current) void run(api.toggle);
                        }}
                      >
                        <Cover
                          className="full-mode-track-cover"
                          keys={[footerTrack.artworkKey]}
                        />
                        <span>
                          <strong>{footerTrack.title}</strong>
                          <small>{footerTrack.artist}</small>
                        </span>
                      </button>
                    )}
                    <h2>Up next</h2>
                    {visibleQueue.map((id) => {
                      const track = trackMap.get(id);
                      return track ? (
                        <button
                          className="full-mode-track"
                          key={id}
                          onClick={() => void run(() => api.play(id))}
                        >
                          <Cover
                            className="full-mode-track-cover"
                            keys={[track.artworkKey]}
                          />
                          <span>
                            <strong>{track.title}</strong>
                            <small>
                              {track.hasLyrics && (
                                <LyricsBadge />
                              )}
                              {track.artist}
                            </small>
                          </span>
                        </button>
                      ) : null;
                    })}
                    {!player.queue.length && (
                      <p className="full-mode-empty">Nothing queued</p>
                    )}
                  </div>
                ) : (
                  <div className="full-mode-list full-mode-browse">
                    {fullBrowsePlaylistId ? (
                      <>
                        <button
                          className="full-mode-back"
                          onClick={() => setFullBrowsePlaylistId(null)}
                        >
                          <ChevronLeft size={14} />
                          <span>{fullBrowsePlaylist?.name ?? "Playlists"}</span>
                        </button>
                        {fullBrowsePlaylistTracks
                          .slice(0, fullBrowseVisibleLimit)
                          .map((track) => (
                            <button
                              className="full-mode-track"
                              key={track.id}
                              onClick={() =>
                                void run(() =>
                                  api.playCollection(
                                    fullBrowsePlaylistTracks.map(
                                      (item) => item.id,
                                    ),
                                    track.id,
                                  ),
                                )
                              }
                            >
                              <Cover
                                className="full-mode-track-cover"
                                keys={[track.artworkKey]}
                              />
                              <span>
                                <strong>{track.title}</strong>
                                <small>
                                  {track.hasLyrics && (
                                    <LyricsBadge />
                                  )}
                                  {track.artist}
                                </small>
                              </span>
                            </button>
                          ))}
                        {fullBrowsePlaylistTracks.length >
                          fullBrowseVisibleLimit && (
                          <button
                            className="queue-expand-button"
                            onClick={() =>
                              setFullBrowseVisibleLimit((prior) => prior + 100)
                            }
                          >
                            Show more songs (
                            {fullBrowsePlaylistTracks.length -
                              fullBrowseVisibleLimit}{" "}
                            remaining)
                          </button>
                        )}
                        {!fullBrowsePlaylistTracks.length && (
                          <p className="full-mode-empty">
                            This playlist has no songs yet.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <div
                          className="full-mode-browse-tabs"
                          role="tablist"
                          aria-label="Browse your music"
                        >
                          <button
                            role="tab"
                            aria-selected={fullBrowseTab === "playlists"}
                            className={
                              fullBrowseTab === "playlists" ? "active" : ""
                            }
                            onClick={() => setFullBrowseTab("playlists")}
                          >
                            Playlists
                          </button>
                          <button
                            role="tab"
                            aria-selected={fullBrowseTab === "library"}
                            className={
                              fullBrowseTab === "library" ? "active" : ""
                            }
                            onClick={() => setFullBrowseTab("library")}
                          >
                            Library
                          </button>
                        </div>
                        {fullBrowseTab === "playlists" ? (
                          <>
                            <h2>Your playlists</h2>
                            {playlists.map((playlist) => {
                              const playlistTracks = playlist.trackIds.flatMap(
                                (id) =>
                                  !hiddenTrackSet.has(id) && trackMap.get(id)
                                    ? [trackMap.get(id)!]
                                    : [],
                              );
                              return (
                                <button
                                  className="full-mode-track full-mode-playlist"
                                  key={playlist.id}
                                  onClick={() =>
                                    setFullBrowsePlaylistId(playlist.id)
                                  }
                                >
                                  <Cover
                                    className="full-mode-track-cover"
                                    keys={coverKeys(playlistTracks)}
                                    icon={<ListMusic size={18} />}
                                  />
                                  <span>
                                    <strong>{playlist.name}</strong>
                                    <small>
                                      {playlistTracks.length}{" "}
                                      {playlistTracks.length === 1
                                        ? "song"
                                        : "songs"}
                                    </small>
                                  </span>
                                  <ChevronRight
                                    className="full-mode-playlist-chevron"
                                    size={15}
                                  />
                                </button>
                              );
                            })}
                            {!playlists.length && (
                              <p className="full-mode-empty">
                                Your playlists will appear here.
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <h2>All songs</h2>
                            {availableTracks
                              .slice(0, fullBrowseVisibleLimit)
                              .map((track) => (
                                <button
                                  className="full-mode-track"
                                  key={track.id}
                                  onClick={() =>
                                    void run(() =>
                                      api.playCollection(
                                        availableTracks.map((item) => item.id),
                                        track.id,
                                      ),
                                    )
                                  }
                                >
                                  <Cover
                                    className="full-mode-track-cover"
                                    keys={[track.artworkKey]}
                                  />
                                  <span>
                                    <strong>{track.title}</strong>
                                    <small>
                                      {track.hasLyrics && (
                                        <LyricsBadge />
                                      )}
                                      {track.artist}
                                    </small>
                                  </span>
                                </button>
                              ))}
                            {availableTracks.length >
                              fullBrowseVisibleLimit && (
                              <button
                                className="queue-expand-button"
                                onClick={() =>
                                  setFullBrowseVisibleLimit(
                                    (prior) => prior + 100,
                                  )
                                }
                              >
                                Show more songs (
                                {availableTracks.length -
                                  fullBrowseVisibleLimit}{" "}
                                remaining)
                              </button>
                            )}
                            {!availableTracks.length && (
                              <p className="full-mode-empty">
                                Import songs to browse your library.
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </aside>
            </div>
          </section>
        )}
      </section>
      {isAndroid && !mobilePlayerOpen && (
        <>
          <div className="mobile-bottom-scrim" aria-hidden="true" />
          <div
            className={`mobile-mini-player ${page.section === "Settings" ? "settings-open" : ""}`}
          >
            <button
              className="mobile-mini-track"
              onClick={() => setMobilePlayerOpen(true)}
              disabled={!footerTrack}
            >
              {footerTrack && (
                <Cover
                  className="mobile-mini-cover"
                  keys={[footerTrack.artworkKey]}
                />
              )}
              <span>
                <strong>{footerTrack?.title ?? "Nothing playing"}</strong>
                <small>
                  {footerTrack?.hasLyrics && (
                    <LyricsBadge />
                  )}
                  {footerTrack?.artist ?? "Choose a song to start"}
                </small>
              </span>
            </button>
            {footerTrack && (
              <>
                <button
                  className={`mobile-mini-action ${favorites.includes(footerTrack.id) ? "selected" : ""}`}
                  aria-label={
                    favorites.includes(footerTrack.id)
                      ? "Remove from liked songs"
                      : "Add to liked songs"
                  }
                  onClick={() => toggleFavorite(footerTrack.id)}
                >
                  <Heart
                    size={19}
                    fill={
                      favorites.includes(footerTrack.id)
                        ? "currentColor"
                        : "none"
                    }
                  />
                </button>
                <button
                  className="mobile-mini-skip"
                  aria-label="Previous track"
                  onClick={() => void run(api.previous)}
                >
                  <SkipBack size={17} fill="currentColor" />
                </button>
                <button
                  className="mobile-mini-play"
                  aria-label={player.isPlaying ? "Pause" : "Play"}
                  onClick={() =>
                    void run(
                      current ? api.toggle : () => api.play(footerTrack.id),
                    )
                  }
                >
                  {player.isPlaying ? (
                    <Pause size={18} fill="currentColor" />
                  ) : (
                    <Play size={18} fill="currentColor" />
                  )}
                </button>
                <button
                  className="mobile-mini-skip"
                  aria-label="Next track"
                  onClick={() => void run(api.next)}
                >
                  <SkipForward size={17} fill="currentColor" />
                </button>
              </>
            )}
            <div
              className="mobile-mini-progress"
              role="progressbar"
              aria-label="Playback progress"
              aria-valuemin={0}
              aria-valuemax={player.durationMs || 0}
              aria-valuenow={Math.min(player.positionMs, player.durationMs)}
            >
              <span
                style={{
                  width: `${Math.min(100, player.durationMs ? (player.positionMs / player.durationMs) * 100 : 0)}%`,
                }}
              />
            </div>
          </div>
          <MobileNav
            mobileTab={mobileTab}
            section={page.section}
            downloadCount={mobileDownloadBadgeCount}
            downloadNavRef={downloadNavRef}
            onHome={() => {
              setMobileTab("home");
              if (page.section !== "Home" || page.detail) navigate({ section: "Home" });
            }}
            onLibrary={() => {
              setMobileTab("library");
              if (page.section !== "Home" || page.detail) navigate({ section: "Home" });
            }}
            onYoutube={openYoutubePage}
            onDownloads={openMobileDownloads}
            onSearch={() => { setMobileTab("search"); setSearch(""); }}
          />
          {downloadFeedback && (
            <>
              <span
                key={`flight-${downloadFeedback.key}`}
                className="mobile-download-flight"
                aria-hidden="true"
                style={
                  {
                    left: downloadFeedback.x,
                    top: downloadFeedback.y,
                    "--flight-end-x": `${downloadFeedback.targetX}px`,
                    "--flight-end-y": `${downloadFeedback.targetY}px`,
                  } as CSSProperties
                }
              >
                <Download size={18} />
              </span>
              <div
                key={`notice-${downloadFeedback.key}`}
                className="mobile-download-confirmation"
                role="status"
              >
                <Download size={16} />
                <span>{downloadFeedback.label}</span>
              </div>
            </>
          )}
        </>
      )}
      {isAndroid && mobilePlayerOpen && (
        <section className="mobile-player-screen" aria-label="Now playing">
          <header className="mobile-player-top">
            <button
              aria-label="Close player"
              onClick={() => setMobilePlayerOpen(false)}
            >
              <ChevronDown size={27} />
            </button>
            <div>
              <span className="mobile-player-brand-row">
                <img
                  className="mobile-player-app-logo"
                  src="/michoplay-logo.svg"
                  alt=""
                />
                <small>MichoPlay</small>
              </span>
            </div>
            <button
              aria-label="Track options"
              onClick={(event) =>
                footerTrack && openTrackMenu(footerTrack, event)
              }
            >
              <MoreVertical size={23} />
            </button>
          </header>
          {footerTrack ? (
            <>
              <div
                className={`mobile-player-art-swipe ${mobilePlayerLyricsOpen ? "showing-lyrics" : ""} ${mobileTrackIsDragging ? "is-dragging" : ""} ${mobileTrackSwipeOffset < 0 ? "swiping-next" : mobileTrackSwipeOffset > 0 ? "swiping-previous" : ""}`}
                style={
                  {
                    "--mobile-art-offset": `${mobileTrackSwipeOffset}px`,
                    "--mobile-art-rotation": `${mobileTrackSwipeOffset * 0.012}deg`,
                    "--mobile-art-opacity": `${Math.max(0.68, 1 - Math.abs(mobileTrackSwipeOffset) / 1000)}`,
                  } as CSSProperties
                }
                onPointerDown={
                  !mobilePlayerLyricsOpen
                    ? (event) => {
                        mobileTrackSwipeStartX.current = event.clientX;
                        mobileTrackSwipeMoved.current = false;
                        setMobileTrackIsDragging(true);
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }
                    : undefined
                }
                onPointerMove={
                  !mobilePlayerLyricsOpen
                    ? (event) => {
                        if (mobileTrackSwipeStartX.current !== null)
                          setMobileTrackSwipeOffset(
                            Math.max(
                              -220,
                              Math.min(
                                220,
                                event.clientX - mobileTrackSwipeStartX.current,
                              ),
                            ),
                          );
                      }
                    : undefined
                }
                onPointerUp={
                  !mobilePlayerLyricsOpen
                    ? (event) => {
                        const start = mobileTrackSwipeStartX.current;
                        mobileTrackSwipeStartX.current = null;
                        setMobileTrackIsDragging(false);
                        const delta = event.clientX - (start ?? event.clientX);
                        const commitThreshold = Math.max(
                          72,
                          event.currentTarget.clientWidth * 0.22,
                        );
                        setMobileTrackSwipeOffset(0);
                        if (start === null) return;
                        if (delta <= -commitThreshold) {
                          mobileTrackSwipeMoved.current = true;
                          void run(api.next);
                        } else if (delta >= commitThreshold) {
                          mobileTrackSwipeMoved.current = true;
                          void run(api.previous);
                        }
                      }
                    : undefined
                }
                onPointerCancel={() => {
                  mobileTrackSwipeStartX.current = null;
                  setMobileTrackIsDragging(false);
                  setMobileTrackSwipeOffset(0);
                }}
              >
                {!mobilePlayerLyricsOpen && (
                  <>
                    {mobileSwipeNextTrack && (
                      <div
                        className="mobile-player-swipe-preview mobile-player-swipe-preview-next"
                        aria-hidden="true"
                      >
                        <Cover
                          className="mobile-player-cover"
                          keys={[mobileSwipeNextTrack.artworkKey]}
                        />
                      </div>
                    )}
                    {mobileSwipePreviousTrack && (
                      <div
                        className="mobile-player-swipe-preview mobile-player-swipe-preview-previous"
                        aria-hidden="true"
                      >
                        <Cover
                          className="mobile-player-cover"
                          keys={[mobileSwipePreviousTrack.artworkKey]}
                        />
                      </div>
                    )}
                  </>
                )}
                {mobilePlayerLyricsOpen && footerTrack.hasLyrics ? (
                  <div className="mobile-player-inline-lyrics">
                    <LyricsView
                      track={footerTrack}
                      text={lyricsText ?? ""}
                      positionMs={player.positionMs}
                      expanded
                      onExpand={() => setMobileLyricsExpanded(true)}
                      onClose={() => setMobilePlayerLyricsOpen(false)}
                      onSeek={(positionMs) =>
                        void run(() => api.seek(positionMs))
                      }
                    />
                  </div>
                ) : (
                  <button
                    className="mobile-player-cover-button"
                    aria-label={
                      footerTrack.hasLyrics ? "Show lyrics" : "Album art"
                    }
                    onClick={() => {
                      if (mobileTrackSwipeMoved.current) {
                        mobileTrackSwipeMoved.current = false;
                        return;
                      }
                      if (footerTrack.hasLyrics)
                        setMobilePlayerLyricsOpen(true);
                    }}
                  >
                    <Cover
                      className="mobile-player-cover"
                      keys={[footerTrack.artworkKey]}
                    />
                  </button>
                )}
              </div>
              {footerTrack.hasLyrics && !mobilePlayerLyricsOpen && (
                <LyricsView
                  track={footerTrack}
                  text={lyricsText ?? ""}
                  positionMs={player.positionMs}
                  preview
                  onExpand={() => setMobilePlayerLyricsOpen(true)}
                />
              )}
              <div className="mobile-player-track">
                <div>
                  <strong>{footerTrack.title}</strong>
                  <span className="mobile-player-track-meta">
                    {footerTrack.hasLyrics && (
                      <LyricsBadge />
                    )}
                    <span>{footerTrack.artist}</span>
                  </span>
                </div>
                <button
                  className={
                    favorites.includes(footerTrack.id) ? "favorite" : ""
                  }
                  aria-label="Toggle favorite"
                  onClick={() => toggleFavorite(footerTrack.id)}
                >
                  <Heart
                    size={24}
                    fill={
                      favorites.includes(footerTrack.id)
                        ? "url(#michoplay-brand-gradient)"
                        : "none"
                    }
                  />
                </button>
              </div>
              <div className="mobile-seek">
                <input
                  type="range"
                  min="0"
                  max={Math.max(1, player.durationMs)}
                  value={Math.min(
                    seekPreviewMs ?? player.positionMs,
                    player.durationMs,
                  )}
                  style={
                    {
                      "--range-value": `${Math.min(100, player.durationMs ? ((seekPreviewMs ?? player.positionMs) / player.durationMs) * 100 : 0)}%`,
                    } as CSSProperties
                  }
                  aria-label="Seek"
                  disabled={!current}
                  onChange={(event) => previewSeek(Number(event.target.value))}
                  onPointerUp={(event) =>
                    void commitSeek(Number(event.currentTarget.value))
                  }
                  onKeyUp={(event) =>
                    void commitSeek(Number(event.currentTarget.value))
                  }
                />
                <div>
                  <span>{time(seekPreviewMs ?? player.positionMs)}</span>
                  <span>{time(player.durationMs)}</span>
                </div>
              </div>
              <div className="mobile-player-controls">
                <button
                  className={`shuffle-control ${player.shuffle ? "active" : ""}`}
                  aria-label="Shuffle"
                  onClick={() => void run(api.shuffle)}
                >
                  <Shuffle size={22} />
                </button>
                <button
                  aria-label="Previous track"
                  onClick={() => void run(api.previous)}
                >
                  <SkipBack size={27} fill="currentColor" />
                </button>
                <button
                  className="mobile-big-play"
                  aria-label={player.isPlaying ? "Pause" : "Play"}
                  onClick={() =>
                    void run(
                      current ? api.toggle : () => api.play(footerTrack.id),
                    )
                  }
                >
                  {player.isPlaying ? (
                    <Pause size={28} fill="currentColor" />
                  ) : (
                    <Play size={28} fill="currentColor" />
                  )}
                </button>
                <button
                  aria-label="Next track"
                  onClick={() => void run(api.next)}
                >
                  <SkipForward size={27} fill="currentColor" />
                </button>
                <button
                  className={`repeat-control ${player.repeatMode !== "off" ? "active" : ""}`}
                  aria-label={`Repeat ${player.repeatMode}`}
                  onClick={() => void run(api.repeat)}
                >
                  ↻
                  {player.repeatMode === "one" && (
                    <small className="repeat-one-badge">1</small>
                  )}
                </button>
              </div>
              <div
                className={`mobile-player-actions ${footerTrack.hasLyrics ? "has-lyrics" : ""}`}
              >
                <button
                  className={`mobile-player-timer ${player.sleepTimerRemainingMs !== null || player.sleepTimerAtTrackEnd ? "active" : ""}`}
                  aria-label={
                    player.sleepTimerRemainingMs !== null
                      ? `Sleep timer: ${sleepTimerLabel(player.sleepTimerRemainingMs)} remaining`
                      : player.sleepTimerAtTrackEnd
                        ? "Sleep timer: end of track"
                        : "Set sleep timer"
                  }
                  onClick={() => setMobileSleepTimerOpen(true)}
                >
                  <Timer size={22} />
                  {(player.sleepTimerRemainingMs !== null ||
                    player.sleepTimerAtTrackEnd) && (
                    <span>
                      {player.sleepTimerAtTrackEnd
                        ? "Track end"
                        : sleepTimerLabel(player.sleepTimerRemainingMs!)}
                    </span>
                  )}
                </button>
                {footerTrack.hasLyrics && (
                  <button
                    className="mobile-lyrics-trigger"
                    aria-label="Show lyrics"
                    title="Lyrics"
                    onClick={() => setMobilePlayerLyricsOpen(true)}
                  >
                    <Mic2 size={22} />
                  </button>
                )}
                <button
                  aria-label="Show queue"
                  onClick={() => setMobileQueueOpen(true)}
                >
                  <ListMusic size={22} />
                </button>
              </div>
            </>
          ) : (
            <div className="mobile-player-empty">
              <Music2 size={36} />
              <strong>Nothing playing</strong>
              <span>Choose a song from your library.</span>
              <button
                onClick={() => {
                  setMobilePlayerOpen(false);
                  setMobileTab("library");
                }}
              >
                Open library
              </button>
            </div>
          )}
        </section>
      )}
      {isAndroid && mobileLyricsExpanded && footerTrack?.hasLyrics && (
        <div className="mobile-lyrics-fullscreen">
          <Cover
            className="mobile-lyrics-screen-art"
            keys={[footerTrack.artworkKey]}
          />
          <header>
            <button
              aria-label="Close lyrics"
              title="Close lyrics"
              onClick={() => setMobileLyricsExpanded(false)}
            >
              <ChevronDown size={23} />
            </button>
            <span>
              <strong>{footerTrack.title}</strong>
              <small>{footerTrack.artist}</small>
            </span>
          </header>
          <LyricsView
            track={footerTrack}
            text={lyricsText ?? ""}
            positionMs={player.positionMs}
            expanded
            onSeek={(positionMs) => void run(() => api.seek(positionMs))}
          />
        </div>
      )}
      {isAndroid && mobileLibraryActionsOpen && (
        <div
          className="mobile-sheet-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget)
              setMobileLibraryActionsOpen(false);
          }}
        >
          <section
            className="mobile-library-action-sheet"
            style={mobileSheetStyle("library")}
            role="dialog"
            aria-modal="true"
            aria-label="Add to your library"
          >
            <div
              className="mobile-sheet-handle"
              onPointerDown={(event) => beginMobileSheetDrag(event, "library")}
              onPointerMove={(event) => moveMobileSheetDrag(event, "library")}
              onPointerUp={() =>
                finishMobileSheetDrag("library", () =>
                  setMobileLibraryActionsOpen(false),
                )
              }
              onPointerCancel={() => cancelMobileSheetDrag("library")}
            />
            <h2>Add to your library</h2>
            <button
              onClick={() => {
                setMobileLibraryActionsOpen(false);
                newPlaylist();
              }}
            >
              <ListMusic size={21} />
              <strong>Create playlist</strong>
              <ChevronRight size={18} />
            </button>
            <button
              onClick={() => {
                setMobileLibraryActionsOpen(false);
                void chooseAndroidAudioFiles();
              }}
            >
              <FolderOpen size={21} />
              <strong>Import music</strong>
              <ChevronRight size={18} />
            </button>
          </section>
        </div>
      )}
      {isAndroid && mobileQueueOpen && (
        <div
          className="mobile-sheet-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setMobileQueueOpen(false);
          }}
        >
          <section
            className="mobile-queue-sheet"
            style={mobileSheetStyle("queue")}
            role="dialog"
            aria-modal="true"
            aria-label="Playback queue"
          >
            <div
              className="mobile-sheet-handle"
              role="presentation"
              onPointerDown={(event) => beginMobileSheetDrag(event, "queue")}
              onPointerMove={(event) => moveMobileSheetDrag(event, "queue")}
              onPointerUp={() =>
                finishMobileSheetDrag("queue", () => setMobileQueueOpen(false))
              }
              onPointerCancel={() => cancelMobileSheetDrag("queue")}
            />
            <div className="mobile-queue-heading">
              <div>
                <h2>Queue</h2>
              </div>
              <div className="mobile-queue-heading-actions">
                <button
                  className="mobile-edit-queue"
                  onClick={() => setMobileQueueEditing((editing) => !editing)}
                >
                  {mobileQueueEditing ? "Done" : "Edit"}
                </button>
                <button
                  className="mobile-close-sheet"
                  aria-label="Close queue"
                  onClick={() => setMobileQueueOpen(false)}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            {footerTrack && (
              <div className="mobile-queue-current-sticky">
                <div className="mobile-queue-current">
                  <span className="mobile-queue-section-label">
                    Now playing
                  </span>
                  <div className="mobile-queue-row current">
                    <Cover
                      className="mobile-queue-cover"
                      keys={[footerTrack.artworkKey]}
                    />
                    <span>
                      <strong>{footerTrack.title}</strong>
                      <small>{footerTrack.artist}</small>
                    </span>
                    <button
                      className="mobile-queue-play"
                      aria-label="Play current song"
                      onClick={() =>
                        void run(
                          current ? api.toggle : () => api.play(footerTrack.id),
                        )
                      }
                    >
                      {player.isPlaying ? (
                        <Pause size={20} fill="currentColor" />
                      ) : (
                        <Play size={20} fill="currentColor" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="mobile-queue-next-divider" role="separator">
              <span>Next up</span>
            </div>
            <div className="mobile-queue-list" ref={mobileQueueListRef}>
              {visibleQueue.map((id, index) => {
                const track = trackMap.get(id);
                const reorder = mobileQueueReorder;
                const dragged = reorder?.from === index;
                const shifting =
                  reorder?.active &&
                  !dragged &&
                  (reorder.from < reorder.to
                    ? index > reorder.from && index <= reorder.to
                    : index >= reorder.to && index < reorder.from);
                const rowStyle = {
                  "--queue-drag-offset": dragged
                    ? `${reorder.offset}px`
                    : "0px",
                  "--queue-shift-y": shifting
                    ? `${reorder.from < reorder.to ? -60 : 60}px`
                    : "0px",
                } as CSSProperties;
                return track ? (
                  <div
                    className={`mobile-queue-row ${dragged ? "dragging" : ""} ${reorder?.to === index && reorder.from !== index ? "drop-target" : ""}`}
                    style={rowStyle}
                    data-queue-index={index}
                    key={id}
                  >
                    <button
                      className="mobile-queue-song"
                      onClick={() => void run(() => api.play(id))}
                    >
                      <Cover
                        className="mobile-queue-cover"
                        keys={[track.artworkKey]}
                      />
                      <span>
                        <strong>{track.title}</strong>
                        <small>
                          {track.hasLyrics && (
                            <LyricsBadge />
                          )}
                          {track.artist}
                        </small>
                      </span>
                    </button>
                    <div className="mobile-queue-order">
                      {mobileQueueEditing && (
                        <>
                          <button
                            aria-label={`Move ${track.title} up`}
                            disabled={index === 0}
                            onClick={() =>
                              void run(() => api.queueMove(index, index - 1))
                            }
                          >
                            <ChevronUp size={16} />
                          </button>
                          <button
                            aria-label={`Move ${track.title} down`}
                            disabled={index === player.queue.length - 1}
                            onClick={() =>
                              void run(() => api.queueMove(index, index + 1))
                            }
                          >
                            <ChevronDown size={16} />
                          </button>
                        </>
                      )}
                      <button
                        className="mobile-queue-drag-handle"
                        aria-label={`Long press and drag to reorder ${track.title}`}
                        onPointerDown={(event) =>
                          beginMobileQueueReorder(event, index)
                        }
                        onPointerMove={moveMobileQueueReorder}
                        onPointerUp={finishMobileQueueReorder}
                        onPointerCancel={cancelMobileQueueReorder}
                      >
                        <GripVertical size={18} />
                      </button>
                    </div>
                  </div>
                ) : null;
              })}
              {!queueExpanded && player.queue.length > visibleQueue.length && (
                <button
                  className="queue-expand-button"
                  onClick={() => setQueueExpanded(true)}
                >
                  Show all {player.queue.length} queued songs
                </button>
              )}
              {queueExpanded && player.queue.length > 80 && (
                <button
                  className="queue-expand-button"
                  onClick={() => setQueueExpanded(false)}
                >
                  Show fewer queued songs
                </button>
              )}
              {!footerTrack && !player.queue.length && (
                <p className="mobile-queue-empty">Your queue is empty.</p>
              )}
            </div>
            <div className="mobile-queue-tools">
              <button
                className={`shuffle-control ${player.shuffle ? "active" : ""}`}
                onClick={() => void run(api.shuffle)}
              >
                <Shuffle size={22} />
                <span>Shuffle</span>
              </button>
              <button
                className={`repeat-control ${player.repeatMode !== "off" ? "active" : ""}`}
                onClick={() => void run(api.repeat)}
              >
                <span className="repeat-symbol">
                  ↻
                  {player.repeatMode === "one" && (
                    <small className="repeat-one-badge">1</small>
                  )}
                </span>
                <span>Repeat</span>
              </button>
              <button
                className={`full-mode-control ${player.sleepTimerRemainingMs !== null || player.sleepTimerAtTrackEnd ? "active" : ""}`}
                onClick={() => setMobileSleepTimerOpen(true)}
              >
                <Timer size={22} />
                <span>
                  {player.sleepTimerRemainingMs !== null
                    ? sleepTimerLabel(player.sleepTimerRemainingMs)
                    : player.sleepTimerAtTrackEnd
                      ? "Track end"
                      : "Timer"}
                </span>
              </button>
            </div>
          </section>
        </div>
      )}
      {isAndroid && mobileSleepTimerOpen && (
        <div
          className="mobile-sheet-layer sleep-timer-sheet-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget)
              setMobileSleepTimerOpen(false);
          }}
        >
          <section
            className="mobile-sleep-timer-sheet"
            style={mobileSheetStyle("timer")}
            role="dialog"
            aria-modal="true"
            aria-label="Sleep timer"
          >
            <div
              className="mobile-sheet-handle"
              onPointerDown={(event) => beginMobileSheetDrag(event, "timer")}
              onPointerMove={(event) => moveMobileSheetDrag(event, "timer")}
              onPointerUp={() =>
                finishMobileSheetDrag("timer", () =>
                  setMobileSleepTimerOpen(false),
                )
              }
              onPointerCancel={() => cancelMobileSheetDrag("timer")}
            />
            <h2>Sleep timer</h2>
            {[
              [5, "5 minutes"],
              [10, "10 minutes"],
              [15, "15 minutes"],
              [30, "30 minutes"],
              [45, "45 minutes"],
              [60, "1 hour"],
            ].map(([minutes, label]) => (
              <button
                key={minutes}
                onClick={() => {
                  void run(() => api.sleepTimer(Number(minutes), false));
                  setMobileSleepTimerOpen(false);
                }}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => {
                void run(() => api.sleepTimer(null, true));
                setMobileSleepTimerOpen(false);
              }}
            >
              End of track
            </button>
            {(player.sleepTimerRemainingMs !== null ||
              player.sleepTimerAtTrackEnd) && (
              <button
                className="sleep-timer-cancel"
                onClick={() => {
                  void run(() => api.sleepTimer(null, false));
                  setMobileSleepTimerOpen(false);
                }}
              >
                Turn off timer
              </button>
            )}
          </section>
        </div>
      )}
      {menu &&
        createPortal(
          <>
            {isAndroid && (
              <button
                className="mobile-sheet-backdrop"
                aria-label="Close song actions"
                onClick={() => setMenu(null)}
              />
            )}
            <div
              ref={trackMenuRef}
              className={`action-menu track-menu ${isAndroid ? "mobile-action-sheet" : ""} ${submenuPlacement === "submenu-inline" ? "submenu-inline" : ""}`}
              role="menu"
              style={
                isAndroid
                  ? { ...mobileSheetStyle("actions"), left: 0, top: "auto" }
                  : { left: menu.x, top: menu.y }
              }
            >
              {isAndroid && (
                <div className="mobile-action-heading">
                  <div
                    className="mobile-sheet-handle"
                    role="presentation"
                    onPointerDown={(event) =>
                      beginMobileSheetDrag(event, "actions")
                    }
                    onPointerMove={(event) =>
                      moveMobileSheetDrag(event, "actions")
                    }
                    onPointerUp={() =>
                      finishMobileSheetDrag("actions", () => setMenu(null))
                    }
                    onPointerCancel={() => cancelMobileSheetDrag("actions")}
                  />
                  <div className="mobile-action-track">
                    <Cover
                      className="mobile-queue-cover"
                      keys={[menu.track.artworkKey]}
                    />
                    <span>
                      <strong>{menu.track.title}</strong>
                      <small>{menu.track.artist}</small>
                    </span>
                  </div>
                </div>
              )}
              <button
                role="menuitem"
                onClick={() => openMetadataEditor(menu.track)}
              >
                <Pencil size={15} />
                Edit metadata
              </button>
              <div
                className="playlist-menu-wrap"
                onMouseEnter={() => {
                  if (!isAndroid) setPlaylistSubmenu(true);
                }}
                onMouseLeave={() => {
                  if (!isAndroid) setPlaylistSubmenu(false);
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setPlaylistSubmenu(false);
                }}
              >
                <button
                  role="menuitem"
                  aria-expanded={playlistSubmenu}
                  onClick={() =>
                    setPlaylistSubmenu(isAndroid ? !playlistSubmenu : true)
                  }
                >
                  <Plus size={15} />
                  Add to playlist
                  <ChevronRight size={14} className="menu-arrow" />
                </button>
                {playlistSubmenu && (
                  <div
                    ref={playlistSubmenuRef}
                    className={`playlist-submenu ${submenuPlacement}`}
                  >
                    <label className="playlist-find">
                      <Search size={15} />
                      <input
                        autoFocus
                        placeholder="Find a playlist"
                        aria-label="Find a playlist"
                        value={playlistSearch}
                        onChange={(event) =>
                          setPlaylistSearch(event.target.value)
                        }
                      />
                    </label>
                    <button onClick={() => newPlaylist(menu.track)}>
                      <ListMusic size={15} />
                      New playlist
                    </button>
                    <div className="menu-separator" />
                    <div className="playlist-options">
                      {playlists
                        .filter((item) =>
                          item.name
                            .toLocaleLowerCase()
                            .includes(playlistSearch.toLocaleLowerCase()),
                        )
                        .map((item) => (
                          <button
                            key={item.id}
                            onClick={() => addToPlaylist(item, menu.track)}
                          >
                            <ListMusic size={15} />
                            {item.name}
                          </button>
                        ))}
                    </div>
                    {!playlists.length && (
                      <p>Create your first playlist above.</p>
                    )}
                  </div>
                )}
              </div>
              {selectedPlaylist && (
                <button
                  role="menuitem"
                  onClick={() =>
                    confirmRemovePlaylistTrack(selectedPlaylist, menu.track)
                  }
                >
                  <Trash2 size={15} />
                  Remove from playlist
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  toggleFavorite(menu.track.id);
                  setMenu(null);
                }}
              >
                <Heart size={15} />
                {favorites.includes(menu.track.id)
                  ? "Remove from favorites"
                  : "Save to favorites"}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  void run(() => api.queueAdd(menu.track.id));
                  setMenu(null);
                }}
              >
                <ListMusic size={15} />
                Add to queue
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  playCollection(menu.track);
                  setMenu(null);
                }}
              >
                <Play size={15} />
                Play now
              </button>
              <button role="menuitem" onClick={() => hideTrack(menu.track)}>
                <EyeOff size={15} />
                Hide song
              </button>
              <button
                className="action-danger"
                role="menuitem"
                onClick={() => {
                  if (isAndroid) {
                    setMenu(null);
                    void deleteAudioTrack(menu.track);
                  } else confirmDeleteAudioTrack(menu.track);
                }}
              >
                <Trash2 size={15} />
                Delete from device
              </button>
              <div className="menu-separator" />
              <button
                role="menuitem"
                onClick={() =>
                  navigate({
                    section: "Artists",
                    detail: {
                      kind: "artist",
                      key: menu.track.artist,
                      title: menu.track.artist,
                    },
                  })
                }
              >
                <AudioLines size={15} />
                Go to artist
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  navigate({
                    section: "Albums",
                    detail: {
                      kind: "album",
                      key: albumKey(menu.track),
                      title: menu.track.album,
                    },
                  })
                }
              >
                <Disc3 size={15} />
                Go to album
              </button>
            </div>
          </>,
          isAndroid ? (appFrameRef.current ?? document.body) : document.body,
        )}
      {updatePromptOpen && availableUpdate && (
        <div className="update-dialog-overlay">
          <section
            className="update-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-dialog-title"
            aria-describedby="update-dialog-description"
          >
            <header className="update-dialog-heading">
              <span className="update-dialog-title-copy">
                <h2 id="update-dialog-title">Update Available</h2>
                <p id="update-dialog-description">A new version is ready</p>
              </span>
            </header>
            <div
              className="update-version-comparison"
              aria-label={`Current version ${appVersion}; new version ${availableUpdate}`}
            >
              <div className="update-version-item">
                <span>Current</span>
                <strong>v{appVersion}</strong>
              </div>
              <ArrowRight size={20} aria-hidden="true" />
              <div className="update-version-item">
                <span>New</span>
                <strong>v{availableUpdate}</strong>
              </div>
            </div>
            <button
              className="update-install-button"
              onClick={openUpdateDownload}
            >
              <Download size={17} />
              Download
            </button>
            <button className="update-later-button" onClick={deferUpdatePrompt}>
              Later
            </button>
          </section>
        </div>
      )}
      {aboutOpen && (
        <div
          className="dialog-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAboutOpen(false);
          }}
        >
          <section
            className="about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
          >
            <div className="about-dialog-head">
              <span className="about-dialog-kicker">About</span>
              <button
                className="icon-button"
                aria-label="Close About"
                title="Close"
                onClick={() => setAboutOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="about-dialog-hero">
              <span className="about-mark">
                <AudioLines size={46} />
              </span>
              <h2 id="about-title">MichoPlay</h2>
              <span className="about-version-pill">Version {appVersion}</span>
              <div className="about-dialog-actions">
                <button onClick={() => openAboutUrl(michoplayGithubUrl)}>
                  <Github size={16} />
                  GitHub
                </button>
                <button onClick={() => openAboutUrl(michoplayIssueUrl)}>
                  <Bug size={16} />
                  Report issue
                </button>
              </div>
            </div>
            <section className="about-dialog-section">
              <h3>Links</h3>
              <div className="about-dialog-links">
                <button onClick={() => openAboutUrl(michoplayDeveloperUrl)}>
                  <Globe2 size={18} />
                  <span>Developer</span>
                  <ChevronRight size={17} />
                </button>
                <button onClick={() => openAboutUrl(michoplayWebsiteUrl)}>
                  <AudioLines size={18} />
                  <span>Website</span>
                  <ChevronRight size={17} />
                </button>
              </div>
            </section>
          </section>
        </div>
      )}
      {metadataTrack && (
        <div
          className={`dialog-overlay metadata-overlay ${isAndroid ? "metadata-sheet-layer" : ""}`}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !metadataSaving)
              setMetadataTrack(null);
          }}
        >
          <form
            className={`playlist-dialog metadata-dialog ${isAndroid ? "mobile-metadata-sheet" : ""}`}
            style={
              isAndroid
                ? ({
                    "--metadata-sheet-drag": `${metadataSheetDragY}px`,
                    transition: metadataSheetDragging ? "none" : undefined,
                  } as CSSProperties)
                : undefined
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="metadata-dialog-title"
            aria-busy={metadataSaving}
            onSubmit={(event) => {
              event.preventDefault();
              void saveMetadata();
            }}
          >
            {isAndroid && (
              <div
                className="metadata-sheet-handle"
                aria-hidden="true"
                onPointerDown={beginMetadataSheetDrag}
                onPointerMove={moveMetadataSheetDrag}
                onPointerUp={endMetadataSheetDrag}
                onPointerCancel={endMetadataSheetDrag}
              >
                <span />
              </div>
            )}
            <div className="dialog-title">
              <h2 id="metadata-dialog-title">Edit metadata</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close metadata editor"
                disabled={metadataSaving}
                onClick={() => setMetadataTrack(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Title
              <input
                autoFocus
                required
                maxLength={500}
                value={metadataDraft.title}
                onChange={(event) =>
                  setMetadataDraft((draft) => ({
                    ...draft,
                    title: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Artist
              <input
                required
                maxLength={500}
                value={metadataDraft.artist}
                onChange={(event) =>
                  setMetadataDraft((draft) => ({
                    ...draft,
                    artist: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Album
              <input
                required
                maxLength={500}
                value={metadataDraft.album}
                onChange={(event) =>
                  setMetadataDraft((draft) => ({
                    ...draft,
                    album: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Release date
              <input
                maxLength={500}
                placeholder="e.g. 2024 or 2024-05-12"
                value={metadataDraft.releaseDate}
                onChange={(event) =>
                  setMetadataDraft((draft) => ({
                    ...draft,
                    releaseDate: event.target.value,
                  }))
                }
              />
            </label>
            {metadataError && (
              <p className="metadata-error" role="alert">
                {metadataError}
              </p>
            )}
            <div className="metadata-actions">
              <button
                type="button"
                className="outline-button"
                disabled={metadataSaving}
                onClick={() => setMetadataTrack(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  metadataSaving ||
                  !metadataDraft.title.trim() ||
                  !metadataDraft.artist.trim() ||
                  !metadataDraft.album.trim()
                }
              >
                {metadataSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
      {dialog && (
        <div
          className="dialog-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setDialog(null);
          }}
        >
          <form
            className="playlist-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="playlist-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              savePlaylist();
            }}
          >
            <div className="dialog-title">
              <h2 id="playlist-dialog-title">
                {dialog.playlist ? "Rename playlist" : "Create playlist"}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close dialog"
                onClick={() => setDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Playlist name
              <input
                autoFocus
                required
                maxLength={120}
                value={playlistName}
                onChange={(event) => setPlaylistName(event.target.value)}
              />
            </label>
            {dialog.target && <p>“{dialog.target.title}” will be added.</p>}
            <button
              className="primary-button"
              type="submit"
              disabled={!playlistName.trim()}
            >
              {dialog.playlist ? "Save" : "Create playlist"}
            </button>
          </form>
        </div>
      )}
      {addSongsPlaylistId && (
        <div
          className="dialog-overlay add-songs-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget)
              setAddSongsPlaylistId(null);
          }}
        >
          <section
            className="add-songs-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-songs-title"
          >
            <div className="dialog-title">
              <h2 id="add-songs-title">Add songs</h2>
              <button
                className="icon-button"
                aria-label="Close song picker"
                onClick={() => setAddSongsPlaylistId(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="add-songs-description">
              Choose songs for{" "}
              <strong>
                {playlists.find((item) => item.id === addSongsPlaylistId)
                  ?.name ?? "your playlist"}
              </strong>
              .
            </p>
            <label className="add-songs-search">
              <Search size={17} />
              <input
                type="text"
                aria-label="Search songs to add"
                placeholder="Search songs or artists"
                value={addSongsSearch}
                onChange={(event) => {
                  setAddSongsSearch(event.target.value);
                  setAddSongsVisibleLimit(100);
                }}
              />
              {addSongsSearch && (
                <button
                  type="button"
                  aria-label="Clear song search"
                  onClick={() => {
                    setAddSongsSearch("");
                    setAddSongsVisibleLimit(100);
                  }}
                >
                  <X size={15} />
                </button>
              )}
            </label>
            <div className="add-songs-list">
              {addSongsVisibleTracks.map((track) => {
                const alreadyAdded = addSongsAlreadyAddedSet.has(track.id);
                const selected = addSongsSelectedSet.has(track.id);
                return (
                  <button
                    type="button"
                    className={`add-songs-row ${selected ? "selected" : ""} ${alreadyAdded ? "already-added" : ""}`}
                    key={track.id}
                    disabled={alreadyAdded}
                    aria-pressed={selected}
                    onClick={() =>
                      setAddSongsSelected((prior) =>
                        selected
                          ? prior.filter((id) => id !== track.id)
                          : [...prior, track.id],
                      )
                    }
                  >
                    <Cover
                      className="add-songs-cover"
                      keys={[track.artworkKey]}
                    />
                    <span className="add-songs-copy">
                      <strong>{track.title}</strong>
                      <small>
                        {track.hasLyrics && (
                          <LyricsBadge />
                        )}
                        {track.artist}
                      </small>
                    </span>
                    {alreadyAdded ? (
                      <span className="add-songs-added">Added</span>
                    ) : (
                      <span className="add-songs-check">
                        {selected ? <Check size={17} /> : <Plus size={17} />}
                      </span>
                    )}
                  </button>
                );
              })}
              {addSongsVisibleTracks.length < addSongsFilteredTracks.length && (
                <button
                  type="button"
                  className="text-action add-songs-more"
                  onClick={() =>
                    setAddSongsVisibleLimit((prior) => prior + 100)
                  }
                >
                  Show more songs (
                  {addSongsFilteredTracks.length - addSongsVisibleTracks.length}{" "}
                  remaining)
                </button>
              )}
              {!tracks.length && (
                <p className="add-songs-empty">
                  Import music before adding songs to a playlist.
                </p>
              )}
              {!!tracks.length && !addSongsFilteredTracks.length && (
                <p className="add-songs-empty">
                  No songs match “{addSongsSearch}”. Try another title or
                  artist.
                </p>
              )}
            </div>
            <div className="add-songs-footer">
              <span className="add-songs-selected-count">
                {addSongsSelected.length} selected
              </span>
              <button
                type="button"
                className="primary-button add-songs-submit"
                disabled={!addSongsSelected.length}
                onClick={() => {
                  const ids = addSongsSelected;
                  setPlaylists((prior) =>
                    prior.map((item) =>
                      item.id === addSongsPlaylistId
                        ? {
                            ...item,
                            trackIds: [
                              ...item.trackIds,
                              ...ids.filter(
                                (id) => !item.trackIds.includes(id),
                              ),
                            ],
                          }
                        : item,
                    ),
                  );
                  setAddSongsPlaylistId(null);
                  setMessage(
                    `Added ${ids.length} ${ids.length === 1 ? "song" : "songs"} to playlist.`,
                  );
                }}
              >
                {addSongsSelected.length
                  ? `Add ${addSongsSelected.length} ${addSongsSelected.length === 1 ? "song" : "songs"}`
                  : "Add songs"}
              </button>
            </div>
          </section>
        </div>
      )}
      {playlistSelection && <PlaylistSelection playlist={playlistSelection} onClose={() => setPlaylistSelection(null)} onConfirm={(songs) => void queueSelectedPlaylistSongs(songs)} />}
      {confirmation && (
        <div
          className="dialog-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !confirmationBusy)
              setConfirmation(null);
          }}
        >
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={
              confirmationError
                ? "confirm-message confirm-error"
                : "confirm-message"
            }
            aria-busy={confirmationBusy}
          >
            <div className="dialog-title">
              <h2 id="confirm-title">{confirmation.title}</h2>
              <button
                className="icon-button"
                aria-label="Cancel"
                disabled={confirmationBusy}
                onClick={() => setConfirmation(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p id="confirm-message">{confirmation.message}</p>
            {confirmationError && (
              <p id="confirm-error" className="confirm-error" role="alert">
                {confirmationError}
              </p>
            )}
            <div className="confirm-actions">
              <button
                className="outline-button"
                disabled={confirmationBusy}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={confirmationBusy}
                onClick={() => void completeConfirmation()}
              >
                {confirmationBusy ? "Working…" : confirmation.label}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
