/** Skill replay respects the compactor's covered history instead of resurrecting omitted tool bodies. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { skillHistoryMessages } from "../../src/composition/skill-history.ts";
import { turnRequest } from "./helpers.ts";

it("does not reinsert an anchored skill body whose original turn was compacted away", () => {
  const request = turnRequest({ summaries: ["Earlier task summarized"],
    messages: [{ role: "user", text: "Current task", turnId: "current" }] });
  const messages = skillHistoryMessages(request, [{
    id: "old-load", turnId: "old", name: "reports", text: "OLD_SKILL_BODY",
  }]);
  assert.deepEqual(messages, [{ role: "user", content: "Current task" }]);
});

it("keeps covered skill pairs and makes repeated call IDs from separate turns unambiguous", () => {
  const request = turnRequest({ messages: [
    { role: "user", text: "One", turnId: "one" }, { role: "user", text: "Two", turnId: "two" },
  ] });
  const messages = skillHistoryMessages(request, [
    { id: "same", turnId: "one", name: "reports", text: "BODY ONE" },
    { id: "same", turnId: "two", name: "coding", text: "BODY TWO" },
  ]);
  const results = messages.filter(message => message.role === "tool");
  assert.equal(results.length, 2);
  assert.notEqual(results[0]?.toolCallId, results[1]?.toolCallId);
  assert.deepEqual(results.map(result => result.content), ["BODY ONE", "BODY TWO"]);
});
