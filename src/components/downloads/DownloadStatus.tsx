import type { YoutubeDownload } from "../../lib/api";
import { formatYoutubeFileSize, youtubeDownloadErrorText } from "../../lib/youtube-size";

export function youtubeDownloadDescription(item: YoutubeDownload) {
  if (item.status === "failed") return youtubeDownloadErrorText(item.message, item.isPlaylist);
  if (item.status === "cancelled") return "Cancelled";
  if (item.status === "completed") return <><span>{formatYoutubeFileSize(item.downloadedBytes ?? item.totalBytes ?? 0)}</span><span className="download-completed-inline"> · Completed</span></>;

  const pending = youtubeDownloadIsPending(item);
  const finishing = item.status === "downloading" && !pending && item.phase !== "downloading";
  const details: string[] = pending ? [] : [`${Number((item.percent ?? 0).toFixed(1))}%`];
  if (item.downloadedBytes !== null && item.totalBytes !== null && item.totalBytes > 0) {
    details.push(`${formatYoutubeFileSize(item.downloadedBytes)} / ${item.totalBytesEstimated ? "~" : ""}${formatYoutubeFileSize(item.totalBytes)}`);
  }
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
