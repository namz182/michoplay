import type { YoutubeDownload } from "../../lib/api";
import { formatYoutubeFileSize, youtubeDownloadErrorText } from "../../lib/youtube-size";

function formatEta(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function youtubeDownloadDescription(item: YoutubeDownload) {
  if (item.status === "failed") return youtubeDownloadErrorText(item.message, item.isPlaylist);
  if (item.status === "cancelled") return "Cancelled";
  if (item.status === "completed") return <><span>{formatYoutubeFileSize(item.downloadedBytes ?? item.totalBytes ?? 0)}</span><span className="download-completed-inline"> · Completed</span></>;

  const pending = youtubeDownloadIsPending(item);
  const finishing = item.status === "downloading" && !pending && item.phase !== "downloading";
  const details: string[] = pending ? [] : [`${Number((item.percent ?? 0).toFixed(1))}%`];
  if (item.downloadedBytes !== null) {
    details.push(item.totalBytes !== null && item.totalBytes > 0
      ? `${formatYoutubeFileSize(item.downloadedBytes)} / ${item.totalBytesEstimated ? "~" : ""}${formatYoutubeFileSize(item.totalBytes)}`
      : `${formatYoutubeFileSize(item.downloadedBytes)} transferred`);
  }
  if (item.phase === "downloading" && item.speedBytesPerSecond !== null && item.speedBytesPerSecond > 0) {
    details.push(`${formatYoutubeFileSize(item.speedBytesPerSecond)}/s`);
  }
  if (item.phase === "downloading" && item.etaSeconds !== null && item.etaSeconds >= 0) details.push(`ETA ${formatEta(item.etaSeconds)}`);
  if (item.status === "paused") details.unshift("Paused");
  return pending
    ? <span className="download-pending-label">{["Pending…", ...details].join(" · ")}</span>
    : finishing
      ? <span className="download-pending-label">{["Finishing…", ...details].join(" · ")}</span>
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
