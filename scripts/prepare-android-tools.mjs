import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const repository = "https://github.com/yt-dlp/yt-dlp-nightly-builds";
const execute = promisify(execFile);

async function downloadResponse(url, options) {
  // System curl also works on build hosts whose Node TLS/network stack cannot
  // reach GitHub. It ships with current Windows, macOS and Android dev setups.
  const temporary = await mkdtemp(join(tmpdir(), "michoplay-android-tools-"));
  try {
    const file = join(temporary, "response");
    const { stdout } = await execute("curl", [
      "-4", "--fail", "--silent", "--show-error", "--location",
      "--connect-timeout", "15", "--max-time", "55",
      "--output", file, "--write-out", "%{url_effective}", url,
    ], { signal: options.signal });
    const response = new Response(await readFile(file));
    Object.defineProperty(response, "url", { value: stdout.trim() });
    return response;
  } catch (error) {
    if (error.code === "ENOENT") return fetch(url, options);
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function request(url, fetchImpl) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
      return response;
    } catch (error) { failure = error; }
  }
  throw failure;
}

// Executed by Gradle preBuild, including builds started directly in Android Studio.
// Fail the build on refresh/checksum failure instead of quietly shipping an old tool.
export async function prepareAndroidDownloader(outputDirectory, fetchImpl = downloadResponse) {
  const release = await request(`${repository}/releases/latest`, fetchImpl);
  const tag = new URL(release.url).pathname.split("/tag/")[1];
  await release.body?.cancel();
  if (!tag || !/^[\w.-]+$/.test(tag)) throw new Error("Could not resolve the latest yt-dlp nightly release.");
  const base = `${repository}/releases/download/${tag}`;
  const [binaryResponse, sumsResponse] = await Promise.all([
    request(`${base}/yt-dlp`, fetchImpl),
    request(`${base}/SHA2-256SUMS`, fetchImpl),
  ]);
  const [binary, sums] = await Promise.all([
    binaryResponse.arrayBuffer().then((bytes) => Buffer.from(bytes)),
    sumsResponse.text(),
  ]);
  const expected = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, "") === "yt-dlp")?.[0];
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || actual !== expected.toLowerCase()) throw new Error("yt-dlp SHA-256 verification failed.");
  const raw = join(outputDirectory, "raw");
  await mkdir(raw, { recursive: true });
  await writeFile(join(raw, "ytdlp.tmp"), binary);
  await rename(join(raw, "ytdlp.tmp"), join(raw, "ytdlp"));
  await writeFile(join(raw, "michoplay_ytdlp_version.txt"), `${tag}:${actual}\n`);
  console.log(`Packaged yt-dlp nightly ${tag} (SHA-256 verified).`);
  return { tag, sha256: actual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Pass the generated Android resource directory.");
  await prepareAndroidDownloader(resolve(process.argv[2]));
}
