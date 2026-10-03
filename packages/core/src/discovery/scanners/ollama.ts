import type { ProfileInfo } from "../ports.ts";
// Ollama wire-profile scanner (spec §2.4, R9; plan Task 4).
// GET /api/tags. Keeps tag in model name.
import type { RawEntry } from "../types.ts";
import { ScanError, type PinnedClient } from "../http.ts";
import { checkId, checkString, finalizeEntries } from "../validate.ts";
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
    if (item.modified_at !== undefined) {
      const str = checkString(item.modified_at);
      const parsed = Date.parse(str);
      if (Number.isFinite(parsed) && parsed > 0) created = parsed;
    }

    if (isObj(item.details)) {
      if (item.details.family !== undefined) checkString(item.details.family);
      if (item.details.parameter_size !== undefined) checkString(item.details.parameter_size);
    }

    return {
      id,
      ...(created !== undefined ? { created } : {}),
    };
  });

  const { entries, duplicates } = finalizeEntries(rawEntries);
  return { entries, duplicates, pages: client.pages };
};
