import { useEffect, useMemo, useRef } from "react";
import { Cover } from "../../app/Artwork";
import type { Track } from "../../lib/api";

type Line = { timeMs: number; text: string };
function parseLrc(text: string): Line[] {
  const lines: Line[] = [];
  for (const row of text.split(/\r?\n/)) {
    const matches = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const lyric = row.replace(/\[[^\]]+\]/g, "").trim();
    for (const match of matches) {
      const fraction = (match[3] ?? "0").padEnd(3, "0").slice(0, 3);
      lines.push({ timeMs: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction), text: lyric });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function LyricsView({ track, text, positionMs, expanded = false, onExpand }: { track: Track; text: string; positionMs: number; expanded?: boolean; onExpand?: () => void }) {
  const lines = useMemo(() => parseLrc(text), [text]);
  const active = lines.reduce((index, line, lineIndex) => line.timeMs <= positionMs ? lineIndex : index, -1);
  const activeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }), [active]);
  return <section className={`lyrics-view ${expanded ? "expanded" : ""}`} aria-label={`Lyrics for ${track.title}`}>
    <div className="lyrics-backdrop"><Cover className="lyrics-backdrop-art" keys={[track.artworkKey]}/></div>
    <header className="lyrics-heading"><div><strong>Lyrics</strong><span>{track.title} · {track.artist}</span></div>{onExpand && <button aria-label={expanded ? "Close full lyrics" : "Expand lyrics"} onClick={onExpand}>{expanded ? "Close" : "⤢"}</button>}</header>
    <div className="lyrics-scroll" aria-live="polite">{lines.length ? lines.map((line, index) => <p key={`${line.timeMs}-${index}`} ref={index === active ? activeRef : undefined} className={index === active ? "active" : index < active ? "past" : ""}>{line.text || "♪"}</p>) : <div className="lyrics-unavailable"><strong>Lyrics aren’t available</strong><span>Add a matching .lrc file beside this audio file to show synchronized lyrics.</span></div>}</div>
  </section>;
}
