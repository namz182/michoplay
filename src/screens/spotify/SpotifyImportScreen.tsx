import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ChevronLeft, Disc3, Music2, X } from "lucide-react";
import { Cover } from "../../app/Artwork";
import {
  api,
  type SpotifyPublicMetadata,
  type SpotifySong,
  type SpotifySongsPage,
  type Track,
  type YoutubeDownload,
  type YoutubeDownloadPlaylist,
  type YoutubeSearchResult,
} from "../../lib/api";

import {
  cleanDownloadMetadata,
  createDownloadBatch,
} from "../../lib/downloads";
import { fetchSpotifyPreview } from "../../lib/spotify-preview";

type ImportKind = "track" | "album" | "playlist";
type SpotifyLink = { kind: ImportKind; id: string; url: string };
type PlaylistSong = SpotifySong & { key: string };
type SongStatus = {
  kind: "searching" | "not-found" | "error" | "library" | "duplicate";
  message?: string;
};

type Props = {
  mobile?: boolean;
  onBack?: () => void;
  libraryTracks: Track[];
  downloads: YoutubeDownload[];
  downloadConcurrency: number;
  onQueue: (
    candidate: YoutubeSearchResult,
    playlist?: YoutubeDownloadPlaylist,
  ) => Promise<boolean>;
  onDownloadControl: (
    id: string,
    action: "pause" | "resume" | "cancel" | "remove",
  ) => void;
};

export function parseSpotifyLink(value: string): SpotifyLink | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.spotify.com" ||
      url.username ||
      url.password
    )
      return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("intl-")) parts.shift();
    if (parts.length !== 2) return null;
    const kind = parts[0] as ImportKind;
    if (
      !(kind === "track" || kind === "album" || kind === "playlist") ||
      !/^[A-Za-z0-9]{22}$/.test(parts[1])
    )
      return null;
    return {
      kind,
      id: parts[1],
      url: `https://open.spotify.com/${kind}/${parts[1]}`,
    };
  } catch {
    return null;
  }
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const youtubeTitleNoise = new Set([
  "official",
  "audio",
  "video",
  "lyrics",
  "lyric",
  "visualizer",
  "provided",
  "vevo",
  "hd",
  "hq",
  "4k",
  "music",
]);
const matchingStopWords = new Set(["a", "an", "and", "the", "of", "to"]);

function matchWords(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((word) => word && !matchingStopWords.has(word));
}

function matchYoutubeSong(song: SpotifySong, results: YoutubeSearchResult[]) {
  const titleWords = matchWords(song.title);
  const artistWords = matchWords(song.artist ?? "");
  if (!titleWords.length) return undefined;
  const wantedTitle = new Set(titleWords);
  const artistOnlyWords = new Set(
    artistWords.filter((word) => !wantedTitle.has(word)),
  );

  const ranked = results
    .filter((result) => !result.isPlaylist)
    .map((result) => {
      const candidateTitleWords = matchWords(result.title).filter(
        (word) =>
          (!youtubeTitleNoise.has(word) || wantedTitle.has(word)) &&
          !artistOnlyWords.has(word),
      );
      const candidateTitle = new Set(candidateTitleWords);
      const titleHits = titleWords.filter((word) =>
        candidateTitle.has(word),
      ).length;
      const titleCoverage = titleHits / titleWords.length;
      const titlePrecision =
        titleHits / Math.max(candidateTitleWords.length, 1);
      const candidateIdentity = new Set(
        matchWords(`${result.title} ${result.artist ?? ""}`),
      );
      const artistHits = artistWords.filter((word) =>
        candidateIdentity.has(word),
      ).length;
      const artistCoverage = artistWords.length
        ? artistHits / artistWords.length
        : 1;
      let score =
        titleCoverage * 0.78 +
        artistCoverage * 0.17 +
        Math.min(titlePrecision, 1) * 0.05;

      let durationIsPlausible = true;
      if (song.durationSeconds != null && result.durationSeconds != null) {
        const durationDifference = Math.abs(
          song.durationSeconds - result.durationSeconds,
        );
        if (durationDifference <= 12) score += 0.05;
        else if (durationDifference > 30)
          score -= Math.min(0.2, (durationDifference - 30) / 180);
        durationIsPlausible =
          durationDifference <= Math.max(60, song.durationSeconds * 0.25);
      }

      const hasArtistEvidence =
        artistWords.length === 0 ||
        artistCoverage >= (artistWords.length === 1 ? 1 : 0.34);
      const confident =
        titleCoverage >= 0.8 &&
        hasArtistEvidence &&
        durationIsPlausible &&
        score >= 0.74;
      return { result, score, confident };
    })
    .sort((left, right) => right.score - left.score);

  return ranked.find((match) => match.confident)?.result;
}

function formatDuration(seconds?: number | null) {
  if (!Number.isFinite(seconds) || seconds == null || seconds < 0) return "—";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function matchesLibrary(song: SpotifySong, libraryTracks: Track[]) {
  const title = normalizeText(
    cleanDownloadMetadata(song.title, song.artist, true).title,
  );
  const artist = normalizeText(song.artist);
  return (
    Boolean(title) &&
    libraryTracks.some(
      (track) =>
        normalizeText(track.title) === title &&
        (!artist || normalizeText(track.artist) === artist),
    )
  );
}

function songQuery(song: SpotifySong) {
  return [song.title, song.artist].filter(Boolean).join(" ").slice(0, 190);
}

export function SpotifyImportScreen({
  mobile = false,
  onBack,
  libraryTracks,
  downloads,
  downloadConcurrency,
  onQueue,
  onDownloadControl,
}: Props) {
  const [url, setUrl] = useState("");
  const [loadedUrl, setLoadedUrl] = useState("");
  const [metadata, setMetadata] = useState<SpotifyPublicMetadata | null>(null);
  const [songs, setSongs] = useState<PlaylistSong[]>([]);
  const [hasMoreSongs, setHasMoreSongs] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statuses, setStatuses] = useState<Map<string, SongStatus>>(
    () => new Map(),
  );
  const [resolvedMatches, setResolvedMatches] = useState<
    Map<string, YoutubeSearchResult>
  >(() => new Map());
  const requestId = useRef(0);
  const previewRequest = useRef<AbortController | null>(null);
  const processing = useRef(new Set<string>());
  const claimedMatches = useRef(new Map<string, string>());

  useEffect(() => () => {
    requestId.current += 1;
    previewRequest.current?.abort();
  }, []);

  const downloadsByUrl = useMemo(() => {
    const byUrl = new Map<string, YoutubeDownload>();
    for (const item of downloads)
      if (!byUrl.has(item.url)) byUrl.set(item.url, item);
    return byUrl;
  }, [downloads]);

  const selectedSongs = useMemo(
    () => songs.filter((song) => selected.has(song.key)),
    [songs, selected],
  );
  const allSelected = songs.length > 0 && selectedSongs.length === songs.length;

  async function fetchLink(input: string) {
    previewRequest.current?.abort();
    const parsed = parseSpotifyLink(input);
    const thisRequest = ++requestId.current;
    if (!parsed) {
      setError(
        "Paste a Spotify song, album, or playlist link from open.spotify.com.",
      );
      setMetadata(null);
      setSongs([]);
      setLoadedUrl("");
      setHasMoreSongs(false);
      setLoadMoreError("");
      setLoadingMore(false);
      setSelected(new Set());
      setStatuses(new Map());
      setResolvedMatches(new Map());
      claimedMatches.current.clear();
      setLoading(false);
      return;
    }

    setUrl(parsed.url);
    setLoadedUrl(parsed.url);
    setError("");
    setLoading(true);
    setMetadata(null);
    setSongs([]);
    setHasMoreSongs(false);
    setLoadingMore(false);
    setLoadMoreError("");
    setSelected(new Set());
    setStatuses(new Map());
    setResolvedMatches(new Map());
    claimedMatches.current.clear();

    const controller = new AbortController();
    previewRequest.current = controller;
    try {
      const result = await fetchSpotifyPreview(api.spotifyPublicMetadata, parsed.url, { signal: controller.signal });
      if (thisRequest !== requestId.current) return;
      const items = result.songs.map((song, index) => ({
        ...song,
        key: `${song.id}:${index}`,
      }));
      setMetadata({ ...result, kind: parsed.kind });
      setSongs(items);
      setHasMoreSongs(
        parsed.kind === "playlist" &&
          (result.totalTracks != null && result.totalTracks > items.length ||
            items.length >= 100),
      );
      if (parsed.kind === "playlist" && items.length > 0) {
        void api
          .spotifyPlaylistSongsPage(parsed.url, 0)
          .then((page) => {
            if (thisRequest !== requestId.current) return;
            const thumbnails = new Map(
              page.songs
                .filter((song) => song.thumbnailUrl)
                .map((song) => [song.id, song.thumbnailUrl!]),
            );
            if (!thumbnails.size) return;
            setSongs((current) =>
              current.map((song) => {
                const thumbnailUrl = thumbnails.get(song.id);
                return thumbnailUrl
                  ? { ...song, thumbnailUrl }
                  : song;
              }),
            );
          })
          .catch(() => undefined);
      }
    } catch (reason) {
      if (thisRequest !== requestId.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : typeof reason === "string" && reason.trim()
            ? reason
            : "Could not load Spotify’s public playlist preview. Check your connection and retry.",
      );
    } finally {
      if (thisRequest === requestId.current) {
        previewRequest.current = null;
        setLoading(false);
      }
    }
  }

  async function submitLink(event?: FormEvent) {
    event?.preventDefault();
    await fetchLink(url);
  }

  function clearLink() {
    requestId.current += 1;
    previewRequest.current?.abort();
    previewRequest.current = null;
    setUrl("");
    setLoadedUrl("");
    setMetadata(null);
    setSongs([]);
    setHasMoreSongs(false);
    setLoadingMore(false);
    setLoadMoreError("");
    setSelected(new Set());
    setStatuses(new Map());
    setResolvedMatches(new Map());
    claimedMatches.current.clear();
    setError("");
    setLoading(false);
  }

  function cancelLoading() {
    requestId.current += 1;
    previewRequest.current?.abort();
    previewRequest.current = null;
    setLoading(false);
    setError("");
  }

  async function loadMoreSongs() {
    if (!metadata || !loadedUrl || loadingMore || !hasMoreSongs) return;
    const thisRequest = requestId.current;
    const offset = songs.length;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page: SpotifySongsPage = await api.spotifyPlaylistSongsPage(
        loadedUrl,
        offset,
      );
      if (thisRequest !== requestId.current) return;
      const items = page.songs.map((song, index) => ({
        ...song,
        key: `${song.id}:${offset + index}`,
      }));
      if (!items.length) {
        setHasMoreSongs(false);
        return;
      }
      setSongs((current) => [...current, ...items]);
      const totalTracks = page.totalTracks ?? metadata.totalTracks;
      if (page.totalTracks != null)
        setMetadata((current) =>
          current ? { ...current, totalTracks: page.totalTracks } : current,
        );
      setHasMoreSongs(
        totalTracks != null
          ? offset + items.length < totalTracks || items.length >= 100
          : items.length >= 100,
      );
    } catch (reason) {
      if (thisRequest !== requestId.current) return;
      setLoadMoreError(
        reason instanceof Error
          ? reason.message
          : typeof reason === "string" && reason.trim()
            ? reason
            : "Could not load more Spotify songs. Check your connection and retry.",
      );
    } finally {
      if (thisRequest === requestId.current) setLoadingMore(false);
    }
  }

  function setAllSelected(checked: boolean) {
    setSelected(checked ? new Set(songs.map((song) => song.key)) : new Set());
  }

  function toggleSelected(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function queueSong(
    song: PlaylistSong,
    playlist?: YoutubeDownloadPlaylist,
  ) {
    const existingMatch = resolvedMatches.get(song.key);
    const found = existingMatch
      ? [existingMatch]
      : await api.youtubeSearch(songQuery(song), 10, 0, false, false);
    const candidate = existingMatch ?? matchYoutubeSong(song, found);
    if (!candidate) {
      setStatuses((current) =>
        new Map(current).set(song.key, {
          kind: "not-found",
          message: "No confident match found. Try again.",
        }),
      );
      return;
    }
    setResolvedMatches((current) => new Map(current).set(song.key, candidate));
    if (matchesLibrary(song, libraryTracks)) {
      setStatuses((current) =>
        new Map(current).set(song.key, {
          kind: "library",
          message: "Already in your library.",
        }),
      );
      return;
    }
    const job = downloadsByUrl.get(candidate.url);
    if (job && !["failed", "cancelled"].includes(job.status)) {
      setStatuses((current) => {
        const next = new Map(current);
        next.delete(song.key);
        return next;
      });
      return;
    }
    const claimedBy = claimedMatches.current.get(candidate.url);
    if (claimedBy && claimedBy !== song.key) {
      setStatuses((current) =>
        new Map(current).set(song.key, {
          kind: "duplicate",
          message: "This match is already queued for another row.",
        }),
      );
      return;
    }
    claimedMatches.current.set(candidate.url, song.key);
    if (
      await onQueue(
        { ...candidate, title: song.title, artist: song.artist },
        playlist,
      )
    ) {
      setStatuses((current) => {
        const next = new Map(current);
        next.delete(song.key);
        return next;
      });
      return;
    }
    if (claimedMatches.current.get(candidate.url) === song.key)
      claimedMatches.current.delete(candidate.url);
    setStatuses((current) =>
      new Map(current).set(song.key, {
        kind: "error",
        message: "Could not queue this match. Retry the download.",
      }),
    );
  }

  async function downloadSongs(items: PlaylistSong[]) {
    const pending = items.filter((song) => !processing.current.has(song.key));
    if (!pending.length) return;
    const batch =
      pending.length > 2
        ? createDownloadBatch(
            metadata?.title || "Spotify playlist",
            pending.length,
          )
        : undefined;
    pending.forEach((song) => processing.current.add(song.key));
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < pending.length) {
        const index = nextIndex++;
        const song = pending[index];
        setStatuses((current) =>
          new Map(current).set(song.key, { kind: "searching" }),
        );
        try {
          await queueSong(song, batch?.(index));
        } catch (reason) {
          setStatuses((current) =>
            new Map(current).set(song.key, {
              kind: "error",
              message:
                reason instanceof Error
                  ? reason.message
                  : "Song search failed. Retry the download.",
            }),
          );
        } finally {
          processing.current.delete(song.key);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(downloadConcurrency, pending.length) },
        worker,
      ),
    );
  }

  function jobAction(
    job: YoutubeDownload | undefined,
    title: string,
    progress: number,
  ) {
    if (!job) return null;
    if (job.status === "completed")
      return (
        <button className="spotify-row-download is-complete" disabled>
          Downloaded
        </button>
      );
    if (job.status === "failed")
      return (
        <button
          className="spotify-row-download"
          onClick={() => onDownloadControl(job.id, "resume")}
        >
          Retry
        </button>
      );
    if (job.status === "paused")
      return (
        <button
          className="spotify-row-download"
          onClick={() => onDownloadControl(job.id, "resume")}
        >
          Resume
        </button>
      );
    if (job.status === "queued" || job.status === "downloading") {
      const percentage = Math.round(Math.min(100, Math.max(0, progress)));
      return (
        <button
          className="spotify-row-download"
          aria-label={`Cancel ${title} download (${percentage}%)`}
          title="Cancel download"
          onClick={() => onDownloadControl(job.id, "cancel")}
        >
          {percentage}%
        </button>
      );
    }
    return null;
  }

  function renderSongRow(song: PlaylistSong, index: number) {
    const candidate = resolvedMatches.get(song.key);
    const thumbnail = candidate?.thumbnail || song.thumbnailUrl;
    const job = candidate ? downloadsByUrl.get(candidate.url) : undefined;
    const status = statuses.get(song.key);
    const busy = status?.kind === "searching";
    const inLibrary = status?.kind === "library";
    const duplicate = status?.kind === "duplicate";
    const progress = job?.status === "completed" ? 100 : (job?.percent ?? 0);
    const action = jobAction(job, song.title, progress);
    return (
      <div className="spotify-track-row" key={song.key}>
        <input
          type="checkbox"
          checked={selected.has(song.key)}
          onChange={() => toggleSelected(song.key)}
          aria-label={`Select ${song.title}`}
        />
        <span className="spotify-track-position">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="spotify-track-art">
          {thumbnail ? (
            <img src={thumbnail} alt="" loading="lazy" />
          ) : (
            <Music2 size={18} />
          )}
        </span>
        <span className="spotify-track-copy">
          <strong title={song.title}>{song.title}</strong>
          <small>
            {[song.artist, formatDuration(song.durationSeconds)]
              .filter(Boolean)
              .join(" · ") || "Spotify preview"}
          </small>
          {status && status.kind !== "searching" && (
            <em
              className={`spotify-row-status is-${status.kind}`}
              role={
                status.kind === "error" ||
                status.kind === "library" ||
                status.kind === "duplicate"
                  ? "status"
                  : undefined
              }
            >
              {status.message}
            </em>
          )}
        </span>
        {busy ? (
          <button className="spotify-row-download" disabled>
            Searching…
          </button>
        ) : inLibrary ? (
          <button className="spotify-row-download" disabled>
            In library
          </button>
        ) : duplicate ? (
          <button className="spotify-row-download" disabled>
            Queued
          </button>
        ) : (
          (action ?? (
            <button
              className="spotify-row-download"
              onClick={() => void downloadSongs([song])}
            >
              Download
            </button>
          ))
        )}
      </div>
    );
  }

  const loadedCount = songs.length;
  const totalTracks = metadata?.totalTracks;

  return (
    <main className="spotify-import-page">
      {mobile ? (
        <header className="collection-heading detail-heading spotify-mobile-heading">
          <button
            type="button"
            className="mobile-detail-back"
            aria-label="Back"
            onClick={onBack}
          >
            <ChevronLeft size={24} />
          </button>
          <div className="heading-foreground">
            <Cover
              className="heading-cover"
              keys={[]}
              icon={<Disc3 size={36} />}
            />
            <div className="heading-copy">
              <h1>Spotify</h1>
              <p>Paste a Spotify link to view the songs.</p>
            </div>
          </div>
        </header>
      ) : (
        <header className="spotify-import-heading">
          <div className="spotify-import-title-row">
            <h1>Spotify</h1>
            <p>Paste a Spotify link to view the songs.</p>
          </div>
        </header>
      )}

      <form
        className="spotify-link-form"
        aria-busy={loading}
        onSubmit={(event) => void submitLink(event)}
      >
        <div className="spotify-link-input-row">
          <input
            id="spotify-link"
            aria-label="Spotify link"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Song, album, or playlist link"
            autoComplete="url"
          />
          {url && (
            <button
              className="spotify-input-icon"
              type="button"
              aria-label="Clear link"
              onClick={clearLink}
            >
              <X size={17} />
            </button>
          )}
          {loading ? <button className="spotify-fetch-button" type="button" onClick={cancelLoading}>Cancel</button> : <button
            className="spotify-fetch-button"
            type="submit"
            disabled={!parseSpotifyLink(url)}
          >
            Fetch songs
          </button>}
        </div>
      </form>

      {error && (
        <div className="spotify-inline-error" role="alert"><span>{error}</span>{parseSpotifyLink(url) && <button type="button" className="spotify-source-reset" onClick={() => void fetchLink(url)}>Retry</button>}</div>
      )}

      {loading && (
        <section
          className="spotify-loading-preview"
          role="status"
          aria-label="Loading Spotify playlist songs"
        >
          <div className="spotify-loading-summary">
            <i />
            <span>
              <b />
              <b />
            </span>
          </div>
          <div className="playlist-selection-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                className="playlist-selection-skeleton-row spotify-row-skeleton"
                key={index}
              >
                <i />
                <i />
                <i />
                <span>
                  <b />
                  <b />
                </span>
                <i />
              </div>
            ))}
          </div>
        </section>
      )}

      {metadata && !loading && (
        <>
          <section className="spotify-collection-card" aria-label="Playlist details">
            <div className="spotify-collection-art">
              {metadata.thumbnailUrl ? (
                <img src={metadata.thumbnailUrl} alt="" />
              ) : (
                <Disc3 size={28} />
              )}
            </div>
            <div className="spotify-collection-copy">
              <h2 title={metadata.title}>{metadata.title}</h2>
              <p>
                {[metadata.author, totalTracks != null ? `${totalTracks} songs` : null]
                  .filter(Boolean)
                  .join(" · ") || "Spotify collection"}
              </p>
            </div>
            <div className="spotify-collection-actions">
              <button
                className="spotify-download-selected"
                type="button"
                disabled={!selectedSongs.length}
                onClick={() => void downloadSongs(selectedSongs)}
              >
                Download selected ({selectedSongs.length})
              </button>
            </div>
          </section>
          {totalTracks != null && totalTracks > loadedCount && (
            <p className="spotify-partial-note">
              Showing {loadedCount} of {totalTracks} songs.
            </p>
          )}
          <section
            className="spotify-track-section"
            aria-label="Select songs to download"
          >
            <div className="spotify-selection-toolbar">
              <span className="spotify-selected-count">
                {selectedSongs.length} of {loadedCount} selected
              </span>
              <div className="spotify-selection-tools">
                {selectedSongs.length > 0 && !allSelected && (
                  <button
                    className="spotify-deselect-button"
                    type="button"
                    onClick={() => setAllSelected(false)}
                  >
                    Deselect all
                  </button>
                )}
                <button
                  className="spotify-select-all-button"
                  type="button"
                  disabled={!songs.length}
                  onClick={() => setAllSelected(!allSelected)}
                >
                  {allSelected ? "Deselect all" : `Select all ${loadedCount}`}
                </button>
              </div>
            </div>
            <div id="spotify-track-list" className="spotify-track-list">
              {songs.map(renderSongRow)}
            </div>
            {loadMoreError && (
              <div className="spotify-load-more-error" role="alert">
                <span>{loadMoreError}</span>
                <button type="button" onClick={() => void loadMoreSongs()}>
                  Retry
                </button>
              </div>
            )}
            {hasMoreSongs && !loadMoreError && (
              <div className="spotify-load-more">
                <button
                  type="button"
                  aria-controls="spotify-track-list"
                  disabled={loadingMore}
                  onClick={() => void loadMoreSongs()}
                >
                  {loadingMore ? "Loading more songs…" : "Load more songs"}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
