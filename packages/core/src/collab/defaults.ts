import type { CollabSettings } from "./types.ts";
import { legacyCollabSettings, resolveCollabLimits } from './limits.ts';

/** ADR-003 §Collaboration guardrail table, ADR-010 §4 subagent return cap. */
export const DEFAULT_COLLAB_SETTINGS: CollabSettings = legacyCollabSettings(resolveCollabLimits());

export const SPAN_PREVIEW_CHARS = 256;
