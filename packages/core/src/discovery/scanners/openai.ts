import type { ProfileInfo } from "../ports.ts";
// OpenAI wire-profile scanner (spec §2.4, R9; plan Task 4).
// Covers OpenAI, OpenRouter, LM Studio, mlx-lm, oMLX, vLLM and generic compatible endpoints.
import type { Capability, RawEntry } from "../types.ts";
import { ScanError, type PinnedClient } from "../http.ts";
import { checkId, checkPositiveInt, checkString, finalizeEntries } from "../validate.ts";
import type { ScanOutput, Scanner } from "./index.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const scanOpenAi: Scanner = async (_profile: ProfileInfo, client: PinnedClient): Promise<ScanOutput> => {
  const res = await client.get({ path: "/models" });
  if (!isObj(res) || !Array.isArray(res.data)) {
    throw new ScanError("failed:invalid", "bad_envelope");
  }

  const rawEntries: RawEntry[] = res.data.map((item: unknown) => {
    if (!isObj(item)) throw new ScanError("failed:invalid", "bad_envelope");
    const id = checkId(item.id);
    const created = item.created !== undefined ? checkPositiveInt(item.created) * 1000 : undefined;

    // OpenRouter-style extras whitelist
    const displayName = item.name !== undefined ? checkString(item.name) : undefined;
    const contextWindow = item.context_length !== undefined ? checkPositiveInt(item.context_length) : undefined;

    const capabilities: Capability[] = [];
    if (Array.isArray(item.supported_parameters)) {
      if (item.supported_parameters.includes("tools")) capabilities.push("tools");
      if (item.supported_parameters.includes("structured_outputs")) capabilities.push("structured_output");
      if (item.supported_parameters.includes("reasoning")) capabilities.push("reasoning");
    }

    if (isObj(item.architecture) && typeof item.architecture.modality === "string") {
      const inputSide = item.architecture.modality.split("->")[0] ?? "";
      if (inputSide.includes("image")) capabilities.push("vision");
    }

    return {
      id,
      ...(created !== undefined ? { created } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
    };
  });

  const { entries, duplicates } = finalizeEntries(rawEntries);
  return { entries, duplicates, pages: client.pages };
};
