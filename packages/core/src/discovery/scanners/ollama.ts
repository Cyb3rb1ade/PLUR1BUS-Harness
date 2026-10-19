import type { ProfileInfo } from "../ports.ts";
// Ollama wire-profile scanner (spec §2.4, R9; plan Task 4).
// GET /api/tags. Keeps tag in model name.
import type { RawEntry } from "../types.ts";
import { ScanError, type PinnedClient } from "../http.ts";
import { checkId, present, checkString, finalizeEntries } from "../validate.ts";
import type { ScanOutput, Scanner } from "./index.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const scanOllama: Scanner = async (_profile: ProfileInfo, client: PinnedClient): Promise<ScanOutput> => {
  const res = await client.get({ path: "/api/tags" });
  if (!isObj(res) || !Array.isArray(res.models)) {
    throw new ScanError("failed:invalid", "bad_envelope");
  }

  const rawEntries: RawEntry[] = res.models.map((item: unknown) => {
    if (!isObj(item)) throw new ScanError("failed:invalid", "bad_envelope");
    const id = checkId(item.name);
    let created: number | undefined;
    if (present(item.modified_at)) {
      const str = checkString(item.modified_at);
      const parsed = Date.parse(str);
      if (Number.isFinite(parsed) && parsed > 0) created = parsed;
    }

    if (isObj(item.details)) {
      if (present(item.details.family)) checkString(item.details.family);
      if (present(item.details.parameter_size)) checkString(item.details.parameter_size);
    }

    // Newer Ollama servers list per-model capabilities; `thinking` means the model takes the think switch.
    let reasoning: { supported: boolean; style: "ollama" } | undefined;
    // An optional hint: anything but an array is silence, never a failed scan.
    if (Array.isArray(item.capabilities)) reasoning = { supported: item.capabilities.includes("thinking"), style: "ollama" };

    return {
      id,
      ...(created !== undefined ? { created } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  });

  const { entries, duplicates } = finalizeEntries(rawEntries);
  return { entries, duplicates, pages: client.pages };
};
