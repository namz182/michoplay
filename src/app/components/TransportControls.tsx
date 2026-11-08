import { Mic2, Pause, Play, Shuffle, SkipBack, SkipForward } from "lucide-react";
import type { PlayerSnapshot } from "../../lib/api";

type Props = {
  layout: "bar" | "full";
  player: PlayerSnapshot;
  disabled?: boolean;
  lyricsActive?: boolean;
  onShuffle: () => void;
  onPrevious: () => void;
  onToggle: () => void;
  onNext: () => void;
  onRepeat: () => void;
  onLyrics?: () => void;
};

export function TransportControls({ layout, player, disabled = false, lyricsActive = false, onShuffle, onPrevious, onToggle, onNext, onRepeat, onLyrics }: Props) {
  const full = layout === "full";
  return <div className={full ? "full-mode-transport" : "transport-buttons"}>
    <button className={full ? `full-mode-control ${player.shuffle ? "active" : ""}` : `transport-button shuffle-control ${player.shuffle ? "active" : ""}`} aria-label="Shuffle" disabled={disabled} onClick={onShuffle}><Shuffle size={full ? 19 : 15}/></button>
    <button className={full ? "full-mode-control" : "transport-button"} aria-label="Previous track" disabled={disabled} onClick={onPrevious}><SkipBack size={full ? 22 : 17} fill="currentColor"/></button>
    <button className={full ? "full-mode-play" : `play-button ${player.isPlaying ? "is-playing" : ""}`} aria-label={player.isPlaying ? "Pause" : "Play"} disabled={disabled} onClick={onToggle}>{player.isPlaying ? <Pause size={full ? 23 : 16} fill="currentColor"/> : <Play size={full ? 23 : 15} fill="currentColor"/>}</button>
    <button className={full ? "full-mode-control" : "transport-button"} aria-label="Next track" disabled={disabled} onClick={onNext}><SkipForward size={full ? 22 : 17} fill="currentColor"/></button>
    <button className={full ? `full-mode-control ${player.repeatMode !== "off" ? "active" : ""}` : `transport-button repeat-button repeat-control ${player.repeatMode !== "off" ? "active" : ""}`} aria-label={`Repeat ${player.repeatMode}`} disabled={disabled} onClick={onRepeat}>↻{player.repeatMode === "one" && <small>1</small>}</button>
    {full && onLyrics && <button className={`full-mode-control ${lyricsActive ? "active" : ""}`} aria-label={lyricsActive ? "Show artwork" : "Show lyrics"} title={lyricsActive ? "Show artwork" : "Lyrics"} onClick={onLyrics}><Mic2 size={19}/></button>}
  </div>;
}
