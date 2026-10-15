// Default adapter per kind. The backend keeps no such preference (media.preferences holds only the metadata switch), so this is a
// per-browser convenience in localStorage; every access is wrapped because storage can be missing or blocked.
import type { Kind } from "./media-model.ts";

const KEY = "plur1bus.library.defaultAdapters";

export function loadDefaults(): Partial<Record<Kind, string>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Partial<Record<Kind, string>> = {};
    if (typeof raw["image"] === "string") out.image = raw["image"];
    if (typeof raw["video"] === "string") out.video = raw["video"];
    return out;
  } catch {
    return {};
  }
}

export function saveDefault(kind: Kind, adapterId: string): void {
  try {
    const next = { ...loadDefaults() };
    if (adapterId) next[kind] = adapterId; else delete next[kind];
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* storage unavailable: the choice just is not remembered */ }
}
