import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, type YoutubeSearchResult } from "../lib/api";

export type YoutubeSearchCache = Map<string, {
  results: YoutubeSearchResult[];
  savedAt: number;
  hasMore?: boolean;
}>;

export function youtubeSearchCanContinue(query: string, count: number) {
  return count > 0 && !/^https?:\/\//i.test(query.trim());
}

type Options = {
  query: string;
  enabled: boolean;
  online: boolean;
  cache: MutableRefObject<YoutubeSearchCache>;
  initialLimit: number;
  pageSize: number;
  minimumQueryLength: number;
  debounceMs: number;
  offlineMessage: string;
  requestErrorMessage: string;
  onEnrich: (query: string, offset: number, results: YoutubeSearchResult[]) => void;
  onLoadMoreError?: () => void;
};

export function useYoutubeSearch(options: Options) {
  const [results, setResults] = useState<YoutubeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(options.initialLimit);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const version = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const query = options.query.trim();
    const requestVersion = ++version.current;
    if (!options.enabled || query.length < options.minimumQueryLength) {
      setResults([]);
      setVisibleLimit(options.initialLimit);
      setHasMore(false);
      setError("");
      setSearching(false);
      return;
    }

    const cacheKey = query.toLocaleLowerCase();
    const cached = options.cache.current.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < 60_000) {
      const nextHasMore = cached.hasMore ?? youtubeSearchCanContinue(query, cached.results.length);
      setResults(cached.results);
      setVisibleLimit(nextHasMore ? options.initialLimit : cached.results.length);
      setHasMore(nextHasMore);
      setError("");
      setSearching(false);
      return;
    }
    if (!options.online) {
      setResults([]);
      setVisibleLimit(options.initialLimit);
      setHasMore(false);
      setError(options.offlineMessage);
      setSearching(false);
      return;
    }

    setResults([]);
    setVisibleLimit(options.initialLimit);
    setHasMore(false);
    setError("");
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.youtubeSearch(query, options.pageSize, 0)
        .then((items) => {
          if (version.current !== requestVersion) return;
          const more = youtubeSearchCanContinue(query, items.length);
          setResults(items);
          setVisibleLimit(options.initialLimit);
          setHasMore(more);
          options.cache.current.set(cacheKey, { results: items, hasMore: more, savedAt: Date.now() });
          optionsRef.current.onEnrich(query, 0, items);
        })
        .catch(() => {
          if (version.current !== requestVersion) return;
          setResults([]);
          setVisibleLimit(options.initialLimit);
          setHasMore(false);
          setError(navigator.onLine ? options.requestErrorMessage : options.offlineMessage);
        })
        .finally(() => {
          if (version.current === requestVersion) setSearching(false);
        });
    }, options.debounceMs);
    return () => window.clearTimeout(timer);
  }, [
    options.query,
    options.enabled,
    options.online,
    options.cache,
    options.initialLimit,
    options.pageSize,
    options.minimumQueryLength,
    options.debounceMs,
    options.offlineMessage,
    options.requestErrorMessage,
  ]);

  const loadMore = useCallback(async () => {
    const current = optionsRef.current;
    const query = current.query.trim();
    if (!query || searching || loadingMore || !hasMore) return;
    const requestVersion = version.current;
    const offset = results.length;
    setLoadingMore(true);
    try {
      const next = await api.youtubeSearch(query, current.pageSize, offset);
      if (version.current !== requestVersion) return;
      setResults((prior) => {
        const ids = new Set(prior.map((item) => item.id));
        const merged = [...prior, ...next.filter((item) => !ids.has(item.id))];
        const more = youtubeSearchCanContinue(query, next.length);
        current.cache.current.set(query.toLocaleLowerCase(), { results: merged, hasMore: more, savedAt: Date.now() });
        return merged;
      });
      setHasMore(youtubeSearchCanContinue(query, next.length));
      setVisibleLimit((limit) => limit + current.pageSize);
      current.onEnrich(query, offset, next);
    } catch {
      if (version.current === requestVersion) current.onLoadMoreError?.();
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, results.length, searching]);

  return { results, setResults, searching, error, setError, visibleLimit, setVisibleLimit, hasMore, setHasMore, loadingMore, loadMore, version };
}
