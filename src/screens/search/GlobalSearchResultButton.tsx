import type { MouseEvent } from "react";
import { AudioLines, Disc3, FolderOpen, ListMusic, MoreHorizontal, Music2, Pause, Play } from "lucide-react";
import { Cover } from "../../app/Artwork";

type SearchResult = { type: "Song" | "Folder" | "Album" | "Artist" | "Playlist"; title: string; subtitle: string; artworkKey: string | null; trackId?: number };

export function SearchResultButton({ result, onClick, onMenu, isPlaying = false, showPlayHover = true }: { result: SearchResult; onClick: () => void; onMenu?: (event: MouseEvent<HTMLButtonElement>) => void; isPlaying?: boolean; showPlayHover?: boolean }) {
  const icon = result.type === "Song" ? <Music2 size={18}/> : result.type === "Artist" ? <AudioLines size={18}/> : result.type === "Folder" ? <FolderOpen size={18}/> : result.type === "Playlist" ? <ListMusic size={18}/> : <Disc3 size={18}/>;
  const hasPlaybackHover = showPlayHover && result.type === "Song";
  const main = <button className={`global-search-result ${hasPlaybackHover ? "has-playback-hover" : ""}`} role="option" aria-selected={false} aria-label={result.type === "Song" ? `${isPlaying ? "Pause" : "Play"} ${result.title}` : `Open ${result.title}`} onClick={onClick} onContextMenu={onMenu}><Cover className={`global-search-cover ${result.type === "Artist" ? "artist-art" : ""}`} keys={[result.artworkKey]} icon={icon}/><span className="search-result-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span>{hasPlaybackHover && <span className="search-result-play" aria-hidden="true">{isPlaying ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</span>}</button>;
  return onMenu && result.type === "Song" ? <div className="search-result-row">{main}<button type="button" className="search-result-menu-trigger" aria-label={`Actions for ${result.title}`} title="Song actions" onClick={onMenu}><MoreHorizontal size={18}/></button></div> : main;
}
