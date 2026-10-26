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

export function youtubeResultSizeText(_durationSeconds: number | null, isPlaylist: boolean) {
  if (isPlaylist) return "Size varies";
  return "MP3 audio";
}

export function youtubeDownloadProgressText(item: YoutubeDownload) {
  const totalBytes = item.totalBytes !== null && item.totalBytes > 0 ? item.totalBytes : null;
  const downloadedBytes = item.downloadedBytes !== null && item.downloadedBytes > 0 ? item.downloadedBytes : null;
  if (item.status === "completed" && (totalBytes !== null || downloadedBytes !== null)) {
    return formatYoutubeFileSize(totalBytes ?? downloadedBytes ?? 0);
  }
  if (item.status === "downloading" && /^\d+(?:\.\d+)?%(?:\s|$)/.test(item.message.trim())) {
    return item.message.trim();
  }
  const percent = item.percent !== null ? `${Number(item.percent.toFixed(1))}%` : null;
  if (totalBytes === null) return percent ? `${percent} · Pending` : "Pending";
  const parts: string[] = [];
  if (percent) parts.push(percent);
  if (downloadedBytes !== null) {
    parts.push(`${formatYoutubeFileSize(downloadedBytes)} / ${formatYoutubeFileSize(totalBytes)}`);
  } else {
    parts.push(formatYoutubeFileSize(totalBytes));
  }
  const speed = item.message.match(/^\s*([\d.]+\s*(?:B|[KMGT]?i?B)\/s)\s*$/i)?.[1]?.replace(/\s+/g, "");
  if (speed) parts.push(speed);
  return parts.join(" · ");
}

export function youtubeDownloadErrorText(error: string, isPlaylist = false) {
  const detail = error.toLowerCase();
  if (/sign.?in|log.?in|age.restrict|confirm you.re not a bot|cookies|members.only/.test(detail)) {
    return "YouTube requires sign-in for this video. Try another song.";
  }
  if (/private video|video unavailable|not available|removed by the uploader|has been removed|copyright/.test(detail)) {
    return "This video is unavailable. Try another song.";
  }
  if (/no space left|not enough (?:disk )?space|enospc/.test(detail)) {
    return "Your device is low on storage. Free some space and try again.";
  }
  if (/permission denied|access denied|read.only file system|couldn.t create.*music|couldn.t open.*music/.test(detail)) {
    return "MichoPlay can't save this song. Check storage access and try again.";
  }
  if (/ffmpeg|ffprobe|postprocess|audio conversion|convert.*mp3|codec|playable audio file/.test(detail)) {
    return "The audio downloaded, but MP3 conversion failed. Try again.";
  }
  if (/429|too many requests|rate.limit/.test(detail)) {
    return "YouTube is limiting downloads right now. Try again later.";
  }
  if (/403|forbidden/.test(detail)) {
    return "YouTube blocked this download. Try again later.";
  }
  if (/timed? out|connection|network|dns|name resolution|unable to download webpage|certificate/.test(detail)) {
    return "Couldn't connect to YouTube. Check your internet connection and try again.";
  }
  if (/no video formats|requested format|audio format|unsupported url/.test(detail)) {
    return "Audio isn't available for this video. Try another song.";
  }
  if (/couldn.t start|could not initialize|tools couldn.t start/.test(detail)) {
    return "The downloader couldn't start. Restart MichoPlay and try again.";
  }
  return isPlaylist ? "Couldn't download this playlist. Try again." : "Couldn't download this song. Try again.";
}
