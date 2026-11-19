import test from "node:test";
import assert from "node:assert/strict";
import { cleanDownloadMetadata, createDownloadBatch, groupDownloads, newestDownloadsFirst } from "../src/lib/downloads.ts";
import type { YoutubeDownload } from "../src/lib/api";

test("saved titles remove artist prefixes and promotional labels", () => {
  for (const suffix of ["[Official Music]", "(Lyrics)", "(Official Music Video)", "Official Video"]) {
    assert.deepEqual(cleanDownloadMetadata(`Beyoncé - Halo ${suffix}`, "BeyoncéVEVO"), { title: "Halo", artist: "Beyoncé" });
  }
  assert.deepEqual(cleanDownloadMetadata("Halo - Beyoncé (lyrics)", "Beyoncé"), { title: "Halo", artist: "Beyoncé" });
});

test("an upload channel does not become part of the saved song title", () => {
  assert.deepEqual(cleanDownloadMetadata("Adele - Hello (Official Video)", "Popular Lyrics Channel"), { title: "Hello", artist: "Adele" });
});

test("Spotify titles keep meaningful versions and trusted artist metadata", () => {
  assert.deepEqual(cleanDownloadMetadata("Halo (Acoustic)", "Beyoncé", true), { title: "Halo (Acoustic)", artist: "Beyoncé" });
  assert.deepEqual(cleanDownloadMetadata("Hello - Live at Wembley", "Adele", true), { title: "Hello - Live at Wembley", artist: "Adele" });
  assert.deepEqual(cleanDownloadMetadata("Adele - Hello (Remix) (Lyrics)", "Adele", true), { title: "Hello (Remix)", artist: "Adele" });
  assert.equal(cleanDownloadMetadata("Music", "Madonna", true).title, "Music");
});

test("Unicode, punctuation, and percent signs survive title cleanup", () => {
  assert.equal(cleanDownloadMetadata("Björk - 100% Jóga [Official Audio]", "Björk").title, "100% Jóga");
});

function download(id: number, playlist?: YoutubeDownload["playlist"]): YoutubeDownload {
  return { id: `youtube-${id}`, title: `Song ${id}`, url: `https://youtu.be/${id}`, thumbnail: null, isPlaylist: false,
    status: "queued", phase: "queued", percent: null, downloadedBytes: null, totalBytes: null, totalBytesEstimated: false,
    speedBytesPerSecond: null, etaSeconds: null, message: "Queued", playlist };
}

test("new downloads and playlist groups share one newest-first order", () => {
  const batch = createDownloadBatch("My playlist", 3);
  const items = [download(2), download(10, batch(0)), download(11, batch(1)), download(12)];
  assert.deepEqual(newestDownloadsFirst(items).map((item) => item.id), ["youtube-12", "youtube-11", "youtube-10", "youtube-2"]);
  const entries = groupDownloads(items);
  assert.deepEqual(entries.map((entry) => entry.playlist), [false, true, false]);
  assert.equal(entries[0].items[0].id, "youtube-12");
  assert.equal(entries[1].items.length, 2);
  assert.equal(items[0].id, "youtube-2", "sorting does not mutate the queue");
});

test("each selection gets one stable batch ID and separate selections remain separate", () => {
  const first = createDownloadBatch("My playlist", 3);
  const second = createDownloadBatch("My playlist", 3);
  assert.equal(first(0).id, first(2).id);
  assert.notEqual(first(0).id, second(0).id);
  assert.deepEqual([first(0).index, first(2).index, first(2).total], [1, 3, 3]);
});
