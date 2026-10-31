import { Heart, ListMusic, Music2, Youtube } from "lucide-react";
import type { Track } from "../../lib/api";
import { Cover } from "../../app/Artwork";
import { Empty } from "../../components/EmptyState";

type Playlist = { id: string; name: string; trackIds: number[] };
type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };

export function MobileLibraryScreen({ favorites, availableTracks, playlists, youtubePlaylist, trackMap, hiddenTrackSet, onOpenFavorites, onOpenSongs, onOpenPlaylist }: {
  favorites: number[];
  availableTracks: Track[];
  playlists: Playlist[];
  youtubePlaylist: Playlist | undefined;
  trackMap: Map<number, Track>;
  hiddenTrackSet: Set<number>;
  onOpenFavorites: () => void;
  onOpenSongs: () => void;
  onOpenPlaylist: (collection: Collection) => void;
}) {
  const toCollection = (playlist: Playlist): Collection => ({ key: playlist.id, title: playlist.name, subtitle: "", tracks: playlist.trackIds.flatMap((id) => !hiddenTrackSet.has(id) && trackMap.get(id) ? [trackMap.get(id)!] : []) });
  const youtube = toCollection(youtubePlaylist ?? { id: "michoplay-youtube", name: "YouTube", trackIds: [] });
  const userPlaylists = playlists.filter((playlist) => playlist.name.trim().toLocaleLowerCase() !== "youtube");
  return <div className="mobile-library-view"><div className="mobile-library-list">
    <button className="mobile-library-row" onClick={onOpenFavorites}><Cover className="mobile-library-cover liked-cover" keys={favorites.flatMap((id) => trackMap.get(id)?.artworkKey ?? [])} icon={<Heart size={23} fill="currentColor"/>}/><span><strong>Liked Songs</strong><small>{favorites.length} songs · Playlist</small></span></button>
    <button className="mobile-library-row" onClick={onOpenSongs}><Cover className="mobile-library-cover" keys={availableTracks.map((track) => track.artworkKey)} icon={<Music2 size={23}/>}/><span><strong>All Songs</strong><small>{availableTracks.length} {availableTracks.length === 1 ? "song" : "songs"} · Library</small></span></button>
    <button className="mobile-library-row" onClick={() => onOpenPlaylist(youtube)}><Cover className="mobile-library-cover" keys={youtube.tracks.map((track) => track.artworkKey)} icon={<Youtube size={23}/>}/><span><strong>YouTube</strong><small>{youtube.tracks.length} songs · Playlist</small></span></button>
    {userPlaylists.map((playlist) => { const item = toCollection(playlist); return <button className="mobile-library-row" key={playlist.id} onClick={() => onOpenPlaylist(item)}><Cover className="mobile-library-cover" keys={item.tracks.map((track) => track.artworkKey)} icon={<ListMusic size={23}/>}/><span><strong>{playlist.name}</strong><small>{item.tracks.length} songs · Playlist</small></span></button>; })}
    {!userPlaylists.length && <Empty title="Your playlists will appear here" description="Create a playlist or import music using the + button."/>}
  </div></div>;
}
