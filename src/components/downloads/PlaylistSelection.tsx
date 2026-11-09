import { Clock3, Download, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type YoutubeSearchResult } from "../../lib/api";
import { durationLabel } from "../../app/utils";

const PAGE_SIZE = 100;

export function PlaylistSelection({ playlist, onClose, onConfirm }: {
  playlist: YoutubeSearchResult;
  onClose: () => void;
  onConfirm: (songs: YoutubeSearchResult[]) => void;
}) {
  const [songs, setSongs] = useState<YoutubeSearchResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(true);

  async function loadPage(offset: number, append: boolean) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError("");
    try {
      const page = await api.youtubeSearch(playlist.url, PAGE_SIZE, offset, false, true);
      setSongs((prior) => append ? [...prior, ...page] : page);
      setSelected((current) => {
        const ids = new Set(current);
        page.forEach((song) => ids.add(song.id));
        return ids;
      });
      setHasMore(page.length === PAGE_SIZE);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.youtubeSearch(playlist.url, PAGE_SIZE, 0, false, true)
      .then((page) => {
        if (!active) return;
        setSongs(page);
        setSelected(new Set(page.map((song) => song.id)));
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((cause) => { if (active) setError(String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [playlist.url]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? songs.filter((song) => song.title.toLocaleLowerCase().includes(needle)) : songs;
  }, [songs, query]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((song) => selected.has(song.id));
  const someVisibleSelected = filtered.some((song) => selected.has(song.id));

  function toggle(songId: string) {
    setSelected((prior) => {
      const next = new Set(prior);
      if (next.has(songId)) next.delete(songId);
      else next.add(songId);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((prior) => {
      const next = new Set(prior);
      if (allVisibleSelected) filtered.forEach((song) => next.delete(song.id));
      else filtered.forEach((song) => next.add(song.id));
      return next;
    });
  }

  return <div className="playlist-selection-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="playlist-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-selection-title">
      <header className="playlist-selection-header">
        <div className="playlist-selection-heading"><h2 id="playlist-selection-title">{playlist.title}</h2><p>{loading ? "Loading tracks…" : `${songs.length}${hasMore ? "+" : ""} songs`}</p></div>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={19}/></button>
      </header>
      <div className="playlist-selection-toolbar">
        <label className="playlist-selection-search"><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a song"/></label>
      </div>
      <div className="playlist-selection-select-all">
        <label><input type="checkbox" checked={allVisibleSelected} aria-checked={someVisibleSelected && !allVisibleSelected ? "mixed" : allVisibleSelected} ref={(element) => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected; }} onChange={toggleVisible}/><span>Select all</span></label>
        <small>{selected.size} selected</small>
      </div>
      <div className="playlist-selection-list" aria-live="polite">
        {loading && !songs.length ? <div className="playlist-selection-skeleton" role="status" aria-label="Loading playlist tracks">{Array.from({ length: 6 }, (_, index) => <div className="playlist-selection-skeleton-row" key={index}><i/><i/><i/><span><b/><b/></span><i/></div>)}</div> : error && !songs.length ? <div className="playlist-selection-error">{error}<button onClick={() => void loadPage(0, false)}>Try again</button></div> : filtered.length ? filtered.map((song) => <label className="playlist-selection-song" key={song.id}>
          <input type="checkbox" checked={selected.has(song.id)} onChange={() => toggle(song.id)}/>
          <span className="playlist-selection-index">{songs.findIndex((entry) => entry.id === song.id) + 1}</span>
          <span className="playlist-selection-song-art">{song.thumbnail ? <img src={song.thumbnail} alt="" loading="lazy"/> : null}</span>
          <span className="playlist-selection-song-copy"><strong>{song.title}</strong><small>{song.hasLyrics ? "Lyrics available" : "YouTube audio"}</small></span>
          <span className="playlist-selection-duration"><Clock3 size={13}/>{song.durationSeconds == null ? "–:––" : durationLabel(song.durationSeconds)}</span>
        </label>) : <div className="playlist-selection-empty">{songs.length ? "No songs match your search." : "No playable tracks were found."}</div>}
        {loadingMore && <div className="playlist-selection-skeleton" role="status" aria-label="Loading more playlist tracks">{Array.from({ length: 3 }, (_, index) => <div className="playlist-selection-skeleton-row" key={index}><i/><i/><i/><span><b/><b/></span><i/></div>)}</div>}
        {hasMore && songs.length > 0 && !loadingMore && <button className="playlist-selection-load-more" onClick={() => void loadPage(songs.length, true)}>Load more songs</button>}
        {error && songs.length > 0 && <p className="playlist-selection-inline-error">{error}</p>}
      </div>
      <footer className="playlist-selection-footer"><span>{selected.size} selected</span><button className="primary-button" disabled={!selected.size || loading} onClick={() => onConfirm(songs.filter((song) => selected.has(song.id)))}><Download size={17}/>Download selected</button></footer>
    </section>
  </div>;
}
