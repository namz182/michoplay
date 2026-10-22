import test from "node:test";
import assert from "node:assert/strict";
import { attachYoutubeDownloadEstimate, estimateYoutubeDownloadBytes, youtubeDownloadProgressText, youtubeResultSizeText } from "../src/lib/youtube-size.ts";
import type { YoutubeDownload } from "../src/lib/api";

test("YouTube result size estimates match the duration-based M4A estimate", () => {
  assert.equal(estimateYoutubeDownloadBytes(246, false), 3_936_000);
  assert.equal(youtubeResultSizeText(246, false), "~3.8 MB est.");
});

test("playlist or unavailable duration is not assigned a video size", () => {
  assert.equal(estimateYoutubeDownloadBytes(246, true), null);
  assert.equal(youtubeResultSizeText(246, true), "Size varies");
  assert.equal(estimateYoutubeDownloadBytes(null, false), null);
  assert.equal(youtubeResultSizeText(null, false), "Size pending");
});

test("download progress shows the search estimate until the downloader reports an actual total", () => {
  const download: YoutubeDownload = {
    id: "download-1", title: "Example", url: "https://youtu.be/example", thumbnail: null,
    isPlaylist: false, estimatedBytes: 3_936_000, status: "downloading", percent: 20,
    downloadedBytes: 0, totalBytes: null, message: "",
  };
  assert.equal(youtubeDownloadProgressText(download), "20% · 0 B / ~3.8 MB est.");
  assert.equal(youtubeDownloadProgressText({ ...download, percent: 25, downloadedBytes: 1_048_576, totalBytes: 4_194_304 }), "25% · 1.0 MB / 4.0 MB");
  assert.equal(youtubeDownloadProgressText({ ...download, percent: 50, downloadedBytes: 2_097_152, totalBytes: 4_194_304 }), "50% · 2.0 MB / 4.0 MB");
});

test("download items recover the matching search estimate when the native queue omits it", () => {
  const item: YoutubeDownload = {
    id: "download-2", title: "Example", url: "https://youtu.be/example", thumbnail: null,
    isPlaylist: false, status: "downloading", percent: 20, downloadedBytes: 0,
    totalBytes: null, message: "",
  };
  const recovered = attachYoutubeDownloadEstimate(item, { [item.url]: 3_936_000 });
  assert.equal(youtubeDownloadProgressText(recovered), "20% · 0 B / ~3.8 MB est.");
});
