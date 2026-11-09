import { ChevronDown, ListMusic, MoreVertical, Pause, Play, X } from "lucide-react";
import type { MouseEvent } from "react";
import type { YoutubeDownload } from "../../lib/api";
import { youtubeDownloadIsPending, youtubeDownloadProgress } from "./DownloadStatus";

type Action = "pause" | "cancel" | "resume" | "remove";

export function PlaylistDownloadProgress({ downloads, onControl, onPlay, onMenu }: {
  downloads: YoutubeDownload[];
  onControl: (id: string, action: Action) => void;
  onPlay: (item: YoutubeDownload) => void;
  onMenu: (item: YoutubeDownload, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const groups = new Map<string, YoutubeDownload[]>();
  for (const item of downloads) {
    if (!item.playlist) continue;
    const rows = groups.get(item.playlist.id) ?? [];
    rows.push(item);
    groups.set(item.playlist.id, rows);
  }
  return <div className="playlist-download-groups">
    {[...groups.entries()].map(([key, rows]) => {
      rows.sort((a, b) => (a.playlist?.index ?? 0) - (b.playlist?.index ?? 0));
      const total = rows[0]?.playlist?.total ?? rows.length;
      const progress = rows.reduce((sum, item) => sum + (item.status === "completed" ? 100 : item.status === "downloading" ? youtubeDownloadProgress(item) : 0), 0) / Math.max(total, 1);
      const completed = rows.filter((item) => item.status === "completed").length;
      const active = rows.filter((item) => item.status === "downloading" || item.status === "queued").length;
      return <details className="playlist-download-group" key={key}>
        <summary>
          <span className="playlist-download-icon"><ListMusic size={18}/></span>
          <span className="playlist-download-summary-copy"><strong>{rows[0]?.playlist?.title ?? "Playlist"}</strong><small>{completed}/{total} songs{active ? ` · ${active} active` : ""}</small><span className="playlist-download-progress"><i style={{ width: `${Math.min(progress, 100)}%` }}/></span></span>
          <ChevronDown size={17} className="playlist-download-chevron"/>
        </summary>
        <div className="playlist-download-tracks">
          {rows.map((item) => <div className={`playlist-download-track status-${item.status}`} key={item.id}>
            <span className="playlist-download-track-index">{item.playlist?.index}</span>
            <span className="playlist-download-track-copy"><strong>{item.title}</strong><small>{item.status === "downloading" && youtubeDownloadIsPending(item) ? "Starting…" : item.status === "completed" ? "Completed" : item.status === "failed" ? item.message : item.status}</small><span className="playlist-download-progress"><i className={youtubeDownloadIsPending(item) ? "is-pending" : ""} style={{ width: `${youtubeDownloadProgress(item)}%` }}/></span></span>
            <span className="playlist-download-track-actions">
              {item.status === "queued" || item.status === "downloading" ? <button aria-label={`Pause ${item.title}`} onClick={() => onControl(item.id, "pause")}><Pause size={14}/></button> : null}
              {item.status === "paused" || item.status === "failed" ? <button aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => onControl(item.id, "resume")}><Play size={14}/></button> : null}
              {item.status === "completed" ? <><button aria-label={`Play ${item.title}`} onClick={() => onPlay(item)}><Play size={14} fill="currentColor"/></button><button aria-label={`More actions for ${item.title}`} onClick={(event) => onMenu(item, event)}><MoreVertical size={14}/></button><span className="playlist-download-done" aria-label="Completed">✓</span></> : <button aria-label={`${item.status === "failed" || item.status === "cancelled" ? "Remove" : "Cancel"} ${item.title}`} onClick={() => onControl(item.id, item.status === "failed" || item.status === "cancelled" ? "remove" : "cancel")}><X size={14}/></button>}
            </span>
          </div>)}
        </div>
      </details>;
    })}
  </div>;
}
