import type { ProfileInfo } from "../ports.ts";
// Anthropic wire-profile scanner (spec §2.4, R9; plan Task 4).
// GET /models?limit=1000, next page adds after_id=<last_id> while has_more, header anthropic-version: 2023-06-01.
import type { RawEntry } from "../types.ts";
import { ScanError, type PinnedClient } from "../http.ts";
import { checkId, checkPositiveInt, checkString, finalizeEntries } from "../validate.ts";
import type { ScanOutput, Scanner } from "./index.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const scanAnthropic: Scanner = async (_profile: ProfileInfo, client: PinnedClient): Promise<ScanOutput> => {
  const allEntries: RawEntry[] = [];
  let afterId: string | undefined;

  for (;;) {
    const query: Record<string, string> = { limit: "1000" };
    if (afterId !== undefined) query.after_id = afterId;

    const res = await client.get({ path: "/models", query }, { "anthropic-version": "2023-06-01" });
    if (!isObj(res) || !Array.isArray(res.data) || typeof res.has_more !== "boolean") {
      throw new ScanError("failed:invalid", "bad_envelope");
    }

    for (const item of res.data) {
      if (!isObj(item)) throw new ScanError("failed:invalid", "bad_envelope");
      const id = checkId(item.id);
      const displayName = item.display_name !== undefined ? checkString(item.display_name) : undefined;
      let created: number | undefined;
      if (item.created_at !== undefined) {
        const str = checkString(item.created_at);
        const parsed = Date.parse(str);
        if (Number.isFinite(parsed) && parsed > 0) created = parsed;
      }
      const contextWindow = item.max_input_tokens !== undefined ? checkPositiveInt(item.max_input_tokens) : undefined;

      allEntries.push({
        id,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(created !== undefined ? { created } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      });
    }

    if (!res.has_more) break;
    if (typeof res.last_id !== "string" || res.last_id === "") {
      throw new ScanError("failed:invalid", "bad_envelope");
    }
    afterId = res.last_id;
  }

  const { entries, duplicates } = finalizeEntries(allEntries);
  return { entries, duplicates, pages: client.pages };
};
