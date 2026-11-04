import { isTauri } from "@tauri-apps/api/core";
import { api } from "./api";

const prefix = "michoplay-";
let pendingSave = Promise.resolve();

/** Migrate the legacy WebView preferences into Rust-owned SQLite before React mounts. */
export async function hydrateStoredData() {
  if (!isTauri()) return;
  try {
    let saved = await api.appDataLoad();
    const legacy: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      const dataKey = key.slice(prefix.length);
      if (value !== null && !(dataKey in saved)) legacy[dataKey] = value;
    }
    if (Object.keys(legacy).length > 0) {
      await api.appDataMigrate(legacy);
      saved = await api.appDataLoad();
    }
    for (const [key, value] of Object.entries(saved)) {
      localStorage.setItem(`${prefix}${key}`, value);
    }
  } catch {
    // Preserve the legacy local cache if the database cannot be opened.
  }
}

export function stored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`${prefix}${key}`);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveStoredData(key: string, serializedValue: string) {
  localStorage.setItem(`${prefix}${key}`, serializedValue);
  if (isTauri()) {
    pendingSave = pendingSave
      .then(() => api.appDataSave(key, serializedValue))
      .catch(() => undefined);
  }
}

