import type { Track } from "../lib/api";

export type Section =
  | "Home"
  | "Songs"
  | "Albums"
  | "Artists"
  | "Playlists"
  | "Folders"
  | "Favorites"
  | "Recently Played"
  | "Settings";
export type Detail = {
  kind: "folder" | "album" | "artist" | "playlist";
  key: string;
  title: string;
};
export type Page = { section: Section; detail?: Detail };
export type Playlist = { id: string; name: string; trackIds: number[] };
export type Collection = {
  key: string;
  title: string;
  subtitle: string;
  tracks: Track[];
};
export type TrackMenu = { track: Track; x: number; y: number };
export type DownloadFeedback = {
  key: number;
  label: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
};
export type ListeningRecord = {
  trackId: number;
  lastPlayedAt: number;
  playCount: number;
  positionMs: number;
  durationMs: number;
};
export type SavedPlaybackSession = {
  currentTrackId: number | null;
  queue: number[];
  positionMs: number;
  isPlaying: boolean;
};
export type GlobalSearchResult = {
  type: "Song" | "Folder" | "Album" | "Artist" | "Playlist";
  title: string;
  subtitle: string;
  artworkKey: string | null;
  trackId?: number;
  hasLyrics?: boolean;
  page?: Page;
};
export type TrackSort =
  | "titleAsc"
  | "titleDesc"
  | "recentlyAdded"
  | "durationAsc"
  | "durationDesc";
export const trackSortOptions: { key: TrackSort; label: string }[] = [
  { key: "titleAsc", label: "Title A–Z" },
  { key: "titleDesc", label: "Title Z–A" },
  { key: "recentlyAdded", label: "Recently added" },
  { key: "durationAsc", label: "Duration (short to long)" },
  { key: "durationDesc", label: "Duration (long to short)" },
];
