/** Consent for activation includes every installed bundle child and its original verified disclosures. */
import type { ExtDetail, ExtEnableParams } from "../common/surfaces-rpc.ts";
import { inspectionIdentity } from "./install-model.ts";

export type EnableConsentDetail = ExtDetail;

/** Inert wrapper capabilities can never substitute for a missing or mismatched installed child. */
export function enableConsentReady(detail: EnableConsentDetail): boolean {
  if (detail.item.kind !== "bundle") return true;
  if (typeof detail.consentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(detail.consentSha256)) return false;
  const summaries = detail.members ?? detail.item.members ?? [],
    children = detail.memberInspections ?? [];
  if (!summaries.length || summaries.length !== children.length) return false;
  if (
    detail.members &&
    detail.item.members &&
    inspectionIdentity(detail.members) !== inspectionIdentity(detail.item.members)
  )
    return false;
  const names = new Set(children.map((child) => child.name));
  if (names.size !== children.length || new Set(summaries.map((child) => child.name)).size !== summaries.length)
    return false;
  return summaries.every((summary) => {
    const child = children.find((candidate) => candidate.name === summary.name);
    return (
      !!child &&
      child.kind === summary.kind &&
      child.version === summary.version &&
      child.sha256 === summary.sha256 &&
      child.optional === summary.optional &&
      child.checks.every((check) => check.status !== "fail")
    );
  });
}

/** Compare the actual disclosures, including child digests and rights, immediately before activation. */
export function enableConsentIdentity(detail: EnableConsentDetail): string {
  return inspectionIdentity({
    name: detail.item.name,
    kind: detail.item.kind,
    version: detail.item.version,
    integrity: detail.item.integrity,
    manifest: detail.manifest,
    capabilities: detail.capabilities,
    scripts: detail.scripts,
    trust: detail.trust,
    ...(detail.item.kind === "bundle"
      ? {
          members: detail.members ?? detail.item.members,
          itemMembers: detail.item.members,
          memberInspections: detail.memberInspections,
          consentSha256: detail.consentSha256,
        }
      : {}),
  });
}

/** The native transaction rechecks this complete bundle consent subject under its mutation lock. */
export function enableParameters(
  detail: EnableConsentDetail,
  agents?: ExtEnableParams["agents"],
): ExtEnableParams {
  if (!enableConsentReady(detail) || (Array.isArray(agents) && agents.length === 0))
    throw new Error("enable-consent-required");
  return {
    name: detail.item.name,
    acknowledge: ["capabilities"],
    ...(agents === undefined ? {} : { agents }),
    ...(detail.item.kind === "bundle" ? { expectedConsentSha256: detail.consentSha256! } : {}),
  };
}
