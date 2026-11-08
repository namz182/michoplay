import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { saveStoredData, stored } from "../../lib/storage";

const equalizerFrequencies = ["60Hz", "150Hz", "400Hz", "1KHz", "2.4KHz", "15KHz"];
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

