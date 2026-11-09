import { Heart, Home, ListMusic, Music2 } from "lucide-react";
import type { PlayerSnapshot, Track, YoutubeDownload, YoutubeSearchResult } from "../lib/api";
import { stored } from "../lib/storage";
import { youtubeResultSizeText } from "../lib/youtube-size";
import type { Section } from "./types";

export function playlistSubmenuPlacement(menuX: number) {
  const menuWidth = 228;
  const submenuWidth = 256;
  const gap = 5;
  const edge = 8;
  if (menuX + menuWidth + gap + submenuWidth <= window.innerWidth - edge)
    return "opens-right";
  if (menuX - gap - submenuWidth >= edge) return "";
  return "submenu-inline";
}
export const latestReleaseApiUrl =
  "https://api.github.com/repos/namz182/michoplay/releases/latest";
export const michoplayGithubUrl = "https://github.com/namz182/michoplay";
export const michoplayIssueUrl = "https://github.com/namz182/michoplay/issues/new";
export const michoplayDeveloperUrl = "https://mainza.dev";
export const michoplayWebsiteUrl = "https://michoplay.mainza.dev/";
export const youtubeSearchPageSize = 15;
export const youtubeGlobalInitialResultLimit = youtubeSearchPageSize;
export const youtubeFolderInitialResultLimit = youtubeSearchPageSize;
export function isNewerVersion(candidate: string, current: string) {
  const parts = (version: string) => {
    const normalized = version.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
    if (!/^\d+(\.\d+)*$/.test(normalized)) return null;
    return normalized.split(".").map(Number);
  };
  const latest = parts(candidate);
  const installed = parts(current);
  if (!latest || !installed) return false;
  for (
    let index = 0;
    index < Math.max(latest.length, installed.length);
    index += 1
  ) {
    const difference = (latest[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
export const navigation: { label: Section; icon: typeof Home }[] = [
  { label: "Home", icon: Home },
  { label: "Songs", icon: Music2 },
  { label: "Playlists", icon: ListMusic },
  { label: "Favorites", icon: Heart },
];
export function defaultVolume() {
  const mobile =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
  return mobile ? 1 : 0.75;
}
export const initialPlayer: PlayerSnapshot = {
  currentTrackId: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  volume: defaultVolume(),
  shuffle: false,
  repeatMode: "off",
  queue: [],
  priorityQueue: [],
  autoplay: true,
  sleepTimerRemainingMs: null,
  sleepTimerAtTrackEnd: false,
  equalizerBands: Array(6).fill(0),
  equalizerEnabled: false,
};
export function storedLibraryRoots(): string[] {
  const roots = stored<unknown>("library-roots", []);
  return Array.isArray(roots)
    ? roots.filter(
        (root): root is string =>
          typeof root === "string" && !root.startsWith("content://"),
      )
    : [];
}
export function time(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function headingTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h${minutes ? ` ${minutes}min` : ""}`;
  if (minutes) return `${minutes}min`;
  return `${seconds}s`;
}
export function durationLabel(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
export function normalizedAudioPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/\/\?\//, "");
  return /^[a-z]:\//i.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized;
}
export function tracksForDownload(
  item: YoutubeDownload,
  tracks: Track[],
  youtubeDirectory: string,
) {
  if (item.filePaths?.length) {
    const byPath = new Map(
      tracks.map((track) => [normalizedAudioPath(track.path), track]),
    );
    const seen = new Set<number>();
    return item.filePaths.flatMap((path) => {
      const track = byPath.get(normalizedAudioPath(path));
      if (!track || seen.has(track.id)) return [];
      seen.add(track.id);
      return [track];
    });
  }
  if (item.isPlaylist) return [];
  const candidates = tracks.filter(
    (track) =>
      normalizedAudioPath(track.rootPath) ===
      normalizedAudioPath(youtubeDirectory),
  );
  const title = item.title.trim().toLocaleLowerCase();
  const match =
    candidates.find(
      (track) =>
        normalizedAudioPath(track.path)
          .split("/")
          .pop()
          ?.replace(/\.mp3$/i, "")
          .trim()
          .toLocaleLowerCase() === title,
    ) ??
    candidates.find(
      (track) => track.title.trim().toLocaleLowerCase() === title,
    );
  return match ? [match] : [];
}
export function isFinishedYoutubeDownload(item: YoutubeDownload) {
  return (
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "cancelled"
  );
}
export function sameYoutubeDownloads(
  current: YoutubeDownload[],
  next: YoutubeDownload[],
) {
  return (
    current.length === next.length &&
    current.every((item, index) => {
      const other = next[index];
      return (
        item.id === other.id &&
        item.title === other.title &&
        item.url === other.url &&
        item.thumbnail === other.thumbnail &&
        item.isPlaylist === other.isPlaylist &&
        item.playlist?.id === other.playlist?.id &&
        item.playlist?.title === other.playlist?.title &&
        item.playlist?.index === other.playlist?.index &&
        item.playlist?.total === other.playlist?.total &&
        item.status === other.status &&
        item.percent === other.percent &&
        item.downloadedBytes === other.downloadedBytes &&
        item.totalBytes === other.totalBytes &&
        item.totalBytesEstimated === other.totalBytesEstimated &&
        item.speedBytesPerSecond === other.speedBytesPerSecond &&
        item.etaSeconds === other.etaSeconds &&
        item.phase === other.phase &&
        item.message === other.message &&
        item.filePaths?.length === other.filePaths?.length &&
        (item.filePaths ?? []).every(
          (path, pathIndex) => path === other.filePaths?.[pathIndex],
        )
      );
    })
  );
}
export function youtubeResultSize(result: YoutubeSearchResult) {
  return youtubeResultSizeText(result.durationSeconds, result.isPlaylist);
}
export function normalizeZoom(value: number) {
  return Math.max(70, Math.min(130, Math.round(value / 10) * 10));
}
export function initialZoomLevel() {
  const android = /android/i.test(navigator.userAgent);
  const saved = stored<number | null>("zoom-level", null);
  const userSelected =
    localStorage.getItem("michoplay-zoom-level-customized") === "true";
  // Older builds persisted the implicit 100% default, so migrate that value once
  // on Android while preserving any zoom preference saved by the user.
  if (android && !userSelected && (saved === null || saved === 100)) return 120;
  return normalizeZoom(saved ?? (android ? 120 : 100));
}
export function albumKey(track: Track) {
  return `${track.album}\u0000${track.artist}`;
}
export const coverKeys = (tracks: Track[]) => tracks.map((track) => track.artworkKey);
export function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      resolve(comma < 0 ? value : value.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

