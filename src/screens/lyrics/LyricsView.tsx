import { useEffect, useMemo, useRef } from "react";
import { Maximize2, X } from "lucide-react";
import { Cover } from "../../app/Artwork";
import type { Track } from "../../lib/api";

type Line = { timeMs: number; text: string };
function sentenceCaseLyric(value: string) {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase());
  return normalized.replace(/(^|[^\p{L}\p{N}_])i(?=$|[^\p{L}\p{N}_])/gu, "$1I");
}
function parseLrc(text: string): Line[] {
  const lines: Line[] = [];
  for (const row of text.split(/\r?\n/)) {
    const matches = [
      ...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g),
    ];
    const lyric = row
      .replace(/\[[^\]]+\]/g, "")
      .replace(/[♪♫♬♩]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    for (const match of matches) {
      const fraction = (match[3] ?? "0").padEnd(3, "0").slice(0, 3);
      lines.push({
        timeMs:
          (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction),
        text: sentenceCaseLyric(lyric),
      });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function LyricsView({
  track,
  text,
  positionMs,
  expanded = false,
  preview = false,
  onExpand,
  onClose,
  onSeek,
}: {
  track: Track;
  text: string;
  positionMs: number;
  expanded?: boolean;
  preview?: boolean;
  onExpand?: () => void;
  onClose?: () => void;
  onSeek?: (positionMs: number) => void;
}) {
  const lines = useMemo(() => parseLrc(text), [text]);
  const active = lines.reduce(
    (index, line, lineIndex) => (line.timeMs <= positionMs ? lineIndex : index),
    -1,
  );
  const activeRef = useRef<HTMLParagraphElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview || !activeRef.current || !scrollRef.current) return;
    const activeLine = activeRef.current.getBoundingClientRect();
    const list = scrollRef.current;
    const listBounds = list.getBoundingClientRect();
    const lineTop = list.scrollTop + activeLine.top - listBounds.top;
    const centeredTop = lineTop - (list.clientHeight - activeLine.height) / 2;
    list.scrollTop = centeredTop;
  }, [active, preview]);
  const visibleLines = preview
    ? lines.slice(Math.max(0, active), Math.max(0, active) + 1)
    : lines;
  if (preview) {
    const currentLine = lines[Math.max(0, active)];
    return (
      <button
        className="lyrics-current-preview"
        type="button"
        aria-label={`Open lyrics for ${track.title}`}
        onClick={onExpand}
      >
        {currentLine?.text ?? "Lyrics available · Tap to open"}
      </button>
    );
  }
  return (
    <section
      className={`lyrics-view ${expanded ? "expanded" : ""} ${preview ? "preview" : ""}`}
      aria-label={`Lyrics for ${track.title}`}
    >
      <div className="lyrics-backdrop">
        <Cover className="lyrics-backdrop-art" keys={[track.artworkKey]} />
      </div>
      <header className="lyrics-heading">
        <div>
          <strong>Lyrics</strong>
        </div>
        {(onClose || onExpand) && (
          <div className="lyrics-actions">
            {onClose && (
              <button
                aria-label="Close lyrics"
                title="Close lyrics"
                onClick={onClose}
              >
                <X size={18} />
              </button>
            )}
            {onExpand && (
              <button
                aria-label="Expand lyrics"
                title="Expand lyrics"
                onClick={onExpand}
              >
                <Maximize2 size={17} />
              </button>
            )}
          </div>
        )}
      </header>
      <div ref={scrollRef} className="lyrics-scroll" aria-live="polite">
        {lines.length ? (
          visibleLines.map((line, offset) => {
            const index = preview ? Math.max(0, active) + offset : offset;
            return (
              <p
                key={`${line.timeMs}-${index}`}
                ref={index === active ? activeRef : undefined}
                className={
                  index === active ? "active" : index < active ? "past" : ""
                }
                role={onSeek ? "button" : undefined}
                tabIndex={onSeek ? 0 : undefined}
                onClick={onSeek ? () => onSeek(line.timeMs) : undefined}
                onKeyDown={
                  onSeek
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSeek(line.timeMs);
                        }
                      }
                    : undefined
                }
              >
                {line.text}
              </p>
            );
          })
        ) : (
          <div className="lyrics-unavailable">
            <strong>Lyrics aren’t available</strong>
            <span>
              Add lyrics metadata or a matching .lrc file beside this audio
              file.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
