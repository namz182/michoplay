import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AudioLines, Bug, ChevronDown, ChevronLeft, ChevronRight, Download, Eye, EyeOff, FolderOpen, Github, Globe2, List, ListFilter, Maximize2, Plus, RefreshCw, Search, Settings2, Share2, Timer, Trash2, Volume2, X } from "lucide-react";
import type { PlayerSnapshot, Track } from "../../lib/api";
import { saveStoredData, stored } from "../../lib/storage";
import packageInfo from "../../../package.json";

const equalizerFrequencies = ["60Hz", "150Hz", "400Hz", "1KHz", "2.4KHz", "15KHz"];
const keyboardShortcuts: { action: string; keys: string[] }[] = [
  { action: "Play or pause", keys: ["Space"] },
  { action: "Seek back or forward 5 seconds", keys: ["←", "→"] },
  { action: "Previous or next song", keys: ["Ctrl / ⌘", "← / →"] },
  { action: "Toggle shuffle", keys: ["Ctrl / ⌘", "Shift", "S"] },
  { action: "Change repeat mode", keys: ["Ctrl / ⌘", "R"] },
  { action: "Focus music search", keys: ["Ctrl / ⌘", "K"] },
  { action: "Zoom out, in, or reset", keys: ["Ctrl / ⌘", "− / + / 0"] },
];
const michoplayGithubUrl = "https://github.com/namz182/michoplay";
const michoplayIssueUrl = "https://github.com/namz182/michoplay/issues/new";
const michoplayDeveloperUrl = "https://mainza.dev";
const michoplayWebsiteUrl = "https://michoplay.mainza.dev/";
function sleepTimerLabel(ms: number) { const seconds = Math.ceil(Math.max(0, ms) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`; }

export function EqualizerSettings({ bands, enabled, mobile = false, onChange, onPreview, onToggle }: { bands: number[]; enabled: boolean; mobile?: boolean; onChange: (bands: number[]) => void | Promise<unknown>; onPreview: (bands: number[]) => void | Promise<unknown>; onToggle: (enabled: boolean) => void }) {
  const presets = [
    { name: "Flat", bands: [0, 0, 0, 0, 0, 0] },
    { name: "Bass boost", bands: [6, 5, 3, 0, -1, 0] },
    { name: "Vocal", bands: [-3, -1, 2, 4, 2, -1] },
    { name: "Treble", bands: [-2, -1, 0, 1, 4, 5] },
    { name: "Rock", bands: [4, 3, -1, 1, 3, 4] },
  ];
  const [savedPresets, setSavedPresets] = useState<{ name: string; bands: number[] }[]>(() => stored("equalizer-presets", []));
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState("");
  const dragIndex = useRef<number | null>(null);
  const dragSvg = useRef<SVGSVGElement | null>(null);
  const dragPointerId = useRef<number | null>(null);
  const dragBounds = useRef<{ top: number; height: number } | null>(null);
  const latestBands = useRef<number[] | null>(null);
  const dragChanged = useRef(false);
  const previewTimer = useRef<number | null>(null);
  const pendingPreview = useRef<number[] | null>(null);
  const previewInFlight = useRef(false);
  const previewRequest = useRef<Promise<unknown> | null>(null);
  const lastPreviewAt = useRef(0);
  const chartLine = useRef<SVGPathElement | null>(null);
  const chartFill = useRef<SVGPathElement | null>(null);
  const chartHitTargets = useRef<(SVGCircleElement | null)[]>([]);
  const chartPoints = useRef<(SVGCircleElement | null)[]>([]);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => { onPreviewRef.current = onPreview; }, [onPreview]);
  const visibleBands = latestBands.current ?? bands;
  const allPresets = [...presets, ...savedPresets];
  const activePreset = allPresets.find((preset) => preset.bands.every((gain, index) => gain === visibleBands[index]))?.name;
  const builtInName = (name: string) => presets.some((preset) => preset.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const updateBand = (index: number, value: number) => {
    const next = [...visibleBands]; next[index] = Math.max(-12, Math.min(12, value)); onChange(next);
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name || builtInName(name)) return;
    const next = [...savedPresets.filter((preset) => preset.name.toLocaleLowerCase() !== name.toLocaleLowerCase()), { name, bands: [...visibleBands] }];
    setSavedPresets(next); saveStoredData("equalizer-presets", JSON.stringify(next));
    setPresetName(""); setSaving(false);
  };
  const chartX = (index: number) => mobile ? 65 + index * 127 : 120 + index * 116;
  const chartY = (gain: number) => 25 + (12 - gain) * (175 / 24);
  const curveFor = (values: number[]) => values.map((gain, index) => [chartX(index), chartY(gain)] as [number, number]);
  const smoothPathFor = (points: [number, number][]) => points.slice(1).reduce((path, [x, y], index) => {
    const [previousX, previousY] = points[index]; const dx = (x - previousX) / 3;
    return path + " C " + (previousX + dx) + " " + previousY + " " + (x - dx) + " " + y + " " + x + " " + y;
  }, "M " + points[0][0] + " " + points[0][1]);
  const fillPathFor = (points: [number, number][], path: string) => "M " + points[0][0] + " 112 L " + points[0][0] + " " + points[0][1] + path.slice(path.indexOf(" C")) + " L " + points[points.length - 1][0] + " 112 Z";
  const curve = curveFor(visibleBands);
  const smoothPath = smoothPathFor(curve);
  const fillPath = fillPathFor(curve, smoothPath);
  const updateChartPreview = (values: number[]) => {
    const points = curveFor(values);
    const path = smoothPathFor(points);
    chartLine.current?.setAttribute("d", path);
    chartFill.current?.setAttribute("d", fillPathFor(points, path));
    points.forEach(([, y], index) => {
      chartHitTargets.current[index]?.setAttribute("cy", String(y));
      chartPoints.current[index]?.setAttribute("cy", String(y));
      chartPoints.current[index]?.setAttribute("aria-valuenow", String(values[index]));
    });
  };
  const queueAudioPreview = (next: number[]) => {
    pendingPreview.current = next;
    if (previewTimer.current !== null || previewInFlight.current) return;
    const flush = () => {
      previewTimer.current = null;
      if (previewInFlight.current) return;
      const pending = pendingPreview.current;
      pendingPreview.current = null;
      if (!pending) return;
      const delay = Math.max(0, 60 - (performance.now() - lastPreviewAt.current));
      if (delay > 0) {
        pendingPreview.current = pending;
        previewTimer.current = window.setTimeout(flush, delay);
        return;
      }
      lastPreviewAt.current = performance.now();
      previewInFlight.current = true;
      const request = (async () => {
        try { await onPreviewRef.current(pending); }
        catch { /* The final value is still applied when the drag ends. */ }
        finally {
          previewInFlight.current = false;
          previewRequest.current = null;
          if (dragIndex.current !== null && pendingPreview.current) queueAudioPreview(pendingPreview.current);
        }
      })();
      previewRequest.current = request;
      void request;
    };
    flush();
  };
  const updateFromPointer = (clientY: number, index: number) => {
    const bounds = dragBounds.current;
    if (!bounds || bounds.height <= 0) return;
    const svgY = (clientY - bounds.top) * 250 / bounds.height;
    const value = Math.max(-12, Math.min(12, Math.round(12 - (svgY - 25) * 24 / 175)));
    const next = [...(latestBands.current ?? visibleBands)];
    if (next[index] === value) return;
    next[index] = value;
    latestBands.current = next;
    dragChanged.current = true;
    updateChartPreview(next);
    queueAudioPreview(next);
  };
  const finishDrag = (event?: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex.current === null) return;
    if (event && dragPointerId.current !== event.pointerId) return;
    const svg = dragSvg.current;
    const pointerId = dragPointerId.current;
    dragIndex.current = null;
    dragSvg.current = null;
    dragPointerId.current = null;
    dragBounds.current = null;
    if (svg && pointerId !== null && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    pendingPreview.current = null;
    const finalBands = latestBands.current;
    if (dragChanged.current && finalBands) {
      const committedBands = [...finalBands];
      const commit = () => { void onChange(committedBands); };
      if (previewRequest.current) void previewRequest.current.finally(commit);
      else commit();
    }
    latestBands.current = null;
    dragChanged.current = false;
  };
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    pendingPreview.current = null;
  }, []);
  return <section className={`eq-section ${mobile ? "mobile-equalizer-editor" : ""}`}>
    <header className="eq-header"><h2>Equalizer</h2><button className={`switch ${enabled ? "on" : ""}`} role="switch" aria-label="Equalizer" aria-checked={enabled} onClick={() => onToggle(!enabled)}><span/></button></header>
    <div className={`equalizer-settings ${enabled ? "" : "disabled"}`}>
      <div className="eq-toolbar"><label className="eq-select-wrap"><span className="sr-only">Equalizer preset</span><select aria-label="Equalizer preset" value={activePreset ?? "manual"} onChange={(event) => { const preset = allPresets.find((item) => item.name === event.target.value); if (preset) onChange([...preset.bands]); }}><option value="manual">Manual</option>{presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}{savedPresets.length > 0 && <optgroup label="My presets">{savedPresets.map((preset) => <option key={`saved-${preset.name}`} value={preset.name}>{preset.name}</option>)}</optgroup>}</select></label>
        {saving ? <form className="eq-save-form" onSubmit={(event) => { event.preventDefault(); savePreset(); }}><input autoFocus maxLength={40} value={presetName} aria-label="Preset name" placeholder="Preset name" onChange={(event) => setPresetName(event.target.value)}/><button type="submit" disabled={!presetName.trim() || builtInName(presetName)}>Save</button><button type="button" onClick={() => { setSaving(false); setPresetName(""); }}>Cancel</button></form> : <button className="eq-save-button" onClick={() => setSaving(true)}>Save preset</button>}
      </div>
      <div className="eq-chart-wrap"><svg className="eq-chart" viewBox="0 0 760 250" preserveAspectRatio="none" role="group" aria-label="Equalizer controls" onPointerMove={(event) => { if (dragPointerId.current === event.pointerId && dragIndex.current !== null) updateFromPointer(event.clientY, dragIndex.current); }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
        <defs>
          <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--blush)" stopOpacity=".42"/><stop offset="64%" stopColor="var(--brand-highlight)" stopOpacity=".24"/><stop offset="100%" stopColor="var(--accent)" stopOpacity=".05"/></linearGradient>
          <linearGradient id="eq-line" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="var(--blush)"/><stop offset="64%" stopColor="#f5eee8"/><stop offset="100%" stopColor="var(--accent)"/></linearGradient>
        </defs>
        <text className="eq-db-label" x="0" y="30">+12dB</text><text className="eq-db-label" x="0" y="117">0dB</text><text className="eq-db-label" x="0" y="205">−12dB</text>
        {curve.map(([x], index) => <line className="eq-gridline" key={`grid-${index}`} x1={x} x2={x} y1="25" y2="200"/>)}<line className="eq-zero-line" x1="65" x2="700" y1="112" y2="112"/>
        <path ref={chartFill} className="eq-fill" d={fillPath}/><path ref={chartLine} className="eq-line" d={smoothPath}/>
        {curve.map(([x, y], index) => <g key={equalizerFrequencies[index]}><circle ref={(node) => { chartHitTargets.current[index] = node; }} className="eq-hit-target" cx={x} cy={y} r="17" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const svg = event.currentTarget.ownerSVGElement; const bounds = svg?.getBoundingClientRect(); if (!svg || !bounds || bounds.height <= 0) return; try { svg.setPointerCapture(event.pointerId); } catch { return; } dragIndex.current = index; dragSvg.current = svg; dragPointerId.current = event.pointerId; dragBounds.current = { top: bounds.top, height: bounds.height }; latestBands.current = [...visibleBands]; dragChanged.current = false; updateFromPointer(event.clientY, index); }}/><circle ref={(node) => { chartPoints.current[index] = node; }} className="eq-point" cx={x} cy={y} r="4" role="slider" tabIndex={0} aria-label={equalizerFrequencies[index]} aria-valuemin={-12} aria-valuemax={12} aria-valuenow={visibleBands[index]} aria-valuetext={`${visibleBands[index]} dB`} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); updateBand(index, visibleBands[index] + 1); } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); updateBand(index, visibleBands[index] - 1); } }}/><text className="eq-frequency-label" x={x} y="232" textAnchor="middle">{equalizerFrequencies[index]}</text></g>)}
      </svg></div>
      <div className="eq-card-footer"><button className="outline-button eq-reset" onClick={() => onChange([0, 0, 0, 0, 0, 0])}>Reset</button></div>
    </div>
  </section>;
}

export function MobileSettingsPage({ roots, player, equalizerBands, equalizerEnabled, compact, keepScreenAwake, scanning, zoomLevel, hiddenTracks, onRestoreTrack, onBack, onKeepScreenAwake, onEqualizer, onEqualizerPreview, onEqualizerToggle, onCompact, onAdd, onRemove, onRefresh, onVolume, onSleepTimer, onZoom, onAbout }: { roots: string[]; player: PlayerSnapshot; equalizerBands: number[]; equalizerEnabled: boolean; compact: boolean; keepScreenAwake: boolean; scanning: boolean; zoomLevel: number; hiddenTracks: Track[]; onRestoreTrack: (id: number) => void; onBack: () => void; onKeepScreenAwake: (value: boolean) => void; onEqualizer: (bands: number[]) => void; onEqualizerPreview: (bands: number[]) => void | Promise<unknown>; onEqualizerToggle: (enabled: boolean) => void; onCompact: (value: boolean) => void; onAdd: () => void; onRemove: (root: string) => void; onRefresh: () => void; onVolume: (value: number) => void; onSleepTimer: (minutes: number | null, atTrackEnd: boolean) => void; onZoom: (value: number) => void; onAbout: () => void }) {
  const [query, setQuery] = useState("");
  const [equalizerOpen, setEqualizerOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [hiddenSongsOpen, setHiddenSongsOpen] = useState(false);
  const [hiddenSongsSearch, setHiddenSongsSearch] = useState("");
  useEffect(() => {
    document.querySelector<HTMLElement>(".content-scroll")?.scrollTo({ top: 0, behavior: "auto" });
  }, []);
  const timerValue = player.sleepTimerAtTrackEnd ? "track" : player.sleepTimerRemainingMs ? String(Math.max(1, Math.ceil(player.sleepTimerRemainingMs / 60_000 / 15) * 15)) : "off";
  const matches = (value: string) => !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const toggle = (label: string, value: boolean, change: (next: boolean) => void) => <button className={`mobile-settings-switch ${value ? "on" : ""}`} role="switch" aria-label={label} aria-checked={value} onClick={(event) => { event.stopPropagation(); change(!value); }}><span/></button>;
  const row = (icon: ReactNode, title: string, description: string, trailing: ReactNode, onClick?: () => void, className = "") => <div className={`mobile-settings-row ${onClick ? "action" : ""} ${className}`}>{onClick ? <button className="mobile-settings-row-button" onClick={onClick}>{icon}<span><strong>{title}</strong><small>{description}</small></span><span className="mobile-settings-row-trailing">{trailing}</span></button> : <>{icon}<span><strong>{title}</strong><small>{description}</small></span><span className="mobile-settings-row-trailing">{trailing}</span></>}</div>;
  const section = (title: string, children: ReactNode, visible: boolean) => visible ? <section className="mobile-settings-section"><h2>{title}</h2><div className="mobile-settings-card">{children}</div></section> : null;
  const eqMatches = matches("equalizer audio sound bass treble");
  const sleepMatches = matches("sleep timer playback");
  const volumeMatches = matches("volume audio playback");
  const libraryMatches = matches("music folders library songs original files");
  const hiddenMatches = matches("hidden songs restore manage");
  const matchingHiddenTracks = hiddenTracks.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(hiddenSongsSearch.trim().toLocaleLowerCase()));
  const refreshMatches = matches("refresh library scan");
  const downloadsMatches = matches("downloads music folder youtube");
  const appearanceMatches = matches("screen awake display compact song list");
  const zoomMatches = matches("zoom level scale size text dense spacious");
  const aboutMatches = matches("about michoplay version");
  const playbackVisible = eqMatches || sleepMatches || volumeMatches;
  const libraryVisible = libraryMatches || refreshMatches || downloadsMatches || hiddenMatches;
  const appearanceVisible = appearanceMatches || zoomMatches;
  const aboutVisible = aboutMatches;
  return <div className="mobile-settings-page">
    <header className="mobile-settings-header"><button aria-label="Back to music" onClick={onBack}><ChevronLeft size={27}/></button><h1>Settings</h1><span/></header>
    <label className="mobile-settings-search"><Search size={21}/><input aria-label="Find a setting" placeholder="Find a setting" value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <button aria-label="Clear settings search" onClick={() => setQuery("")}><X size={18}/></button>}</label>
    {section("Playback", <>
      {eqMatches && <div className={`mobile-settings-row mobile-settings-eq ${equalizerOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={equalizerOpen} onClick={() => setEqualizerOpen((open) => !open)}><ListFilter size={21}/><span><strong>Equalizer</strong></span><span className="mobile-settings-row-trailing"><span className="mobile-settings-value">{equalizerEnabled ? "On" : "Off"}</span>{equalizerOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{equalizerOpen && <div className="mobile-eq-panel"><div className="mobile-eq-toggle"><span>Enable equalizer</span>{toggle("Enable equalizer", equalizerEnabled, onEqualizerToggle)}</div><EqualizerSettings bands={equalizerBands} enabled={equalizerEnabled} mobile onChange={onEqualizer} onPreview={onEqualizerPreview} onToggle={onEqualizerToggle}/></div>}</div>}
      {sleepMatches && row(<Timer size={21}/>, "Sleep timer", player.sleepTimerAtTrackEnd ? "Stops at the end of this song." : player.sleepTimerRemainingMs ? `Stops in ${sleepTimerLabel(player.sleepTimerRemainingMs)}.` : "Stop playback after a set time.", <select className="mobile-settings-select" aria-label="Sleep timer" value={timerValue} onChange={(event) => { const value = event.target.value; onSleepTimer(value === "off" || value === "track" ? null : Number(value), value === "track"); }} onClick={(event) => event.stopPropagation()}><option value="off">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="track" disabled={!player.currentTrackId}>Track end</option></select>)}
      {volumeMatches && row(<Volume2 size={21}/>, "Volume", "Audio output level.", <span className="mobile-settings-volume"><input type="range" min="0" max="1" step="0.01" value={player.volume} aria-label="Volume" style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} onChange={(event) => onVolume(Number(event.target.value))}/><output>{Math.round(player.volume * 100)}%</output></span>)}
    </>, playbackVisible)}
    {section("Library & storage", <>
      {libraryMatches && <div className={`mobile-settings-row mobile-settings-folders ${foldersOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={foldersOpen} onClick={() => setFoldersOpen((open) => !open)}><FolderOpen size={21}/><span><strong>Music folders</strong><small>{roots.length ? `${roots.length} folder${roots.length === 1 ? "" : "s"}` : "Add a folder to find music on your phone."}</small></span><span className="mobile-settings-row-trailing">{foldersOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{foldersOpen && <div className="mobile-folder-manager">{roots.length ? roots.map((root) => <div className="mobile-folder-row" key={root}><FolderOpen size={16}/><span className={`mobile-folder-path ${root.length > 34 ? "long" : ""}`} title={root}><span className="mobile-folder-path-track"><span>{root}</span>{root.length > 34 && <span aria-hidden="true">{root}</span>}</span></span><button aria-label={`Remove ${root} from library`} disabled={scanning} onClick={(event) => { event.stopPropagation(); onRemove(root); }}><Trash2 size={16}/></button></div>) : <p className="mobile-folder-empty">No music folders added yet.</p>}<button className="mobile-folder-add" disabled={scanning} onClick={onAdd}><Plus size={15}/>{scanning ? "Scanning…" : "Add music folder"}</button></div>}</div>}
      {refreshMatches && row(<RefreshCw size={21}/>, "Refresh library", scanning ? "Scanning your music…" : "Look for new songs and artwork.", scanning ? <span className="mobile-settings-spinner"/> : <ChevronRight size={18}/>, scanning ? undefined : onRefresh)}
      {downloadsMatches && row(<Download size={21}/>, "Download location", "Music / MichoPlay / YouTube", <span className="mobile-settings-value">Phone</span>)}
      {hiddenMatches && <div className={`mobile-hidden-songs ${hiddenSongsOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button mobile-hidden-songs-toggle" aria-expanded={hiddenSongsOpen} onClick={() => setHiddenSongsOpen((open) => !open)}><EyeOff size={21}/><span><strong>Hidden songs</strong><small>{hiddenTracks.length ? `${hiddenTracks.length} hidden` : "Manage songs hidden from your library."}</small></span><span className="mobile-settings-row-trailing">{hiddenSongsOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{hiddenSongsOpen && <div className="mobile-hidden-songs-panel"><label className="mobile-hidden-search"><Search size={16}/><input aria-label="Search hidden songs" placeholder="Search hidden songs" value={hiddenSongsSearch} onChange={(event) => setHiddenSongsSearch(event.target.value)}/>{hiddenSongsSearch && <button aria-label="Clear hidden song search" onClick={() => setHiddenSongsSearch("")}><X size={15}/></button>}</label>{matchingHiddenTracks.map((track) => <div className="mobile-hidden-song" key={track.id}><span><strong>{track.title}</strong><small>{track.artist}</small></span><button aria-label={`Restore ${track.title}`} onClick={() => onRestoreTrack(track.id)}><Eye size={16}/>Restore</button></div>)}{!matchingHiddenTracks.length && <p className="mobile-hidden-empty">{hiddenTracks.length ? "No hidden songs match your search." : "No hidden songs."}</p>}</div>}</div>}
    </>, libraryVisible)}
    {section("Look & feel", <>
      {appearanceMatches && row(<Settings2 size={21}/>, "Keep screen awake", "Keep the display on while you listen.", toggle("Keep screen awake", keepScreenAwake, onKeepScreenAwake))}
      {appearanceMatches && row(<List size={21}/>, "Compact song list", "Fit more songs on the library screen.", toggle("Compact song list", compact, onCompact))}
      {zoomMatches && <div className={`mobile-settings-row mobile-settings-zoom ${zoomOpen ? "expanded" : ""}`}><button className="mobile-settings-row-button" aria-expanded={zoomOpen} onClick={() => setZoomOpen((open) => !open)}><Maximize2 size={21}/><span><strong>Zoom level</strong><small>{zoomLevel}% · Adjust the size of the app interface.</small></span><span className="mobile-settings-row-trailing"><span className="mobile-settings-value">{zoomLevel}%</span>{zoomOpen ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}</span></button>{zoomOpen && <div className="mobile-zoom-panel"><div className="mobile-zoom-presets"><button className={zoomLevel === 70 ? "selected" : ""} onClick={() => onZoom(70)}>Dense</button><button className={zoomLevel === 120 ? "selected" : ""} onClick={() => onZoom(120)}>Default</button><button className={zoomLevel === 130 ? "selected" : ""} onClick={() => onZoom(130)}>Spacious</button></div><input className="mobile-zoom-range" type="range" min="70" max="130" step="10" value={zoomLevel} aria-label="Zoom level" style={{ "--zoom-progress": `${(zoomLevel - 70) / 60 * 100}%` } as CSSProperties} onChange={(event) => onZoom(Number(event.target.value))}/><div className="mobile-zoom-ticks" aria-hidden="true">{[70, 80, 90, 100, 110, 120, 130].map((value) => <span key={value} className={zoomLevel === value ? "active" : ""}>{value}%</span>)}</div><button className="mobile-zoom-reset" onClick={() => onZoom(120)}>Reset to default</button></div>}</div>}
    </>, appearanceVisible)}
    {section("About", <>{aboutMatches && row(<AudioLines size={21}/>, "About MichoPlay", `Version ${packageInfo.version}`, <ChevronRight size={18}/>, onAbout)}</>, aboutVisible)}
    {query.trim() && !playbackVisible && !libraryVisible && !appearanceVisible && !aboutVisible && <div className="mobile-settings-empty"><Search size={25}/><strong>No settings found</strong><span>Try a different word.</span></div>}
  </div>;
}

export function MobileAboutPage({ version, onBack, onOpenUrl, onShare }: { version: string; onBack: () => void; onOpenUrl: (url: string) => void; onShare: () => void }) {
  useEffect(() => {
    document.querySelector<HTMLElement>(".content-scroll")?.scrollTo({ top: 0, behavior: "auto" });
  }, []);
  return <div className="mobile-about-page">
    <header className="mobile-about-header"><button aria-label="Back to settings" onClick={onBack}><ChevronLeft size={27}/></button><h1>About</h1></header>
    <section className="mobile-about-hero">
      <div className="mobile-about-mark"><AudioLines size={46}/></div>
      <h2>MichoPlay</h2>
      <span className="mobile-about-version">Version {version}</span>
      <div className="mobile-about-actions"><button onClick={() => onOpenUrl(michoplayGithubUrl)}><Github size={18}/>GitHub</button><button onClick={() => onOpenUrl(michoplayIssueUrl)}><Bug size={18}/>Report issue</button></div>
    </section>
    <section className="mobile-about-section"><h2>Links</h2><div className="mobile-about-links"><button onClick={() => onOpenUrl(michoplayDeveloperUrl)}><Globe2 size={19}/><span><strong>Developer</strong></span><ChevronRight size={18}/></button><button onClick={() => onOpenUrl(michoplayWebsiteUrl)}><AudioLines size={19}/><span><strong>Website</strong></span><ChevronRight size={18}/></button><button onClick={onShare}><Share2 size={19}/><span><strong>Share App</strong></span><ChevronRight size={18}/></button></div></section>
   
  </div>;
}

export function SettingsPage({ roots, player, equalizerBands, equalizerEnabled, compact, showPanel, keepScreenAwake, hiddenTracks, onRestoreTrack, onKeepScreenAwake, globalYoutubeSearchEnabled, onGlobalYoutubeSearch, scanning, mobile, zoomLevel, onZoom, onEqualizer, onEqualizerPreview, onEqualizerToggle, onCompact, onPanel, onAdd, onRemove, onRefresh, onVolume, onAutoplay, onSleepTimer, onDefaultPlayer }: { roots: string[]; player: PlayerSnapshot; equalizerBands: number[]; equalizerEnabled: boolean; compact: boolean; showPanel: boolean; keepScreenAwake: boolean; hiddenTracks: Track[]; onRestoreTrack: (id: number) => void; onKeepScreenAwake: (value: boolean) => void; globalYoutubeSearchEnabled: boolean; onGlobalYoutubeSearch: (value: boolean) => void; scanning: boolean; mobile: boolean; zoomLevel: number; onZoom: (value: number) => void; onEqualizer: (bands: number[]) => void; onEqualizerPreview: (bands: number[]) => void | Promise<unknown>; onEqualizerToggle: (enabled: boolean) => void; onCompact: (value: boolean) => void; onPanel: (value: boolean) => void; onAdd: () => void; onRemove: (root: string) => void; onRefresh: () => void; onVolume: (value: number) => void; onAutoplay: (value: boolean) => void; onSleepTimer: (minutes: number | null, atTrackEnd: boolean) => void; onDefaultPlayer: () => void }) {
  const timerValue = player.sleepTimerAtTrackEnd ? "track" : player.sleepTimerRemainingMs ? String(Math.max(1, Math.ceil(player.sleepTimerRemainingMs / 60_000 / 15) * 15)) : "off";
  const remaining = player.sleepTimerRemainingMs == null ? "" : `${Math.floor(player.sleepTimerRemainingMs / 60_000)}:${String(Math.floor((player.sleepTimerRemainingMs % 60_000) / 1000)).padStart(2, "0")}`;
  const [hiddenSongsOpen, setHiddenSongsOpen] = useState(false);
  const [hiddenSongsSearch, setHiddenSongsSearch] = useState("");
  const matchingHiddenTracks = hiddenTracks.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(hiddenSongsSearch.trim().toLocaleLowerCase()));
  const toggle = (title: string, description: string, value: boolean, change: (value: boolean) => void) => <div className="setting-row"><div><strong>{title}</strong><small>{description}</small></div><button className={`switch ${value ? "on" : ""}`} role="switch" aria-label={title} aria-checked={value} onClick={() => change(!value)}><span/></button></div>;
  return <div className="settings-page"><div className="settings-title"><h1>Settings</h1></div><section className="settings-group"><h2>Playback</h2>{toggle("Autoplay", "Continue with the next song when playback ends.", player.autoplay, onAutoplay)}{!mobile && toggle("YouTube in global search", "Include online YouTube matches alongside songs in your library.", globalYoutubeSearchEnabled, onGlobalYoutubeSearch)}
    <EqualizerSettings bands={equalizerBands} enabled={equalizerEnabled} onChange={onEqualizer} onPreview={onEqualizerPreview} onToggle={onEqualizerToggle}/><div className="setting-row sleep-timer-row"><div><strong>Sleep timer</strong><small>{player.sleepTimerAtTrackEnd ? "Playback will stop at the end of this song." : remaining ? `Playback stops in ${remaining}.` : "Stop playback after a set time or at the end of a song."}</small></div><select className="sleep-timer-select" aria-label="Sleep timer" value={timerValue} onChange={(event) => { const value = event.target.value; onSleepTimer(value === "off" || value === "track" ? null : Number(value), value === "track"); }}><option value="off">Off</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="track" disabled={!player.currentTrackId}>End of current song</option></select></div>
    {mobile && <div className="setting-row"><div><strong>Background playback</strong><small>Keep playing with lock-screen and notification controls.</small></div><span className="setting-value">On</span></div>}<div className="setting-row"><div><strong>Volume</strong><small>Audio output level</small></div><div className="settings-volume"><input type="range" min="0" max="1" step="0.01" value={player.volume} style={{ "--range-value": `${player.volume * 100}%` } as CSSProperties} aria-label="Playback volume" onChange={(event) => onVolume(Number(event.target.value))}/><span className="setting-value">{Math.round(player.volume * 100)}%</span></div></div></section>
    <section className="settings-group zoom-settings"><h2>Zoom level</h2><p className="zoom-description">Adjusting the zoom level can help you make the most of MichoPlay and adapt it to your preferences or needs.</p><p className="zoom-shortcuts">Keyboard controls are listed below.</p><div className="zoom-control"><div className="zoom-landmarks"><button className="zoom-landmark" onClick={() => onZoom(70)} aria-label="Set zoom to 70 percent"><span className="zoom-preview dense" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i}/>)}</span><span>Dense</span></button><button className="zoom-landmark" onClick={() => onZoom(mobile ? 120 : 100)} aria-label={`Set zoom to ${mobile ? 120 : 100} percent`}><span className="zoom-preview default" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i}/>)}</span><span>Default</span></button><button className="zoom-landmark" onClick={() => onZoom(130)} aria-label="Set zoom to 130 percent"><span className="zoom-preview spacious" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</span><span>Spacious</span></button></div><input className="zoom-range" type="range" min="70" max="130" step="10" value={zoomLevel} style={{ "--zoom-progress": `${(zoomLevel - 70) / 60 * 100}%` } as CSSProperties} aria-label="Zoom level" aria-valuetext={`${zoomLevel}%`} onChange={(event) => onZoom(Number(event.target.value))}/><div className="zoom-ticks" aria-hidden="true">{[70, 80, 90, 100, 110, 120, 130].map((value) => <span key={value} className={zoomLevel === value ? "active" : ""}>{value}%</span>)}</div><div className="zoom-reset-row"><button className="outline-button" onClick={() => onZoom(mobile ? 120 : 100)}>Reset</button></div></div></section>
    <section className="settings-group shortcuts-settings"><h2>Keyboard shortcuts</h2><div className="shortcut-list">{keyboardShortcuts.map(({ action, keys }) => <div className="shortcut-row" key={action}><span>{action}</span><span className="shortcut-keys">{keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}</span></div>)}</div></section><section className="settings-group"><h2>Your library</h2><div className="setting-row"><div><strong>Music folders</strong><small>{mobile ? "MichoPlay reads songs from their original folders. Only metadata and artwork are cached." : "Music is scanned recursively inside each root."}</small></div><button className="outline-button" disabled={scanning} onClick={onAdd}><Plus size={15}/>Add folder</button></div>{roots.map((root) => <div className="root-row" key={root}><FolderOpen size={17}/><span title={root}>{root}</span><button className="icon-button" disabled={scanning} aria-label={`Remove ${root} from library`} onClick={() => onRemove(root)}><Trash2 size={15}/></button></div>)}{!roots.length && <p className="no-roots">No music folders added.</p>}<button className="outline-button refresh-button" disabled={scanning || !roots.length} onClick={onRefresh}><RefreshCw size={14}/>{scanning ? "Refreshing…" : "Refresh library"}</button></section><section className="settings-group hidden-songs-settings"><button className="hidden-songs-toggle" aria-expanded={hiddenSongsOpen} onClick={() => setHiddenSongsOpen((open) => !open)}><span><strong>Hidden songs</strong><small>{hiddenTracks.length} {hiddenTracks.length === 1 ? "song" : "songs"} hidden</small></span>{hiddenSongsOpen ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button>{hiddenSongsOpen && <div className="hidden-songs-panel"><label className="settings-hidden-search"><Search size={15}/><input aria-label="Search hidden songs" placeholder="Search hidden songs" value={hiddenSongsSearch} onChange={(event) => setHiddenSongsSearch(event.target.value)}/>{hiddenSongsSearch && <button aria-label="Clear hidden song search" onClick={() => setHiddenSongsSearch("")}><X size={14}/></button>}</label>{matchingHiddenTracks.map((track) => <div className="hidden-song-row" key={track.id}><span><strong>{track.title}</strong><small>{track.artist} - {track.album}</small></span><button className="outline-button" onClick={() => onRestoreTrack(track.id)}><Eye size={15}/>Restore</button></div>)}{!matchingHiddenTracks.length && <p className="no-roots">{hiddenTracks.length ? "No hidden songs match your search." : "No hidden songs."}</p>}</div>}</section><section className="settings-group"><h2>System integration</h2><div className="setting-row"><div><strong>Default music player</strong><small>{mobile ? "Choose MichoPlay from Android’s Open with menu, then select Always to make it the default." : "MichoPlay can open audio files from your file manager. Installed desktop builds register common audio formats."}</small></div><button className="outline-button" onClick={onDefaultPlayer}>{mobile ? "How to set default" : "Set as default"}</button></div></section><section className="settings-group"><h2>Display</h2>{toggle("Now playing panel", "Show artwork and the adjustable playback queue.", showPanel, onPanel)}{toggle("Keep screen awake in full mode", "Prevent the display from sleeping while the full player is open. Off by default.", keepScreenAwake, onKeepScreenAwake)}{toggle("Compact song list", "Fit more songs in the library view.", compact, onCompact)}</section></div>;
}
