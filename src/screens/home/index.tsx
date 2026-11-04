import { AudioLines, Disc3, FolderOpen, ListMusic, Plus } from "lucide-react";
import { useMemo } from "react";
import type { Track } from "../../lib/api";
import { Cover } from "../../app/Artwork";
import { Empty } from "../../components/EmptyState";
import { HomeQuickLinks } from "./quick-links";

type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type Playlist = { id: string; name: string; trackIds: number[] };
type Section = "Songs" | "Albums" | "Artists" | "Playlists" | "Folders";

export function HomeScreen({ albums, artists, availableTracks, playlists, folders, isScanning, navigate, openYoutube, chooseLibrarySource, openFolder, openPlaylist, openAlbum, openArtist }: {
  albums: Collection[];
  artists: Collection[];
  availableTracks: Track[];
  playlists: Playlist[];
  folders: Collection[];
  isScanning: boolean;
  navigate: (section: Section) => void;
  openYoutube: () => void;
  chooseLibrarySource: () => void;
  openFolder: (folder: Collection) => void;
  openPlaylist: (playlist: Playlist) => void;
  openAlbum: (album: Collection) => void;
  openArtist: (artist: Collection) => void;
}) {
  const trackMap = useMemo(() => new Map(availableTracks.map((track) => [track.id, track])), [availableTracks]);
  const playlistItems = useMemo(() => playlists.filter((playlist) => playlist.name.trim().toLocaleLowerCase() !== "youtube").map((playlist) => ({
    key: playlist.id,
    title: playlist.name,
    label: "Playlist",
    meta: `${playlist.trackIds.flatMap((id) => trackMap.has(id) ? [id] : []).length} songs`,
    tracks: playlist.trackIds.flatMap((id) => trackMap.has(id) ? [trackMap.get(id)!] : []),
    onOpen: () => openPlaylist(playlist),
  })), [playlists, trackMap, openPlaylist]);
  const folderItems = folders.map((folder) => ({ ...folder, label: "Folder", meta: `${folder.tracks.length} songs`, onOpen: () => openFolder(folder) }));
  const albumItems = albums.map((album) => ({ ...album, label: "Album", meta: album.subtitle || `${album.tracks.length} songs`, onOpen: () => openAlbum(album) }));
  const artistItems = artists.map((artist) => ({ ...artist, label: "Artist", meta: `${artist.tracks.length} songs`, onOpen: () => openArtist(artist) }));
  return <div className="home-section android-home">
    <HomeQuickLinks songCount={availableTracks.length} onNavigate={navigate} onYoutube={openYoutube}/>
    <HomeArtShelf title="Folders" items={folderItems} onViewAll={() => navigate("Folders")} addLabel="Add root folder" addDisabled={isScanning} onAdd={chooseLibrarySource}/>
    {!folders.length && <Empty title={isScanning ? "Scanning music…" : "Your music starts here"} description="Import audio files to build your library on this device." action={<button className="primary-button" disabled={isScanning} onClick={chooseLibrarySource}><Plus size={15}/>Import audio</button>}/>}
    {playlistItems.length > 0 && <HomeArtShelf title="Playlists" items={playlistItems} onViewAll={() => navigate("Playlists")}/>}
    {albumItems.length > 0 && <HomeArtShelf title="Albums" items={albumItems} onViewAll={() => navigate("Albums")}/>}
    {artistItems.length > 0 && <HomeArtShelf title="Artists" items={artistItems} onViewAll={() => navigate("Artists")}/>}
  </div>;
}

type ShelfItem = { key: string; title: string; label: string; meta: string; tracks: Track[]; onOpen: () => void };
function HomeArtShelf({ title, items, onViewAll, addLabel, addDisabled = false, onAdd }: { title: string; items: ShelfItem[]; onViewAll: () => void; addLabel?: string; addDisabled?: boolean; onAdd?: () => void }) {
  return <section className="home-art-shelf" aria-label={title}>
    <header className="home-art-shelf-heading"><h2>{title}</h2><div>{onAdd && <button className="home-shelf-action" disabled={addDisabled} onClick={onAdd}><Plus size={14}/>{addLabel}</button>}<button className="home-shelf-action home-shelf-view-all" onClick={onViewAll}>Show all</button></div></header>
    {items.length > 0 && <div className="home-art-shelf-row">{items.map((item) => <button key={item.key} className="home-art-card" onClick={item.onOpen}>
      <Cover className="home-art-card-cover" keys={item.tracks.map((track) => track.artworkKey)} icon={item.label === "Folder" ? <FolderOpen size={30}/> : item.label === "Playlist" ? <ListMusic size={30}/> : item.label === "Artist" ? <AudioLines size={30}/> : <Disc3 size={30}/>}/>
      <span className="home-art-card-label">{item.label}</span><strong>{item.title}</strong><small>{item.meta}</small>
    </button>)}</div>}
  </section>;
}
