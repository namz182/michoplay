import { Plus } from "lucide-react";
import type { Track } from "../../lib/api";
import { Empty } from "../../components/EmptyState";
import { CollectionGrid } from "../../components/library/CollectionGrid";
import { HomeQuickLinks } from "./quick-links";

type Collection = { key: string; title: string; subtitle: string; tracks: Track[] };
type Playlist = { id: string; name: string; trackIds: number[] };
type Section = "Albums" | "Artists" | "Recently Played" | "Playlists";

export function HomeScreen({ isAndroid, mobileHomeFilter, setMobileHomeFilter, albums, artists, recentTracks, playlists, trackMap, folders, isScanning, currentTrackId, isPlaying, navigate, openYoutube, chooseLibrarySource, openFolder, playCollection, isCollectionCurrent }: {
  isAndroid: boolean;
  mobileHomeFilter: "All" | "Folders" | "Albums";
  setMobileHomeFilter: (filter: "All" | "Folders" | "Albums") => void;
  albums: Collection[];
  artists: Collection[];
  recentTracks: Track[];
  playlists: Playlist[];
  trackMap: Map<number, Track>;
  folders: Collection[];
  isScanning: boolean;
  currentTrackId: number | null;
  isPlaying: boolean;
  navigate: (section: Section) => void;
  openYoutube: () => void;
  chooseLibrarySource: () => void;
  openFolder: (folder: Collection) => void;
  playCollection: (collection: Collection) => void;
  isCollectionCurrent: (collection: Collection) => boolean;
}) {
  return <div className="home-section android-home">
    {isAndroid && <div className="mobile-filter-row home-filter-row" role="tablist" aria-label="Home content filters">{(["All", "Folders", "Albums"] as const).map((filter) => <button key={filter} role="tab" aria-selected={mobileHomeFilter === filter} className={mobileHomeFilter === filter ? "selected" : ""} onClick={() => setMobileHomeFilter(filter)}>{filter}</button>)}</div>}
    <HomeQuickLinks albums={albums} artists={artists} recentTracks={recentTracks} playlists={playlists} trackMap={trackMap} onNavigate={navigate} onYoutube={openYoutube}/>
    {mobileHomeFilter !== "Albums" && <>
      <div className="section-title-row"><h2>Folders</h2><button className="text-action" disabled={isScanning} onClick={chooseLibrarySource}><Plus size={15}/>{isAndroid ? "Import music" : "Add root folder"}</button></div>
      <CollectionGrid collections={folders} kind="folder" onOpen={openFolder} onPlay={playCollection} isCurrentCollection={isCollectionCurrent} playingId={currentTrackId} isPlaying={isPlaying}/>
      {!folders.length && <Empty title={isScanning ? "Scanning music…" : "Your music starts here"} description="Import audio files to build your library on this device." action={<button className="primary-button" disabled={isScanning} onClick={chooseLibrarySource}><Plus size={15}/>Import audio</button>}/>}
    </>}
  </div>;
}
