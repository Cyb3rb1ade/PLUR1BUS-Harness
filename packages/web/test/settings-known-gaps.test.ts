// Settings: gaps found in the c18 audit that cannot be closed inside src/pages/settings (they need the router, the shared
// palette or a wire change). Each is a todo until its owner closes it.
import { describe, test } from "node:test";

describe("settings: known gaps", () => {
  test.todo("KNOWN GAP: no x-sensitive marker exists in config.schema.json, so the UI cannot tell secret-bearing keys from the schema; it relies on key names (config/model.ts isSecretKey)");
});
