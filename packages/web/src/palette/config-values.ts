// Current settings values for the palette, read with the one documented reader: `config.get` (docs/rpc.md, served by the supervisor;
// no params returns the whole running configuration). Best effort: any failure (route not served yet, 401, E_NOT_AVAILABLE,
// malformed answer) gives null and the palette indexes without values. Never throws, never shows an error.
import { createApi, type Api } from "../api/index.ts";
import { settingValues } from "./index-build.ts";

export async function loadSettingValues(api: Api = createApi(), signal?: AbortSignal): Promise<Record<string, string> | null> {
  try {
    const res = await api.rpc("config.get", undefined, { write: false, ...(signal ? { signal } : {}) });
    const value = typeof res === "object" && res !== null ? (res as { value?: unknown }).value : undefined;
    return typeof value === "object" && value !== null ? settingValues(value) : null;
  } catch {
    return null;
  }
}
