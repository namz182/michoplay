import type { YoutubeDownload } from "../../lib/api";
import { formatYoutubeFileSize, youtubeDownloadErrorText } from "../../lib/youtube-size";

export function youtubeDownloadDescription(item: YoutubeDownload) {
  if (item.status === "failed") return youtubeDownloadErrorText(item.message, item.isPlaylist);
  if (item.status === "cancelled") return "Cancelled";
  if (item.status === "paused") return "Paused · Resume when you're ready";
  if (item.status === "completed") return <><span>{formatYoutubeFileSize(item.downloadedBytes ?? item.totalBytes ?? 0)}</span><span className="download-completed-inline"> · Completed</span></>;

  const pending = youtubeDownloadIsPending(item);
  const finishing = item.status === "downloading" && !pending && item.phase !== "downloading";
  const details: string[] = pending ? [] : [`${Number((item.percent ?? 0).toFixed(1))}%`];
  if (item.downloadedBytes !== null && item.totalBytes !== null && item.totalBytes > 0) {
    details.push(`${formatYoutubeFileSize(item.downloadedBytes)} / ${item.totalBytesEstimated ? "~" : ""}${formatYoutubeFileSize(item.totalBytes)}`);
  }
  if (item.status === "downloading" && item.phase === "downloading") {
    if (item.speedBytesPerSecond != null && item.speedBytesPerSecond > 0)
      details.push(`${formatYoutubeFileSize(item.speedBytesPerSecond)}/s`);
    if (item.etaSeconds != null && item.etaSeconds >= 0) {
      const seconds = Math.ceil(item.etaSeconds);
      details.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`);
    }
  }
  return pending
    ? <span className="download-pending-label">{item.message || "Waiting to download…"}</span>
    : finishing
      ? <span className="download-pending-label">{[item.message || "Finishing…", ...details].join(" · ")}</span>
    : details.join(" · ");
}

export function youtubeDownloadProgress(item: YoutubeDownload) {
  if (item.status === "completed") return 100;
  if (item.status === "downloading" || item.status === "paused") return item.percent ?? 0;
  return 0;
}

export function youtubeDownloadIsPending(item: YoutubeDownload) {
  return (item.status === "queued" || item.status === "downloading") &&
    (item.status === "queued" || item.percent === null);
}
