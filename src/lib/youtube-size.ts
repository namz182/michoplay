import type { YoutubeDownload } from "./api";

export function formatYoutubeFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function estimateYoutubeDownloadBytes(durationSeconds: number | null, isPlaylist: boolean) {
  if (isPlaylist || durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.round(durationSeconds * 16_000);
}

export function youtubeResultSizeText(durationSeconds: number | null, isPlaylist: boolean) {
  if (isPlaylist) return "Size varies";
  const estimatedBytes = estimateYoutubeDownloadBytes(durationSeconds, false);
  return estimatedBytes === null ? "Size pending" : `~${formatYoutubeFileSize(estimatedBytes)} est.`;
}

export function youtubeDownloadProgressText(item: YoutubeDownload) {
  const parts: string[] = [];
  if (item.percent !== null) parts.push(`${Math.round(item.percent)}%`);
  const downloaded = formatYoutubeFileSize(item.downloadedBytes ?? 0);
  const total = item.totalBytes !== null
    ? formatYoutubeFileSize(item.totalBytes)
    : item.estimatedBytes != null
      ? `~${formatYoutubeFileSize(item.estimatedBytes)} est.`
      : "Size pending";
  parts.push(`${downloaded} / ${total}`);
  const speed = item.message.match(/^\s*([\d.]+\s*(?:B|[KMGT]?i?B)\/s)\s*$/i)?.[1]?.replace(/\s+/g, "");
  if (speed) parts.push(speed);
  return parts.join(" · ");
}

export function attachYoutubeDownloadEstimate(item: YoutubeDownload, estimates: Record<string, number>): YoutubeDownload {
  return item.estimatedBytes == null && estimates[item.url] != null
    ? { ...item, estimatedBytes: estimates[item.url] }
    : item;
}

export function attachYoutubeDownloadEstimates(items: YoutubeDownload[], estimates: Record<string, number>) {
  return items.map((item) => attachYoutubeDownloadEstimate(item, estimates));
}
