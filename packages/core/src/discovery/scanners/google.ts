import type { ProfileInfo } from "../ports.ts";
// Google wire-profile scanner (spec §2.4, R9; plan Task 4).
// GET /models?pageSize=1000, next page adds pageToken=<nextPageToken>. Key travels in lease header (x-goog-api-key).
import type { ModelKind, RawEntry } from "../types.ts";
import { ScanError, type PinnedClient } from "../http.ts";
import { checkId, present, checkPositiveInt, checkString, finalizeEntries } from "../validate.ts";
import type { ScanOutput, Scanner } from "./index.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const scanGoogle: Scanner = async (_profile: ProfileInfo, client: PinnedClient): Promise<ScanOutput> => {
  const allEntries: RawEntry[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const query: Record<string, string> = { pageSize: "1000" };
    if (pageToken !== undefined) query.pageToken = pageToken;

    const res = await client.get({ path: "/models", query });
    if (!isObj(res) || !Array.isArray(res.models)) {
      throw new ScanError("failed:invalid", "bad_envelope");
    }

    for (const item of res.models) {
      if (!isObj(item)) throw new ScanError("failed:invalid", "bad_envelope");
      let nameStr = checkString(item.name);
      if (nameStr.startsWith("models/")) nameStr = nameStr.slice("models/".length);
      const id = checkId(nameStr);
      const displayName = present(item.displayName) ? checkString(item.displayName) : undefined;
      const contextWindow = present(item.inputTokenLimit) ? checkPositiveInt(item.inputTokenLimit) : undefined;

      let kind: ModelKind | undefined;
      if (Array.isArray(item.supportedGenerationMethods)) {
        const methods = item.supportedGenerationMethods;
        if (methods.includes("embedContent") && !methods.includes("generateContent")) {
          kind = "embedding";
        }
      }

      // Gemini model metadata carries `thinking: true|false` for models that take a thinking configuration
      // (an optional hint: any other value is treated as silence, never as a failed scan).
      const reasoning = typeof item.thinking === "boolean" ? { supported: item.thinking, style: "gemini" as const } : undefined;

      allEntries.push({
        id,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(kind !== undefined ? { kind } : {}),
      });
    }

    if (typeof res.nextPageToken !== "string" || res.nextPageToken === "") break;
    const nextCursor = checkString(res.nextPageToken);
    if (nextCursor === pageToken) throw new ScanError("failed:invalid", "bad_envelope");
    pageToken = nextCursor;
  }

  const { entries, duplicates } = finalizeEntries(allEntries);
  return { entries, duplicates, pages: client.pages };
};
