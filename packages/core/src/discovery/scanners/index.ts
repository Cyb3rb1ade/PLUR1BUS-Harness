import type { ProfileInfo } from "../ports.ts";
// Discovery scanners for wire profiles (spec §2.4, R9; plan Task 4).
import type { DiscoveryKind, RawEntry } from "../types.ts";
import type { PinnedClient } from "../http.ts";
import { scanOpenAi } from "./openai.ts";
import { scanAnthropic } from "./anthropic.ts";
import { scanGoogle } from "./google.ts";
import { scanOllama } from "./ollama.ts";

export interface ScanOutput { entries: RawEntry[]; duplicates: number; pages: number }
export type Scanner = (profile: ProfileInfo, client: PinnedClient) => Promise<ScanOutput>;

export const SCANNERS: Readonly<Record<Exclude<DiscoveryKind, "manual">, Scanner>> = Object.freeze({
  "openai-models": scanOpenAi,
  "anthropic-models": scanAnthropic,
  "google-models": scanGoogle,
  "ollama-tags": scanOllama,
});
