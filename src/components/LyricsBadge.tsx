export function LyricsBadge({ title = "Lyrics available" }: { title?: string }) {
  return <span className="lyrics-badge" aria-label="Lyrics available" title={title}>C</span>;
}
