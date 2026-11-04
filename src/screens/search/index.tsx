import { Search, X, Youtube } from "lucide-react";
import type { YoutubeSearchResult } from "../../lib/api";
import { youtubeResultSizeText } from "../../lib/youtube-size";
import { SearchResultButton } from "./GlobalSearchResultButton";

type SearchResult = { type: "Song" | "Folder" | "Album" | "Artist" | "Playlist"; title: string; subtitle: string; artworkKey: string | null; trackId?: number };
type RecentSearch = { query: string; result: SearchResult | null };

function durationLabel(seconds: number) { const safeSeconds = Math.max(0, Math.floor(seconds)); return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`; }

export function MobileSearchScreen({ search, onSearch, youtubeEnabled, youtubeSearching, youtubeResults, youtubeLimit, youtubeHasMore, youtubeLoadingMore, youtubeError, onYoutubeDownload, onLoadMoreYoutube, searchResults, recentSearchResults, onChooseResult, onLoadRecentSearch, currentTrackId, isPlaying }: {
  search: string;
  onSearch: (value: string) => void;
  youtubeEnabled: boolean;
  youtubeSearching: boolean;
  youtubeResults: YoutubeSearchResult[];
  youtubeLimit: number;
  youtubeHasMore: boolean;
  youtubeLoadingMore: boolean;
  youtubeError: string;
  onYoutubeDownload: (result: YoutubeSearchResult, query: string, source: DOMRect) => void;
  onLoadMoreYoutube: () => void;
  searchResults: SearchResult[];
  recentSearchResults: RecentSearch[];
  onChooseResult: (result: SearchResult) => void;
  onLoadRecentSearch: (query: string) => void;
  currentTrackId: number | null;
  isPlaying: boolean;
}) {
  return <div className="mobile-search-view">
    <label className="mobile-search-input"><Search size={22}/><input aria-label="Search your library" placeholder="What do you want to listen to?" value={search} onChange={(event) => onSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}/>{search && <button aria-label="Clear search" onClick={() => onSearch("")}><X size={19}/></button>}</label>
    {youtubeEnabled && search.trim().length >= 2 && <section className="mobile-youtube-search-results"><h2>YouTube</h2>{youtubeSearching ? <div className="mobile-youtube-search-loading"><span/><span/><span/></div> : youtubeResults.length ? <><div className="mobile-youtube-results-scroll" role="region" aria-label="YouTube search results">{youtubeResults.slice(0, youtubeLimit).map((result) => <article className="mobile-youtube-search-result" key={result.id}><button className="mobile-youtube-search-open" onClick={(event) => onYoutubeDownload(result, search, event.currentTarget.getBoundingClientRect())}><span>{result.thumbnail ? <img src={result.thumbnail} alt="" loading="lazy"/> : <Youtube size={18}/>}</span><span className="mobile-youtube-search-copy"><strong>{result.title}</strong><small>{result.isPlaylist ? "Playlist · Size varies" : `${result.durationSeconds == null ? "YouTube" : durationLabel(result.durationSeconds)} · ${youtubeResultSizeText(result.durationSeconds, result.isPlaylist)}`}</small></span></button></article>)}</div>{youtubeHasMore && <button className="youtube-load-more mobile-youtube-load-more" disabled={youtubeLoadingMore} onClick={onLoadMoreYoutube}>{youtubeLoadingMore ? "Loading YouTube results…" : "Load more"}</button>}</> : youtubeError ? <p>{youtubeError}</p> : <p>No YouTube matches.</p>}</section>}
    {search.trim() ? searchResults.length ? <div className="mobile-search-results">{["Song", "Artist", "Album", "Folder", "Playlist"].map((type) => { const group = searchResults.filter((result) => result.type === type); return group.length ? <section className="mobile-result-group" key={type}><h2>{type === "Song" ? "Songs" : `${type}s`}</h2>{group.map((result) => <SearchResultButton key={`${result.type}-${result.title}-${result.subtitle}`} result={result} onClick={() => onChooseResult(result)} isPlaying={result.trackId === currentTrackId && isPlaying}/>)}</section> : null; })}</div> : <div className="mobile-search-empty"><strong>No matches for “{search}”</strong><span>Try a song, artist, album, folder, or playlist name.</span></div> : recentSearchResults.length ? <section className="mobile-result-group"><h2>Recent searches</h2>{recentSearchResults.map(({ query, result }) => result ? <SearchResultButton key={query} result={result} onClick={() => onLoadRecentSearch(query)} showPlayHover={false}/> : null)}</section> : <div className="mobile-search-empty"><strong>Search your music</strong><span>Find songs, artists, albums, folders, and playlists saved on this device.</span></div>}
  </div>;
}
