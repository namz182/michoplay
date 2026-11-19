import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Maximize2, Minus, MoreHorizontal, Plus, RotateCcw, Search, X } from "lucide-react";
import { Cover } from "../../app/Artwork";
import { api, type LyricsData, type LyricsSearchResult, type Track } from "../../lib/api";

type Line = { timeMs: number; text: string };

function parseLrc(text: string): Line[] {
  const lines: Line[] = [];
  for (const row of text.split(/\r?\n/)) {
    const matches = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const lyric = row.replace(/\[(?:\d{1,3}):(\d{2})(?:[.:]\d{1,3})?\]/g, "").trim();
    for (const match of matches) {
      const fraction = (match[3] ?? "0").padEnd(3, "0").slice(0, 3);
      lines.push({ timeMs: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction), text: lyric });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function durationLabel(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

const LyricsLineList = memo(function LyricsLineList({
  lines,
  plainLines,
  active,
  trackId,
  displayOffsetMs,
  visible,
  onSeek,
}: {
  lines: Line[];
  plainLines: string[];
  active: number;
  trackId: number;
  displayOffsetMs: number;
  visible: boolean;
  onSeek?: (positionMs: number) => void;
}) {
  const activeRef = useRef<HTMLParagraphElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousActive = useRef<{ trackId: number; index: number } | null>(null);

  useEffect(() => {
    if (!visible) {
      previousActive.current = null;
      return;
    }
    if (!activeRef.current || !scrollRef.current) return;
    const activeLine = activeRef.current.getBoundingClientRect();
    const list = scrollRef.current;
    const listBounds = list.getBoundingClientRect();
    const lineTop = list.scrollTop + activeLine.top - listBounds.top;
    const target = lineTop - (list.clientHeight - activeLine.height) / 2;
    const previous = previousActive.current;
    previousActive.current = { trackId, index: active };
    const smooth = previous?.trackId === trackId && previous.index !== active &&
      Math.abs(previous.index - active) <= 3 && Math.abs(target - list.scrollTop) <= list.clientHeight &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  }, [active, trackId, visible]);

  return <div ref={scrollRef} className="lyrics-scroll">
    {lines.length ? lines.map((line, index) => <p key={`${line.timeMs}-${index}`} ref={index === active ? activeRef : undefined} className={`lyrics-line ${index === active ? "active" : index < active ? "past" : ""}`} role={onSeek ? "button" : undefined} tabIndex={onSeek ? 0 : undefined} onClick={onSeek ? () => onSeek(Math.max(0, line.timeMs + displayOffsetMs)) : undefined} onKeyDown={onSeek ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSeek(Math.max(0, line.timeMs + displayOffsetMs)); } } : undefined}>{line.text || "♪"}</p>) : plainLines.map((line, index) => <p key={index}>{line}</p>)}
  </div>;
});

export function LyricsView({
  track, text, positionMs, offsetMs = 0, source, loading = false,
  expanded = false, preview = false, visible = true, onExpand, onClose, onSeek, onImported, onOffsetSaved,
}: {
  track: Track; text: string; positionMs: number; offsetMs?: number; source?: string | null;
  loading?: boolean; expanded?: boolean; preview?: boolean; visible?: boolean; onExpand?: () => void;
  onClose?: () => void; onSeek?: (positionMs: number) => void;
  onImported?: (result: LyricsData) => void; onOffsetSaved?: (offsetMs: number) => void;
}) {
  const lines = useMemo(() => parseLrc(text), [text]);
  const plainLines = useMemo(() => lines.length ? [] : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), [text, lines.length]);
  const [draftOffsetMs, setDraftOffsetMs] = useState(offsetMs);
  const displayOffsetMs = preview ? offsetMs : draftOffsetMs;
  const active = lines.reduce((index, line, lineIndex) => line.timeMs + displayOffsetMs <= positionMs ? lineIndex : index, -1);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const seekTo = useCallback((positionMs: number) => onSeekRef.current?.(positionMs), []);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LyricsSearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [timingSaving, setTimingSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchFailed, setSearchFailed] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    setDraftOffsetMs(offsetMs);
  }, [track.id, offsetMs]);

  useEffect(() => {
    requestId.current += 1;
    setActionsOpen(false);
    setSearchOpen(false);
    setQuery("");
    setResults([]);
    setSelectedId(null);
    setError("");
    setSearchFailed(false);
  }, [track.id]);

  async function searchLyrics(value: string) {
    const currentRequest = ++requestId.current;
    setSearching(true);
    setError("");
    setSearchFailed(false);
    setSelectedId(null);
    try {
      const matches = await api.lyricsSearch(track.id, value);
      if (currentRequest === requestId.current) setResults(matches);
    } catch (reason) {
      if (currentRequest === requestId.current) {
        setResults([]);
        setSearchFailed(true);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (currentRequest === requestId.current) setSearching(false);
    }
  }

  function openSearch() {
    const titleQuery = [track.title, track.artist].filter(Boolean).join(" · ");
    setQuery((current) => current.trim() ? current : titleQuery);
    setActionsOpen(true);
    setSearchOpen(true);
    if (!results.length) void searchLyrics("");
  }

  function toggleActions() {
    if (actionsOpen) setSearchOpen(false);
    setActionsOpen(!actionsOpen);
  }

  async function importSelected(item: LyricsSearchResult) {
    const lyrics = item.syncedLyrics?.trim() || item.plainLyrics?.trim();
    if (!lyrics) return;
    setImporting(true);
    setError("");
    try {
      const imported = await api.lyricsImport(track.id, lyrics, item.id);
      onImported?.(imported);
      setSearchOpen(false);
      setActionsOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  }

  function adjustTiming(value: number) {
    if (timingSaving || value < -30_000 || value > 30_000) return;
    setDraftOffsetMs(value);
    setError("");
  }

  async function saveTiming() {
    if (timingSaving || draftOffsetMs === offsetMs) return;
    setTimingSaving(true);
    setError("");
    try {
      const saved = await api.lyricsSetOffset(track.id, draftOffsetMs);
      setDraftOffsetMs(saved);
      onOffsetSaved?.(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTimingSaving(false);
    }
  }

  if (preview) {
    const currentLine = lines[active];
    return <button className="lyrics-current-preview" type="button" aria-label={`Open lyrics for ${track.title}`} onClick={onExpand}>
      {currentLine?.text || plainLines[0] || "Lyrics available · Tap to open"}
    </button>;
  }

  const selected = results.find((item) => item.id === selectedId);
  const previewText = selected?.syncedLyrics?.trim() || selected?.plainLyrics?.trim() || "";
  const previewLines = previewText.split(/\r?\n/).map((line) => line.replace(/^\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*/, "").trim()).filter(Boolean).slice(0, 5);
  const errorAlert = error ? <div className="lyrics-search-error" role="alert">
    <span>{error}</span>
    <button type="button" aria-label="Dismiss lyrics alert" title="Dismiss alert" onClick={() => setError("")}><X size={15} /></button>
  </div> : null;

  return <section className={`lyrics-view ${expanded ? "expanded" : ""}`} aria-label={`Lyrics for ${track.title}`}>
    <div className="lyrics-backdrop"><Cover className="lyrics-backdrop-art" keys={[track.artworkKey]} /></div>
    <header className="lyrics-heading">
      <div><strong>Lyrics</strong>{source?.startsWith("LRCLIB:") && <span>Imported from LRCLIB</span>}</div>
      <div className="lyrics-actions">
        <button type="button" className={draftOffsetMs !== offsetMs ? "lyrics-actions-unsaved" : undefined} aria-label={`${actionsOpen ? "Hide" : "Show"} lyrics actions${draftOffsetMs !== offsetMs ? ", unsaved timing changes" : ""}`} aria-expanded={actionsOpen} title={draftOffsetMs !== offsetMs ? "Unsaved timing changes" : actionsOpen ? "Hide actions" : "Lyrics actions"} onClick={toggleActions}><MoreHorizontal size={19} /></button>
        {onClose && <button aria-label="Close lyrics" title="Close lyrics" onClick={onClose}><X size={18} /></button>}
        {onExpand && <button aria-label="Expand lyrics" title="Expand lyrics" onClick={onExpand}><Maximize2 size={17} /></button>}
      </div>
    </header>
    {actionsOpen && <div className="lyrics-actions-panel">
      <button type="button" className="lyrics-search-toggle" aria-expanded={searchOpen} onClick={() => searchOpen ? setSearchOpen(false) : openSearch()}><Search size={16} />{searchOpen ? "Close search" : "Search lyrics"}</button>
      {!searchOpen && lines.length > 0 && <div className="lyrics-timing-tools" aria-label="Adjust lyric timing">
        <span>Timing {draftOffsetMs === 0 ? "0.0" : `${draftOffsetMs > 0 ? "+" : ""}${(draftOffsetMs / 1000).toFixed(1)}`}s</span>
        <button disabled={timingSaving || draftOffsetMs <= -30_000} onClick={() => adjustTiming(draftOffsetMs - 500)} aria-label="Show lyrics half a second earlier"><Minus size={15} />0.5s</button>
        <button disabled={timingSaving || draftOffsetMs >= 30_000} onClick={() => adjustTiming(draftOffsetMs + 500)} aria-label="Show lyrics half a second later"><Plus size={15} />0.5s</button>
        {draftOffsetMs !== 0 && <button disabled={timingSaving} onClick={() => adjustTiming(0)} aria-label="Reset lyric timing"><RotateCcw size={14} /></button>}
        {draftOffsetMs !== offsetMs && <>
          <button className="lyrics-timing-cancel" disabled={timingSaving} onClick={() => setDraftOffsetMs(offsetMs)}>Cancel</button>
          <button className="lyrics-timing-save" disabled={timingSaving} onClick={() => void saveTiming()}>{timingSaving ? "Saving…" : "Save timing"}</button>
        </>}
      </div>}
    </div>}
    {searchOpen ? <div className="lyrics-search-panel">
      <form className="lyrics-search-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void searchLyrics(query); }}>
        <input aria-label="Search lyrics by song or artist" placeholder="Song title or artist" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
      </form>
      {errorAlert}
      {searching ? <div className="lyrics-search-skeleton" role="status" aria-label="Searching lyrics">
        {Array.from({ length: 5 }, (_, index) => <div className="lyrics-search-skeleton-row" aria-hidden="true" key={index}>
          <span><i /><i /></span><i />
        </div>)}
      </div> : error ? null : results.length ? <div className="lyrics-search-results">
        {results.map((item) => <button className={`lyrics-search-result ${selectedId === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}>
          <span><strong>{item.trackName}</strong><small>{item.artistName}{item.albumName ? ` · ${item.albumName}` : ""}</small></span>
          <span className="lyrics-result-meta">{item.duration !== null && `${durationLabel(item.duration)} · `}{item.syncedLyrics ? "Synced" : "Plain"}</span>
        </button>)}
      </div> : <p className="lyrics-search-status">{searchFailed ? "Search again to retry." : "No lyrics found. Try a shorter song or artist name."}</p>}
      {selected && <div className="lyrics-import-preview" role="group" aria-label={`Lyrics preview for ${selected.trackName}`}>
        <div className="lyrics-import-preview-copy">
          <strong>{selected.trackName}</strong>
          <span>{selected.artistName}{selected.albumName ? ` · ${selected.albumName}` : ""}</span>
          <small>{selected.duration !== null ? `${durationLabel(selected.duration)} · ` : ""}{selected.syncedLyrics?.trim() ? "Synced" : "Plain"} lyrics</small>
        </div>
        <button disabled={importing || !previewText.trim()} onClick={() => void importSelected(selected)}>{importing ? "Importing…" : "Import lyrics"}</button>
        <div className="lyrics-import-preview-lines">
          {previewLines.length ? previewLines.map((line, index) => <p key={index}>{line}</p>) : <p className="lyrics-import-preview-empty">No lyric text is available for this match.</p>}
        </div>
      </div>}
    </div> : <>
      {errorAlert}
      {lines.length || plainLines.length ? <LyricsLineList
        lines={lines}
        plainLines={plainLines}
        active={active}
        trackId={track.id}
        displayOffsetMs={displayOffsetMs}
        visible={visible}
        onSeek={onSeek ? seekTo : undefined}
      /> : <div className="lyrics-scroll"><div className="lyrics-unavailable">
        <strong>{loading ? "Loading lyrics…" : "No lyrics saved"}</strong>
        {!loading && <><span>Search for this song and import the match you want.</span><button className="lyrics-find-button" onClick={openSearch}><Search size={16} />Search lyrics</button></>}
      </div></div>}
    </>}
  </section>;
}
