import type { YoutubeDownload, YoutubeDownloadPlaylist } from "./api";

// Remove presentation labels without removing meaningful versions such as
// (Live), (Remix), or (Acoustic).
const presentationLabel = /^(?:(?:official|music|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|mv|full|version)\s*)+$/i;

function stripPresentationLabels(value: string) {
  return value.replace(/\[([^\]]*)\]|\(([^)]*)\)/g, (match, square: string, round: string) =>
    presentationLabel.test((square ?? round).trim()) ? " " : match,
  ).replace(/\s*(?:[-–—|:]\s*)?(?:official\s+(?:(?:music|lyric)\s+)?(?:video|audio)|official\s+music|lyric\s+video|lyrics|official\s+visuali[sz]er)\s*$/i, "")
    .replace(/\s+/g, " ").replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, "").trim();
}

function identity(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function cleanDownloadMetadata(rawTitle: string, rawArtist?: string | null, trustArtist = false) {
  let title = stripPresentationLabels(rawTitle);
  let artist = (rawArtist ?? "").replace(/\s*(?:-\s*Topic|VEVO|Official)\s*$/i, "").trim();
  const parts = title.split(/\s+[-–—|]\s+/);
  if (parts.length > 1) {
    const first = parts[0].trim();
    const last = parts.at(-1)!.trim();
    if (identity(last) === identity(artist) && artist) {
      title = parts.slice(0, -1).join(" - ");
    } else if (!artist || identity(first) === identity(artist) || !trustArtist) {
      artist = first;
      title = parts.slice(1).join(" - ");
    }
  }
  return { title: stripPresentationLabels(title) || rawTitle.trim() || "YouTube audio", artist };
}

export function createDownloadBatch(title: string, count: number) {
  const id = `batch-${crypto.randomUUID()}`;
  return (index: number): YoutubeDownloadPlaylist => ({ id, title, index: index + 1, total: count });
}

export function newestDownloadsFirst(items: YoutubeDownload[]) {
  // Native IDs increase monotonically and survive restarts on both platforms.
  return [...items].sort((a, b) => Number(b.id.match(/\d+$/)?.[0] ?? 0) - Number(a.id.match(/\d+$/)?.[0] ?? 0));
}

export function groupDownloads(items: YoutubeDownload[]) {
  const groups = new Map<string, YoutubeDownload[]>();
  const entries: { key: string; playlist: boolean; items: YoutubeDownload[] }[] = [];
  for (const item of newestDownloadsFirst(items)) {
    if (!item.playlist) {
      entries.push({ key: item.id, playlist: false, items: [item] });
      continue;
    }
    let rows = groups.get(item.playlist.id);
    if (!rows) {
      rows = [];
      groups.set(item.playlist.id, rows);
      entries.push({ key: item.playlist.id, playlist: true, items: rows });
    }
    rows.push(item);
  }
  return entries;
}
