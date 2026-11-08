import type { CSSProperties } from "react";
import { Volume2, VolumeX } from "lucide-react";

export function VolumeControl({ volume, onChange, onToggleMute }: {
  volume: number;
  onChange: (volume: number) => void;
  onToggleMute: () => void;
}) {
  return <>
    <button className="volume-mute-button" aria-label={volume === 0 ? "Unmute" : "Mute"} title={volume === 0 ? "Unmute" : "Mute"} onClick={onToggleMute}>
      {volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
    </button>
    <input type="range" min="0" max="1" step="0.01" value={volume} style={{ "--range-value": `${volume * 100}%` } as CSSProperties} aria-label="Volume" onChange={(event) => onChange(Number(event.target.value))} />
  </>;
}
