import { AudioLines, Disc3, FolderOpen, ListMusic, Pause, Play } from "lucide-react";
import type { Track } from "../../lib/api";
import { Cover } from "../../app/Artwork";

type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type CollectionKind = "folder" | "album" | "artist" | "playlist";
const coverKeys = (tracks: Track[]) => tracks.map((track) => track.artworkKey);

export function CollectionGrid({ collections, kind, onOpen, onPlay, isCurrentCollection, playingId, isPlaying = false }: { collections: Collection[]; kind: CollectionKind; onOpen: (collection: Collection) => void; onPlay?: (collection: Collection) => void; isCurrentCollection?: (collection: Collection) => boolean; playingId?: number | null; isPlaying?: boolean }) {
  const icon = kind === "folder" ? <FolderOpen size={30}/> : kind === "artist" ? <AudioLines size={30}/> : kind === "playlist" ? <ListMusic size={30}/> : <Disc3 size={30}/>;
  return <div className={`media-grid collection-grid ${kind}-grid`}>{collections.map((item) => {
    const active = isCurrentCollection ? isCurrentCollection(item) : item.tracks.some((track) => track.id === playingId);
    return <article className={`media-card ${kind}-card ${active ? "playing" : ""}`} key={item.key}>
      <button className="collection-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}><Cover className="card-cover" keys={coverKeys(item.tracks)} icon={icon}/>{kind === "folder" && <span className="collection-kind-label">Folder</span>}<strong title={item.title}>{item.title}</strong><small>{item.subtitle && kind === "album" ? `${item.subtitle} · ` : ""}{item.tracks.length} songs</small></button>
      {onPlay && item.tracks.length > 0 && <button className={`collection-play-button ${active && isPlaying ? "active" : ""}`} aria-label={`${active && isPlaying ? "Pause" : "Play"} ${item.title}`} title={active && isPlaying ? "Pause" : "Play"} onClick={() => onPlay(item)}>{active && isPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>}
    </article>;
  })}</div>;
}
