// Settings: gaps found in the c18 audit that cannot be closed inside src/pages/settings (they need the router, the shared
// palette or a wire change). Each is a todo until its owner closes it.
import { describe, test } from "node:test";

describe("settings: known gaps", () => {
  test.todo("KNOWN GAP: leaving Settings through the sidebar, the palette or the browser back button drops unsaved config edits without asking (needs a router-level navigation guard; only the Settings section links and beforeunload ask)");
  test.todo("KNOWN GAP: the pairing QR generator stops at version 10 (213 bytes); pairing.qr accepts links up to 2331 bytes, longer ones show only the link");
  test.todo("KNOWN GAP: Users > Rights save sends the role name as userId to agent.rights.set and never sends null for a removed right, so rights cannot be taken away from this panel (the panel is marked as a draft; needs per-user rights and the loaded state from agent.rights.get)");
  test.todo("KNOWN GAP: the palette's settings index hides values by the key/token/secret/password/credential name heuristic only (src/palette/match.ts isSensitiveKey); keys such as authorization or cookie would be indexed with their value");
  test.todo("KNOWN GAP: no x-sensitive marker exists in config.schema.json, so the UI cannot tell secret-bearing keys from the schema; it relies on key names (config/model.ts isSecretKey)");
});
