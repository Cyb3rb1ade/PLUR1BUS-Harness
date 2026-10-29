// Per-family provider constraints; local tool-choice support requires evidence beyond an OpenAI-compatible wire.
export type ProviderFamily = "openai-chat" | "openai-responses" | "anthropic" | "gemini";
export interface ModelQuirks {
  family: ProviderFamily;
  parallel: boolean;
  strict: boolean;
  supportsForcedToolChoice: boolean;
  maxTools: number;
  namePattern: string;
  maxNameLength: number;
  maxDescriptionLength: number;
  malformedArguments: readonly string[];
}
// N-F1/F3: leave room for the mandatory read/discovery/memory core while retaining an explicit local catalogue cap.
// This is a harness recommendation, not a measured local-model accuracy or native server limit.
const LOCAL_CORE_MAX_TOOLS = 16;
/** Conservative defaults; model overrides are explicit data, never inferred from arbitrary substrings. */
export const QUIRKS: Readonly<Record<string, Readonly<ModelQuirks>>> = Object.freeze({
  "openai-chat": Object.freeze({
    family: "openai-chat", parallel: true, strict: true, supportsForcedToolChoice: true, maxTools: 128,
    namePattern: "^[A-Za-z0-9_-]+$", maxNameLength: 64, maxDescriptionLength: 1024,
    malformedArguments: Object.freeze(["unwrap-json-string", "trailing-comma", "numeric-string"]),
  }),
  "openai-responses": Object.freeze({
    family: "openai-responses", parallel: true, strict: true, supportsForcedToolChoice: true, maxTools: 128,
    namePattern: "^[A-Za-z0-9_-]+$", maxNameLength: 64, maxDescriptionLength: 1024,
    malformedArguments: Object.freeze(["numeric-string"]),
  }),
  anthropic: Object.freeze({
    family: "anthropic", parallel: true, strict: false, supportsForcedToolChoice: true, maxTools: 64,
    namePattern: "^[A-Za-z0-9_-]+$", maxNameLength: 64, maxDescriptionLength: 4096,
    malformedArguments: Object.freeze(["numeric-string"]),
  }),
  gemini: Object.freeze({
    family: "gemini", parallel: true, strict: false, supportsForcedToolChoice: true, maxTools: 64,
    namePattern: "^[A-Za-z_][A-Za-z0-9_-]*$", maxNameLength: 64, maxDescriptionLength: 1024,
    malformedArguments: Object.freeze(["numeric-string"]),
  }),
  "local-small": Object.freeze({
    family: "openai-chat", parallel: false, strict: false, supportsForcedToolChoice: false,
    maxTools: LOCAL_CORE_MAX_TOOLS,
    namePattern: "^[A-Za-z0-9_-]+$", maxNameLength: 64, maxDescriptionLength: 1024,
    malformedArguments: Object.freeze(["unwrap-json-string", "trailing-comma", "numeric-string"]),
  }),
});
const FALLBACK: Readonly<ModelQuirks> = Object.freeze({ ...QUIRKS["local-small"]! });
export function lookupQuirks(modelFamily: string): Readonly<ModelQuirks> {
  return Object.hasOwn(QUIRKS, modelFamily) ? QUIRKS[modelFamily]! : FALLBACK;
}
