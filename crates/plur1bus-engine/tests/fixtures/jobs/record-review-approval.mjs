import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0" && process.env.TZ === "UTC");
const pin = "3c42b39ba8d5a6522e9201c26c3cad267590636d";
const path = "lib/obsidian-control-room.js";
const source = execFileSync("git", ["-C", repo, "show", `${pin}:${path}`], { encoding: "utf8" });
const take = (begin, end) => {
  const start = source.indexOf(`function ${begin}(`);
  const stop = source.indexOf(end, start + 1);
  assert(start >= 0 && stop > start);
  return source.slice(start, stop);
};
const { payloadHash, updateReviewItemStatus, validatePayloadApproval } = await import(
  "data:text/javascript," + encodeURIComponent([
    'import { createHash } from "node:crypto";',
    take("nowIso", "function expandPath("),
    take("sha256Hex", "function firstSourceQuote("),
    take("updateReviewItemStatus", "export function updateReviewBundleItems("),
    take("validatePayloadApproval", "\n}\n") + "\n}",
    "export { payloadHash, updateReviewItemStatus, validatePayloadApproval };",
  ].join("\n")),
);
const now = 1_768_305_600_000;
const note = { text: "Synthetic source-backed note", category: "fact", sourceTrustLevel: "untrusted_obsidian" };
const makeItem = (id, payload, extra = {}) => ({
  id, type: "note_import_candidate", status: "pending", risk: "low", adversarialReview: { status: "pass" },
  applyPreview: { payload, payloadHash: payloadHash(payload) }, ...extra,
});
const cases = [
  { name: "auto", item: makeItem("auto", note), options: { approvedBy: "auto", approvalSource: "auto_low_risk" } },
  { name: "human", item: makeItem("human", note), options: { approvedBy: "operator" } },
  { name: "scope", item: makeItem("scope", { ...note, scope: "user" }), options: { approvedBy: "auto", approvalSource: "auto_low_risk" } },
  { name: "drift", item: makeItem("drift", note), options: { approvedBy: "auto", approvalSource: "auto_low_risk" }, drift: "Changed after approval" },
  { name: "utf16", item: makeItem("utf16", { "\uE000": 1.2e22, "\u{1F335}": -0, sorted: { z: 0.125, a: [true, "\ud83e"] } }), options: { approvedBy: "auto", approvalSource: "auto_low_risk" } },
];
const sha = value => createHash("sha256").update(value).digest("hex");
const record = () => JSON.stringify({
  pin, path, sourceSha256: sha(source), now,
  cases: cases.map(vector => {
    const { item: updated } = updateReviewItemStatus(structuredClone(vector.item), "approved", { now: new Date(now), ...vector.options });
    const approved = vector.options.approvalSource === "auto_low_risk"
      ? { ...updated, approvedAt: updated.approvalMetadata.approvedAt, approvedBy: "auto" }
      : updated;
    const apply = structuredClone(approved);
    if (vector.drift) apply.applyPreview.payload.text = vector.drift;
    return { ...vector, approved, verdict: validatePayloadApproval({}, apply) };
  }),
}, null, 2) + "\n";
const output = record();
assert.equal(record(), output);
writeFileSync(new URL("./review-approval.json", import.meta.url), output);
console.log(`Recorded two N3 vectors from ${pin}. SHA-256 ${sha(output)}`);
