import { FolderOpen, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import type { YoutubeDownload } from "../../lib/api";
import { DownloadCard } from "../../components/downloads/DownloadCard";
import { DownloadProgressList } from "../../components/downloads/DownloadProgressList";

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
  return (
    <div className="mobile-downloads-page">
      <div className="mobile-downloads-destination">
        <FolderOpen size={14} />
        <span>
          <strong>Download location</strong>
          <small>Music / MichoPlay</small>
        </span>
      </div>
      <div className="section-title-row">
        <h2>Your downloads</h2>
        <span>{activeCount} active</span>
        {clearable && (
          <button className="download-clear-button" onClick={onClear}>
            <Trash2 size={14} />
            Clear
          </button>
        )}
      </div>
      {downloads.length ? (
        <div className="mobile-download-list">
          <DownloadProgressList
            downloads={downloads}
            onControl={onControl}
            onPlay={onPlay}
            onMenu={onMenu}
            renderSong={(item) => (
              <DownloadCard item={item} onControl={onControl} onPlay={onPlay} onMenu={onMenu} />
            )}
          />
        </div>
      ) : (
        <div className="mobile-download-empty">
          <strong>No downloads yet</strong>
          <span>
            Find a song in Search and tap Download. It will appear here.
          </span>
          <button className="primary-button" onClick={onOpenYoutube}>
            Find music
          </button>
        </div>
      )}
    </div>
  );
}
