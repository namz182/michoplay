import { useEffect, useRef, useState } from "react";
import { Timer } from "lucide-react";
import type { PlayerSnapshot } from "../../lib/api";

export function sleepTimerLabel(ms: number) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function SleepTimerControl({
  player,
  onSet,
  placement,
}: {
  player: PlayerSnapshot;
  onSet: (minutes: number | null, atTrackEnd: boolean) => void;
  placement: "bar" | "full-mode";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = player.sleepTimerAtTrackEnd || player.sleepTimerRemainingMs !== null;
  const currentMinutes = player.sleepTimerRemainingMs === null
    ? null
    : Math.ceil(player.sleepTimerRemainingMs / 900_000) * 15;
  const label = player.sleepTimerAtTrackEnd
    ? "Track end"
    : player.sleepTimerRemainingMs !== null
      ? sleepTimerLabel(player.sleepTimerRemainingMs)
      : "Sleep";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useEffect(() => {
    if (placement === "bar" && player.sleepTimerRemainingMs === null) setOpen(false);
  }, [placement, player.sleepTimerRemainingMs]);
  if (placement === "bar" && player.sleepTimerRemainingMs === null) return null;
  const choose = (minutes: number | null, atTrackEnd = false) => { onSet(minutes, atTrackEnd); setOpen(false); };

  return (
    <div className={`sleep-timer-control ${placement}`} ref={root}>
      <button className={`sleep-timer-trigger ${active ? "active" : ""}`} aria-label={active ? `Sleep timer: ${label}` : "Set sleep timer"} aria-haspopup="menu" aria-expanded={open} title={active ? `Sleep timer: ${label}` : "Set sleep timer"} onClick={() => setOpen((value) => !value)}>
        <Timer size={15} /><span>{label}</span>
      </button>
      {open && <div className="sleep-timer-menu" role="menu" aria-label="Sleep timer options">
        <strong>{active ? `Sleep in ${label}` : "Stop playback"}</strong>
        <button role="menuitemradio" aria-checked={!active} onClick={() => choose(null)}>Off</button>
        {[[15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"]].map(([minutes, text]) => (
          <button key={minutes} role="menuitemradio" aria-checked={!player.sleepTimerAtTrackEnd && currentMinutes === minutes} onClick={() => choose(Number(minutes))}>{text}</button>
        ))}
        <button role="menuitemradio" aria-checked={player.sleepTimerAtTrackEnd} disabled={!player.currentTrackId} onClick={() => choose(null, true)}>End of current song</button>
      </div>}
    </div>
  );
}
