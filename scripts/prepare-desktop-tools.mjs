import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget();
const targetInfo = targetDetails(target);
const outputDirectory = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));
mkdirSync(outputDirectory, { recursive: true });
const cacheDirectory = join(fileURLToPath(new URL("../.cache/desktop-tools/", import.meta.url)), target);
mkdirSync(cacheDirectory, { recursive: true });
const suffix = target.endsWith("-pc-windows-msvc") ? ".exe" : "";
const outputs = ["yt-dlp", "ffmpeg", "deno"].map((name) => join(outputDirectory, `${name}-${target}${suffix}`));

if (outputs.every(existsSync)) {
  console.log(`Desktop downloader tools are already staged for ${target}.`);
  process.exit(0);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "michoplay-tools-"));
try {
  const [ytDlpRelease, denoRelease, ffmpegReleases] = await Promise.all([
    githubRelease("yt-dlp", "yt-dlp"),
    githubRelease("denoland", "deno"),
    githubReleases("AtlasYang", "ffmpeg-static-builds"),
  ]);
  const ffmpegRelease = ffmpegReleases.find((release) => release.assets.some((asset) => asset.name.startsWith("ffmpeg-") && !asset.name.includes("-shared-") && asset.name.endsWith(targetInfo.ffmpegSuffix)));
  if (!ffmpegRelease) throw new Error(`FFmpeg has no release asset for ${target}.`);

  const ytDlpAsset = requireAsset(ytDlpRelease, targetInfo.ytDlpAsset);
  const ytDlpSumsAsset = requireAsset(ytDlpRelease, "SHA2-256SUMS");
  const ytDlpPath = await downloadVerified(ytDlpAsset, ytDlpSumsAsset, basename(ytDlpAsset.name), cacheDirectory);

  const denoAsset = requireAsset(denoRelease, targetInfo.denoAsset);
  const denoSumsAsset = requireAsset(denoRelease, `${targetInfo.denoAsset}.sha256sum`);
  const denoArchive = await downloadVerified(denoAsset, denoSumsAsset, targetInfo.denoAsset, cacheDirectory);
  const denoPath = extractBinary(denoArchive, "deno", temporaryDirectory);

  const ffmpegAsset = ffmpegRelease.assets.find((asset) => asset.name.startsWith("ffmpeg-") && !asset.name.includes("-shared-") && asset.name.endsWith(targetInfo.ffmpegSuffix));
  const ffmpegSumsAsset = requireAsset(ffmpegRelease, "checksums.sha256");
  const ffmpegArchive = await downloadVerified(ffmpegAsset, ffmpegSumsAsset, basename(ffmpegAsset.name), cacheDirectory);
  const ffmpegPath = extractBinary(ffmpegArchive, targetInfo.ffmpegBinary, temporaryDirectory);

  for (const [source, output] of [[ytDlpPath, outputs[0]], [ffmpegPath, outputs[1]], [denoPath, outputs[2]]]) {
    copyFileSync(source, output);
    if (!suffix) chmodSync(output, 0o755);
  }
  console.log(`Staged yt-dlp, FFmpeg, and Deno for ${target}.`);
  console.log(`Versions: yt-dlp ${ytDlpRelease.tag_name}, FFmpeg ${ffmpegRelease.tag_name}, Deno ${denoRelease.tag_name}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function hostTarget() {
  const platforms = { linux: "unknown-linux-gnu", win32: "pc-windows-msvc", darwin: "apple-darwin" };
  const architectures = { x64: "x86_64", arm64: "aarch64" };
  const platform = platforms[process.platform];
  const architecture = architectures[process.arch];
  if (!platform || !architecture) throw new Error(`Unsupported desktop platform: ${process.platform}/${process.arch}.`);
  return `${architecture}-${platform}`;
}

function targetDetails(triple) {
  const supported = {
    "x86_64-unknown-linux-gnu": {
      ytDlpAsset: "yt-dlp_linux", denoAsset: "deno-x86_64-unknown-linux-gnu.zip",
      ffmpegSuffix: "linux-x64.tar.gz", ffmpegBinary: "ffmpeg",
    },
    "aarch64-unknown-linux-gnu": {
      ytDlpAsset: "yt-dlp_linux_aarch64", denoAsset: "deno-aarch64-unknown-linux-gnu.zip",
      ffmpegSuffix: "linux-arm64.tar.gz", ffmpegBinary: "ffmpeg",
    },
    "x86_64-pc-windows-msvc": {
      ytDlpAsset: "yt-dlp.exe", denoAsset: "deno-x86_64-pc-windows-msvc.zip",
      ffmpegSuffix: "win-x64.zip", ffmpegBinary: "ffmpeg.exe",
    },
    "x86_64-apple-darwin": {
      ytDlpAsset: "yt-dlp_macos", denoAsset: "deno-x86_64-apple-darwin.zip",
      ffmpegSuffix: "macos-x64.tar.gz", ffmpegBinary: "ffmpeg",
    },
    "aarch64-apple-darwin": {
      ytDlpAsset: "yt-dlp_macos", denoAsset: "deno-aarch64-apple-darwin.zip",
      ffmpegSuffix: "macos-arm64.tar.gz", ffmpegBinary: "ffmpeg",
    },
  };
  if (!supported[triple]) throw new Error(`Bundled YouTube audio tools do not support target ${triple}.`);
  return supported[triple];
}

async function githubRelease(owner, repository) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/releases/latest`, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "MichoPlay-desktop-build" },
  });
  if (!response.ok) throw new Error(`Could not read ${owner}/${repository} release metadata (${response.status}).`);
  return response.json();
}

async function githubReleases(owner, repository) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/releases?per_page=100`, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "MichoPlay-desktop-build" },
  });
  if (!response.ok) throw new Error(`Could not read ${owner}/${repository} release metadata (${response.status}).`);
  return response.json();
}

function requireAsset(release, name) {
  const asset = release.assets.find((entry) => entry.name === name);
  if (!asset) throw new Error(`Release ${release.tag_name} is missing ${name}.`);
  return asset;
}

async function download(url, path) {
  const response = await fetch(url, { headers: { "User-Agent": "MichoPlay-desktop-build" } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

async function downloadVerified(asset, sumsAsset, expectedName, directory) {
  const sumsPath = await download(sumsAsset.browser_download_url, join(directory, `${sumsAsset.name}-${asset.id}`));
  const lines = readFileSync(sumsPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const expected = lines.find((line) => line.trim().endsWith(expectedName)) ?? (lines.length === 1 ? lines[0] : undefined);
  const hash = expected?.trim().split(/\s+/)[0]?.replace(/^\*/, "");
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) throw new Error(`No SHA-256 checksum was published for ${expectedName}.`);
  const path = join(directory, asset.name);
  if (existsSync(path)) {
    const cached = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (cached.toLowerCase() === hash.toLowerCase()) return path;
  }
  await download(asset.browser_download_url, path);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual.toLowerCase() !== hash.toLowerCase()) throw new Error(`SHA-256 verification failed for ${expectedName}.`);
  return path;
}

function extractBinary(archive, name, directory) {
  const extractedDirectory = join(directory, `${basename(archive)}-contents`);
  mkdirSync(extractedDirectory);
  if (archive.toLowerCase().endsWith(".zip")) {
    extractZipEntry(archive, name, extractedDirectory);
  } else {
    const result = spawnSync("tar", ["-xf", archive, "-C", extractedDirectory], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`Could not extract ${basename(archive)}; install a tar utility and try again.`);
  }
  const candidates = findFiles(extractedDirectory).filter((path) => basename(path).toLowerCase() === name.toLowerCase());
  if (!candidates.length) throw new Error(`${basename(archive)} did not contain ${name}.`);
  return candidates[0];
}

function extractZipEntry(archive, name, destination) {
  const data = readFileSync(archive);
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${basename(archive)} is not a valid ZIP archive.`);
  const count = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`${basename(archive)} has an invalid ZIP directory.`);
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const entryName = data.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (basename(entryName).toLowerCase() === name.toLowerCase()) {
      if (flags & 1) throw new Error(`${name} is unexpectedly encrypted.`);
      if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name} has an invalid ZIP entry.`);
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = data.subarray(start, start + compressedSize);
      const contents = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!contents) throw new Error(`${name} uses an unsupported ZIP compression method.`);
      writeFileSync(join(destination, name), contents);
      return;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${basename(archive)} did not contain ${name}.`);
}

function findFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(path));
    else files.push(path);
  }
  return files;
}
