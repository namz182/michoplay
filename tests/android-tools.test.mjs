import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareAndroidDownloader } from "../scripts/prepare-android-tools.mjs";

test("every APK preparation resolves the current release and replaces the packaged downloader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "michoplay-tools-test-"));
  let version = "2026.11.20.1";
  const requested = [];
  const fetchRelease = async (url) => {
    requested.push(url);
    const binary = Buffer.from(`downloader ${version}`);
    const checksum = createHash("sha256").update(binary).digest("hex");
    if (url.endsWith("/latest")) return {
      ok: true, url: `https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/${version}`,
    };
    return new Response(url.endsWith("SHA2-256SUMS") ? `${checksum}  yt-dlp\n` : binary);
  };
  try {
    await prepareAndroidDownloader(directory, fetchRelease);
    version = "2026.11.21.2";
    await prepareAndroidDownloader(directory, fetchRelease);
    assert.equal(await readFile(join(directory, "raw/ytdlp"), "utf8"), `downloader ${version}`);
    assert.match(await readFile(join(directory, "raw/michoplay_ytdlp_version.txt"), "utf8"), /^2026\.11\.21\.2:[a-f0-9]{64}\n$/);
    assert.equal(requested.filter((url) => url.endsWith("/latest")).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a corrupted release cannot overwrite a verified APK resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), "michoplay-tools-test-"));
  const fetchRelease = async (url) => {
    if (url.endsWith("/latest")) return { ok: true, url: "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.11.21.1" };
    return new Response(url.endsWith("SHA2-256SUMS") ? `${"0".repeat(64)}  yt-dlp\n` : "corrupt");
  };
  try {
    await assert.rejects(prepareAndroidDownloader(directory, fetchRelease), /SHA-256 verification failed/);
    await assert.rejects(readFile(join(directory, "raw/ytdlp")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
