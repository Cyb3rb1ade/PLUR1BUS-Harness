import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeMessage } from "../src/models/runtime-message.ts";
test("runtime errors and remote endpoint notes have de/en messages", () => {
 for (const code of ["not-found","too-old","no-access","wrong-mode","stopped","object-missing","conflict","timeout","failed","remote-endpoint-ignored"]) {
  for (const locale of ["de","en"] as const) assert.ok(runtimeMessage(locale,`runtime.${code}`).length > 10);
 }
 assert.equal(runtimeMessage("de", "<arbitrary engine output>"), runtimeMessage("de", "runtime.failed"));
});
