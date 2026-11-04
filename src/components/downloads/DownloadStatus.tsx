import type { YoutubeDownload } from "../../lib/api";
import { youtubeDownloadErrorText, youtubeDownloadProgressText } from "../../lib/youtube-size";

export function youtubeDownloadDescription(item: YoutubeDownload) {
  const loadingLabel = item.status === "queued" ? "Pending…"
    : item.status === "downloading" && item.percent === null && !(item.downloadedBytes && item.downloadedBytes > 0) ? "Preparing download…"
    : null;

  if (loadingLabel) {
    return <span className="download-pending-label">{loadingLabel}</span>;
  }
  if (item.status === "downloading" && (item.percent ?? 0) >= 100) return "Processing audio…";
  if (["downloading", "paused", "completed"].includes(item.status)) return youtubeDownloadProgressText(item);
  if (item.status === "failed") return youtubeDownloadErrorText(item.message, item.isPlaylist);
  return item.message;
}
