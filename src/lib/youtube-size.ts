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
  const speed = item.speedBytesPerSecond !== null && item.speedBytesPerSecond > 0
    ? `${formatYoutubeFileSize(item.speedBytesPerSecond)}/s` : null;
  const eta = item.etaSeconds !== null && item.etaSeconds >= 0
    ? `ETA ${formatDownloadEta(item.etaSeconds)}` : null;
  if (item.status === "downloading" && /^Track \d+ of \d+ ·/.test(item.message)) {
    return [percent, item.message, speed, eta].filter(Boolean).join(" · ");
  }
  if (totalBytes === null) {
    return [percent, downloadedBytes === null ? null : `${formatYoutubeFileSize(downloadedBytes)} transferred`, speed, eta]
      .filter(Boolean).join(" · ") || "Pending";
  }
  const parts: string[] = [];
  if (percent) parts.push(percent);
  if (downloadedBytes !== null) {
    parts.push(`${formatYoutubeFileSize(downloadedBytes)} / ${item.totalBytesEstimated ? "~" : ""}${formatYoutubeFileSize(totalBytes)}`);
  } else {
    parts.push(formatYoutubeFileSize(totalBytes));
  }
  if (speed) parts.push(speed);
  if (eta) parts.push(eta);
  return parts.join(" · ");
}

function formatDownloadEta(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

const youtubeDownloadMessages = {
  locationUnreadable: "MichoPlay couldn't read where the song was saved. Try downloading it again.",
  locationMissing: "The download finished without a saved song location. Try downloading it again.",
  fileMissing: "The downloaded song is missing from Music/MichoPlay. Try downloading it again.",
  readPermission: "MichoPlay doesn't have permission to read the downloaded song. Allow access to your Music folder and try again.",
  folderUnavailable: "The downloaded song's folder is no longer available. Restore the folder or download the song again.",
  folderTimeout: "Your Music folder took too long to respond. Check that the drive is connected and try again.",
  fileUnreadable: "MichoPlay couldn't read the downloaded song. Check that your Music folder is accessible and try again.",
  wrongFormat: "The saved download isn't an MP3 file. Try downloading it again.",
  notFile: "The saved download isn't a song file. Try downloading it again.",
  emptyFile: "The downloaded song is empty. Try downloading it again.",
  statusUnreadable: "MichoPlay couldn't read the download status. Restart the app and try again.",
  completionUnknown: "MichoPlay couldn't confirm whether the download finished. Try again.",
  interrupted: "The download stopped before it could finish. Try again.",
  startFailed: "Couldn't start this download. Restart MichoPlay and try again.",
};

export function youtubeDownloadErrorText(error: string, isPlaylist = false) {
  // Preserve known, specific native messages. Never pass arbitrary tool output through.
  const friendlyMessage = Object.values(youtubeDownloadMessages).find((message) => message === error.trim());
  if (friendlyMessage) return friendlyMessage;

  const lines = error.split(/\r?\n/).map((line) => line.trim());
  const normalized = lines.join(" ").toLowerCase();
  if (/enter a valid youtube (?:video or playlist|url)/.test(normalized)) {
    return "This YouTube result link is invalid. Refresh Search results and try again.";
  }
  if (/android media services are still starting|youtube tools are still starting/.test(normalized)) {
    return "Downloads are still starting. Wait a moment and try again.";
  }
  if (/allow storage access/.test(normalized)) {
    return "Allow MichoPlay storage access, then tap Download again.";
  }
  const reportedErrors = lines.filter((line) => /^error:/i.test(line));
  // Classify reported failures without exposing tool logs or system details.
  const detail = (reportedErrors.length ? reportedErrors : lines.filter((line) => !/^\[debug\]/i.test(line))).join("\n").toLowerCase();
  if (/no space left|not enough (?:disk )?space|enospc|disk quota exceeded/.test(detail)) {
    return "There isn't enough storage to save this song. Free some space and try again.";
  }
  if (/read.only file system/.test(detail)) {
    return "Your Music folder is read-only. Allow writing to this folder and try again.";
  }
  if (/permission denied|access denied|couldn.t create.*music|couldn.t open.*music/.test(detail)) {
    if (/downloaded mp3 file|downloaded song/.test(detail)) return youtubeDownloadMessages.readPermission;
    return "MichoPlay doesn't have permission to save this song. Allow access to your Music folder and try again.";
  }
  if (/used by another process|sharing violation|resource busy/.test(detail)) {
    return "Another app is using the downloaded song. Close it there and try again.";
  }
  if (/file name too long|filename.*too long|path.*too long/.test(detail)) {
    return "This song's filename is too long to save. Try a version with a shorter title.";
  }
  if (/sign.?in|log.?in|age.restrict|confirm you.re not a bot|cookies|members.only/.test(detail)) {
    return "YouTube requires sign-in for this video. Try another song.";
  }
  if (/javascript runtime|js runtime|challenge solving failed|signature extraction|signature solving/.test(detail)) {
    return "YouTube changed how this song is delivered. Update MichoPlay and try again.";
  }
  if (/private video|video unavailable|not available|removed by the uploader|has been removed|copyright/.test(detail)) {
    return "This video is unavailable. Try another song.";
  }
  if (/bundled .+ tool is missing|ffmpeg (?:was )?not found|ffprobe (?:was )?not found/.test(detail)) {
    return "MichoPlay's download tools are missing. Reinstall the app to restore downloads.";
  }
  if (/needs ffmpeg with mp3 encoding support|unknown encoder|encoder.+not found/.test(detail)) {
    return "MichoPlay's audio tools can't create MP3 files. Update or reinstall the app.";
  }
  if (/downloader reported an (?:invalid|empty) mp3 file path|read the downloaded mp3 file path/.test(detail)) {
    return youtubeDownloadMessages.locationUnreadable;
  }
  if (/finished without reporting an mp3/.test(detail)) {
    return youtubeDownloadMessages.locationMissing;
  }
  if (/downloader did not produce an mp3/.test(detail)) {
    return youtubeDownloadMessages.wrongFormat;
  }
  if (/downloaded mp3 file could not be found|couldn.t find the downloaded song|downloaded (?:mp3 file|song).*(?:no such file or directory|system cannot find the file)/.test(detail)) {
    return youtubeDownloadMessages.fileMissing;
  }
  if (/downloaded mp3 file could not be accessed|couldn.t open the downloaded song/.test(detail)) {
    return youtubeDownloadMessages.fileUnreadable;
  }
  if (/downloaded song is incomplete|downloaded mp3 file is empty/.test(detail)) {
    return "The downloaded song is incomplete. Try downloading it again.";
  }
  if (/429|too many requests|rate.limit/.test(detail)) {
    return "YouTube is limiting downloads right now. Try again later.";
  }
  if (/http error (?:400|401|410)|bad request|unauthorized|gone \(410\)/.test(detail)) {
    return "YouTube couldn't provide this song right now. Try another result or try again later.";
  }
  if (/403|forbidden/.test(detail)) {
    return "YouTube blocked this download. Try again.";
  }
  if (/timed? out|connection|network|dns|name resolution|unable to download webpage|certificate/.test(detail)) {
    return "Couldn't connect to YouTube. Check your internet connection and try again.";
  }
  if (/unknown decoder|unsupported (?:audio )?(?:codec|format)|decoder.+not found/.test(detail)) {
    return "This video's audio format isn't supported. Try another version of the song.";
  }
  if (/no video formats|requested format|audio format|unsupported url/.test(detail)) {
    return "Audio isn't available for this video. Try another song.";
  }
  if (/invalid data found|could not find codec parameters|(?:downloaded|saved) audio couldn't be read/.test(detail)) {
    return "The downloaded audio couldn't be read. Try downloading it again.";
  }
  if (/ffmpeg|ffprobe|postprocess|audio conversion|convert.*mp3|codec|playable audio file|couldn.t prepare this song for playback/.test(detail)) {
    return "The audio downloaded, but conversion to MP3 failed. Try downloading it again.";
  }
  if (/couldn.t start|could not initialize|tools couldn.t start/.test(detail)) {
    return youtubeDownloadMessages.startFailed;
  }
  return isPlaylist ? "Couldn't download this playlist. Try again." : "Couldn't download this song. Try again.";
}
