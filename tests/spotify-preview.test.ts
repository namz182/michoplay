import test from "node:test";
import assert from "node:assert/strict";
import { fetchSpotifyPreview } from "../src/lib/spotify-preview.ts";
import type { SpotifyPublicMetadata } from "../src/lib/api";

const url = "https://open.spotify.com/playlist/3bCxmOtEZMXln987Zns5Oq";
const metadata: SpotifyPublicMetadata = { title: "Playlist", kind: "playlist", songs: [{ id: "song", title: "Song", artist: "Artist" }] };

test("successful native requests return the songs", async () => {
  assert.equal(await fetchSpotifyPreview(async (input) => { assert.equal(input, url); return metadata; }, url), metadata);
});

test("a native request that never responds stops at the screen deadline", async () => {
  await assert.rejects(fetchSpotifyPreview(() => new Promise(() => {}), url, { timeoutMs: 10 }), /took too long/);
});

test("cancelling stops the wait and ignores a late native result", async () => {
  const controller = new AbortController();
  let resolve!: (value: SpotifyPublicMetadata) => void;
  const pending = fetchSpotifyPreview(() => new Promise<SpotifyPublicMetadata>((done) => { resolve = done; }), url, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  resolve(metadata);
  await Promise.resolve();
});

test("a request already cancelled does not call native code", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(fetchSpotifyPreview(async () => { called = true; return metadata; }, url, { signal: controller.signal }), /cancelled/);
  assert.equal(called, false);
});

test("native errors remain readable and a retry can succeed", async () => {
  await assert.rejects(fetchSpotifyPreview(async () => { throw new Error("Spotify is busy"); }, url), /Spotify is busy/);
  assert.equal(await fetchSpotifyPreview(async () => metadata, url), metadata);
});

test("a late native rejection after timeout is handled", async () => {
  let reject!: (error: Error) => void;
  const pending = fetchSpotifyPreview(() => new Promise<SpotifyPublicMetadata>((_, fail) => { reject = fail; }), url, { timeoutMs: 10 });
  await assert.rejects(pending, /took too long/);
  reject(new Error("Late native failure"));
  await Promise.resolve();
});
