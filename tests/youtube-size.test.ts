import test from "node:test";
import assert from "node:assert/strict";
import { formatYoutubeFileSize, youtubeDownloadProgressText, youtubeResultSizeText } from "../src/lib/youtube-size.ts";
import type { YoutubeDownload } from "../src/lib/api";

const download: YoutubeDownload = {
  id: "youtube-1", title: "Example", url: "https://youtu.be/example", thumbnail: null,
  isPlaylist: false, status: "downloading", phase: "downloading", percent: 25,
  downloadedBytes: 1_048_576, totalBytes: 4_194_304, totalBytesEstimated: false,
  speedBytesPerSecond: 262_144, etaSeconds: 12, message: "Downloading audio…", filePaths: [],
};

test("transfer progress uses the reported percentage, byte counts, speed, and ETA", () => {
  assert.equal(youtubeDownloadProgressText(download), "25% · 1.0 MB / 4.0 MB · 256 KB/s · ETA 0:12");
});

test("progress remains pending until the downloader reports transfer data", () => {
  assert.equal(youtubeDownloadProgressText({ ...download, percent: null, downloadedBytes: null, totalBytes: null, speedBytesPerSecond: null, etaSeconds: null }), "Pending");
});

test("completed downloads show the actual saved size", () => {
  assert.equal(youtubeDownloadProgressText({ ...download, status: "completed", totalBytes: 7_340_032 }), "7.0 MB");
  assert.equal(formatYoutubeFileSize(0), "0 B");
});

test("search result labels do not claim a duration-based file size", () => {
  assert.equal(youtubeResultSizeText(246, false), "MP3 audio");
  assert.equal(youtubeResultSizeText(246, true), "Size varies");
});
