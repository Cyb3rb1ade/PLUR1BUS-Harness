// Runtime warnings contain bounded schema keys and guidance, never the configured values or validator payloads.
import type { ConfigWarning } from "@plur1bus/config-schema";
import type { HarnessLogger } from "./logger.ts";

const MAX_WARNINGS = 50;
const MAX_KEY_CHARS = 256;
const MAX_GUIDANCE_CHARS = 512;

/** Deliver one bounded warning batch through the active or queued startup logger. */
export function logConfigWarnings(logger: Pick<HarnessLogger, "warn"> | undefined, warnings: readonly ConfigWarning[]): void {
  for (const { key, message } of warnings.slice(0, MAX_WARNINGS)) {
    logger?.warn("configuration warning", {
      key: key.slice(0, MAX_KEY_CHARS), guidance: message.slice(0, MAX_GUIDANCE_CHARS),
    });
  }
}
