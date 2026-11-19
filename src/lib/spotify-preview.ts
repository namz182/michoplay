import type { SpotifyPublicMetadata } from "./api";

// An interrupted native bridge can leave invoke() pending after HTTP times out.
export function fetchSpotifyPreview(
  request: (url: string) => Promise<SpotifyPublicMetadata>,
  url: string,
  { signal, timeoutMs = 25_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SpotifyPublicMetadata> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(new Error("Spotify loading was cancelled.")));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(() => reject(new Error("Spotify took too long to respond. Check your connection and retry."))), timeoutMs);
    Promise.resolve().then(() => request(url)).then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
