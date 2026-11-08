import { LyricsBadge } from "../../components/LyricsBadge";
import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Clock3, Heart, MoreHorizontal, Pause, Play } from "lucide-react";
import type { PlayerSnapshot, Track } from "../../lib/api";
import { Cover } from "../../app/Artwork";
import { Empty } from "../../components/EmptyState";

function time(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

export const TrackRows = memo(function TrackRows({ items, player, favorites, compact, rowHeight: rowHeightOverride, playCounts, showPlayCount = false, onPlay, onFavorite, onMenu, emptyTitle, emptyMessage, emptyAction }: { items: Track[]; player: PlayerSnapshot; favorites: Set<number>; compact: boolean; rowHeight?: number; playCounts?: Map<number, number>; showPlayCount?: boolean; onPlay: (track: Track) => void; onFavorite: (id: number) => void; onMenu: (track: Track, event: MouseEvent) => void; emptyTitle: string; emptyMessage: string; emptyAction?: ReactNode }) {
  const [dismissedPlayControl, setDismissedPlayControl] = useState<number | null>(null);
  const [range, setRange] = useState({ start: 0, end: 80 });
  const listRef = useRef<HTMLDivElement>(null);
  const rowHeight = rowHeightOverride ?? (compact ? 43 : 54);
  const overscan = rowHeightOverride ? 24 : 12;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const root = list.closest<HTMLElement>(".content-scroll");
    const update = () => {
      const rect = list.getBoundingClientRect();
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const height = root ? root.clientHeight : window.innerHeight;
      // Measure the list and viewport in the same coordinate space. This stays
      // correct during Android WebView fling scrolling, when scroll events can
      // be coalesced and scrollTop may lag behind the painted position.
      const relativeTop = rootTop - rect.top;
      const firstVisible = Math.max(0, Math.floor(relativeTop / rowHeight));
      const lastVisible = Math.min(items.length, Math.ceil((relativeTop + height) / rowHeight));
      const next = {
        start: Math.max(0, firstVisible - overscan),
        end: Math.min(items.length, Math.max(firstVisible, lastVisible) + overscan),
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
  }, [items, overscan, rowHeight]);
  const visibleItems = items.slice(range.start, range.end);
  return <div className="track-table" role="table" aria-label="Songs"><div className="table-head" role="row"><span role="columnheader">#</span><span role="columnheader">Title</span><span role="columnheader">Album</span><span role="columnheader">Artist</span><span role="columnheader"><Clock3 size={13}/></span></div>{items.length ? <div ref={listRef} className="track-list virtual-track-list" role="rowgroup" style={{ height: items.length * rowHeight, position: "relative" }}>{visibleItems.map((track, offset) => { const index = range.start + offset; const active = player.currentTrackId === track.id && player.isPlaying; const playCount = playCounts?.get(track.id) ?? 0; const playControlDismissed = dismissedPlayControl === track.id; const playTrack = () => { setDismissedPlayControl(track.id); onPlay(track); }; const favorite = favorites.has(track.id); return <div role="row" key={track.id} className={`track-row ${player.currentTrackId === track.id ? "playing" : ""} ${playControlDismissed ? "suppress-row-play" : ""}`} style={{ position: "absolute", top: index * rowHeight, left: 0, right: 0, height: rowHeight }} onMouseLeave={() => { if (playControlDismissed) setDismissedPlayControl(null); }} onContextMenu={(event) => onMenu(track, event)}><button className="track-number" aria-label={`${active ? "Pause" : "Play"} ${track.title}`} onClick={playTrack}>{active ? <span className="playing-animation" aria-label="Playing"><i/><i/><i/></span> : <span className="row-index">{index + 1}</span>}{active ? <Pause className="row-play" size={15} fill="currentColor"/> : <Play className="row-play" size={15} fill="currentColor"/>}</button><div className="track-title-cell" role="cell"><Cover className="row-cover" keys={[track.artworkKey]}/><button className="track-name" onClick={playTrack}><strong>{track.title}</strong><small>{track.hasLyrics && <LyricsBadge />}{track.artist}{showPlayCount && playCount > 0 && <span className="track-play-count"> · {playCount} {playCount === 1 ? "play" : "plays"}</span>}</small></button></div><span className="track-album" role="cell">{track.album}</span><span className="track-artist-cell" role="cell">{track.artist}</span><span className="track-actions" role="cell"><button className={`row-action favorite-action ${favorite ? "selected" : ""}`} aria-label={favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => onFavorite(track.id)}><Heart size={15} fill={favorite ? "currentColor" : "none"}/></button><span className="track-duration">{time(track.durationMs)}</span><button className="row-action menu-trigger" aria-label={`Actions for ${track.title}`} onClick={(event) => onMenu(track, event)}><MoreHorizontal size={17}/></button></span></div>;})}</div> : <Empty title={emptyTitle} description={emptyMessage} action={emptyAction}/>}</div>;
});
