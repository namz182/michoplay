import { AudioLines, Clock3, Disc3, ListMusic, Youtube } from "lucide-react";
import type { Track } from "../../lib/api";
import { Cover } from "../../app/Artwork";

type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type Playlist = { id: string; name: string; trackIds: number[] };
type Section = "Albums" | "Artists" | "Recently Played" | "Playlists";

export function HomeQuickLinks({ albums, artists, recentTracks, playlists, trackMap, onNavigate, onYoutube }: {
  albums: Collection[];
  artists: Collection[];
  recentTracks: Track[];
  playlists: Playlist[];
  trackMap: Map<number, Track>;
  onNavigate: (section: Section) => void;
  onYoutube: () => void;
}) {
  const shortcuts = [
    { title: "Albums", count: albums.length, collection: albums[0], icon: <Disc3 size={21}/>, onClick: () => onNavigate("Albums") },
    { title: "Artists", count: artists.length, collection: artists[0], icon: <AudioLines size={21}/>, onClick: () => onNavigate("Artists"), artist: true },
    { title: "Recently Played", count: recentTracks.length, artwork: recentTracks[0]?.artworkKey, icon: <Clock3 size={21}/>, onClick: () => onNavigate("Recently Played") },
    { title: "Playlists", count: playlists.length, artwork: playlists[0]?.trackIds.map((id) => trackMap.get(id)?.artworkKey).filter((key): key is string => Boolean(key)), icon: <ListMusic size={21}/>, onClick: () => onNavigate("Playlists") },
  ];
  return <div className="home-quick-grid home-library-links" aria-label="Library shortcuts">
    {shortcuts.map((item) => <button className="home-quick-card" key={item.title} onClick={item.onClick}><Cover className={`home-quick-art ${"artist" in item && item.artist ? "artist" : ""}`} keys={item.collection ? item.collection.tracks.map((track) => track.artworkKey) : Array.isArray(item.artwork) ? item.artwork : item.artwork ? [item.artwork] : []} icon={item.icon}/><span><strong>{item.title}</strong><small>{item.count} {item.title === "Albums" ? item.count === 1 ? "album" : "albums" : item.title === "Artists" ? item.count === 1 ? "artist" : "artists" : item.title === "Playlists" ? item.count === 1 ? "playlist" : "playlists" : item.count === 1 ? "song" : "songs"}</small></span></button>)}
    <button className="home-quick-card home-youtube-link" onClick={onYoutube}><span className="home-quick-art"><Youtube size={22}/></span><span><strong>YouTube</strong><small>Search and download audio</small></span></button>
  </div>;
}
