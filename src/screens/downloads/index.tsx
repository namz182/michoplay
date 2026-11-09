import { FolderOpen, MoreVertical, Pause, Play, Trash2, X } from "lucide-react";
import type { MouseEvent } from "react";
import type { YoutubeDownload } from "../../lib/api";
import { youtubeDownloadDescription as description, youtubeDownloadIsPending, youtubeDownloadProgress } from "../../components/downloads/DownloadStatus";
import { PlaylistDownloadProgress } from "../../components/downloads/PlaylistDownloadProgress";

type DownloadAction = "pause" | "cancel" | "resume" | "remove";
export function MobileDownloadsScreen({ downloads, clearable, onClear, onControl, onPlay, onMenu, onOpenYoutube }: {
  downloads: YoutubeDownload[];
  clearable: boolean;
  onClear: () => void;
  onControl: (id: string, action: DownloadAction) => void;
  onPlay: (item: YoutubeDownload) => void;
  onMenu: (item: YoutubeDownload, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenYoutube: () => void;
}) {
  const activeCount = downloads.filter((item) => item.status === "downloading" || item.status === "queued").length;
  return <div className="mobile-downloads-page">
    <div className="mobile-downloads-destination"><FolderOpen size={14}/><span><strong>Download location</strong><small>Music / MichoPlay</small></span></div>
    <div className="section-title-row"><h2>Your downloads</h2><span>{activeCount} active</span>{clearable && <button className="download-clear-button" onClick={onClear}><Trash2 size={14}/>Clear</button>}</div>
    {downloads.length ? <><PlaylistDownloadProgress downloads={downloads} onControl={onControl} onPlay={onPlay} onMenu={onMenu}/><div className="mobile-download-list">{downloads.filter((item) => !item.playlist).map((item) => <article className={`mobile-download-row status-${item.status}`} key={item.id}>
      <div className="mobile-download-art">{item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/>}{item.status === "completed" && <button aria-label={`Play ${item.title}`} onClick={() => onPlay(item)}><Play size={16} fill="currentColor"/></button>}</div>
      <div className="mobile-download-copy"><strong>{item.title}</strong>{description(item) && <small>{description(item)}</small>}</div>
      <div className="mobile-download-progress-row"><div className="mobile-download-progress"><span className={youtubeDownloadIsPending(item) ? "is-pending" : ""} style={{ width: `${youtubeDownloadProgress(item)}%` }}/></div><div className="mobile-download-actions">{item.status === "downloading" || item.status === "queued" ? <><button aria-label={`Pause ${item.title}`} onClick={() => onControl(item.id, "pause")}><Pause size={17}/></button><button aria-label={`Cancel ${item.title}`} onClick={() => onControl(item.id, "cancel")}><X size={17}/></button></> : item.status === "paused" || item.status === "failed" ? <><button aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.title}`} onClick={() => onControl(item.id, "resume")}><Play size={17}/></button><button aria-label={`Remove ${item.title}`} onClick={() => onControl(item.id, "remove")}><X size={17}/></button></> : <button className="download-menu-trigger" aria-label={`More actions for ${item.title}`} onClick={(event) => onMenu(item, event)}><MoreVertical size={19}/></button>}</div></div>
    </article>)}</div></> : <div className="mobile-download-empty"><strong>No downloads yet</strong><span>Find a song in Search and tap Download. It will appear here.</span><button className="primary-button" onClick={onOpenYoutube}>Find music</button></div>}
  </div>;
}
