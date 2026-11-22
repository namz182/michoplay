import { MoreVertical, Music2, Pause, Play, X } from "lucide-react";
import type { MouseEvent } from "react";
import type { YoutubeDownload } from "../../lib/api";
import { youtubeDownloadDescription, youtubeDownloadIsPending, youtubeDownloadProgress } from "./DownloadStatus";

export function DownloadCard({ item, onControl, onPlay, onMenu }: {
  item: YoutubeDownload;
  onControl: (id: string, action: "pause" | "cancel" | "resume" | "remove") => void;
  onPlay: (item: YoutubeDownload) => void;
  onMenu: (item: YoutubeDownload, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const pending = youtubeDownloadIsPending(item);
  const progress = youtubeDownloadProgress(item);
  const active = item.status === "queued" || item.status === "downloading";
  const resumable = item.status === "paused" || item.status === "failed";
  return <article className={`download-item status-${item.status}`} data-download-id={item.id}>
    <div className="download-item-main">
      <div className="download-item-art">
        <Music2 size={22} aria-hidden="true" />
        {item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        {item.status === "completed" && <button className="download-art-play" aria-label={`Play ${item.title}`} onClick={() => onPlay(item)}><Play size={16} fill="currentColor" /></button>}
      </div>
      <div className="download-item-copy">
        <strong title={item.title}>{item.title}</strong>
        <small>{youtubeDownloadDescription(item)}</small>
      </div>
    </div>
    <div className="download-item-progress" role="progressbar" aria-label={`Download progress for ${item.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pending ? undefined : progress} aria-valuetext={pending ? item.message : `${Math.round(progress)}%`}>
      <span className={pending ? "is-pending" : ""} style={{ width: `${progress}%` }} />
    </div>
    <div className="download-item-actions">
      <span className={`download-status-label ${item.status}`}>{item.status === "completed" ? null : item.status}</span>
      {item.status === "completed" ? <button className="icon-button download-menu-trigger" aria-label={`More actions for ${item.title}`} onClick={(event) => onMenu(item, event)}><MoreVertical size={18} /></button> : <>
        {active && <button className="icon-button" aria-label={`Pause ${item.title}`} onClick={() => onControl(item.id, "pause")}><Pause size={17} /></button>}
        {resumable && <button className="icon-button" aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => onControl(item.id, "resume")}><Play size={17} /></button>}
        <button className="icon-button" aria-label={`${active || item.status === "paused" ? "Cancel" : "Remove"} ${item.title}`} onClick={() => onControl(item.id, active || item.status === "paused" ? "cancel" : "remove")}><X size={17} /></button>
      </>}
    </div>
  </article>;
}
