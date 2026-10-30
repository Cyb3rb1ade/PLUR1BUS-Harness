/** Pure consent requirements bind bundle member selection, trust warnings, replacement and activation. */
import type { ExtAgents, ExtInspection, ExtInstallParams } from "../../../../rpc-schema/generated/types.ts";

export interface InstallationAcknowledgement {
  capabilities: boolean;
  trust: boolean;
  replacement: boolean;
}
/** Resolves a deterministic subset; omitted optional children never contribute authority or acknowledgement. */
function bundleSelection(inspection: ExtInspection, selection?: readonly string[]) {
  const bundle = (inspection.manifest as { kind?: unknown }).kind === "bundle";
  if (!bundle)
    return {
      bundle,
      valid: selection === undefined,
      members: [] as NonNullable<ExtInspection["members"]>,
      names: [] as string[],
    };
  const all = inspection.members ?? [],
    names = selection ?? all.filter((member) => !member.optional).map((member) => member.name);
  const wanted = new Set(names),
    known = new Set(all.map((member) => member.name));
  const valid =
    all.length > 0 &&
    known.size === all.length &&
    wanted.size === names.length &&
    names.every((name) => known.has(name)) &&
    all.every((member) => member.optional || wanted.has(member.name));
  const members = all.filter((member) => wanted.has(member.name));
  return { bundle, valid, members, names: members.map((member) => member.name) };
}
/** Aggregates only the selected children's normal checks; wrapper signatures never promote child trust. */
export function installationRequirements(inspection: ExtInspection, selection?: readonly string[]) {
  const chosen = bundleSelection(inspection, selection),
    packages = [inspection, ...chosen.members];
  const unsigned = packages.some((pkg) => pkg.trust.tier === "unsigned"),
    unknownSigner = packages.some((pkg) => pkg.trust.tier === "unknown-signer");
  return {
    firstParty: inspection.trust.tier === "first-party",
    trust: unsigned || unknownSigner,
    unsigned,
    unknownSigner,
    replacement: packages.some((pkg) => pkg.replaces !== undefined),
    missingMembers: chosen.bundle && !inspection.members?.length,
    blocked: !chosen.valid || packages.some((pkg) => pkg.checks.some((check) => check.status === "fail")),
  };
}
export function installationButton(
  inspection: ExtInspection,
): "extensions.install.normal" | "extensions.install.unsigned" | "extensions.install.unknownSigner" {
  return inspection.trust.tier === "unsigned"
    ? "extensions.install.unsigned"
    : inspection.trust.tier === "unknown-signer"
      ? "extensions.install.unknownSigner"
      : "extensions.install.normal";
}
export function installationParams(
  inspection: ExtInspection,
  accepted: InstallationAcknowledgement,
  agents?: ExtAgents,
  members?: readonly string[],
): ExtInstallParams {
  const chosen = bundleSelection(inspection, members);
  if (chosen.bundle && members === undefined) throw new Error("bundle selection required");
  const required = installationRequirements(inspection, members);
  if (
    required.blocked ||
    !accepted.capabilities ||
    (required.trust && !accepted.trust) ||
    (required.replacement && !accepted.replacement)
  )
    throw new Error("installation consent required");
  if (agents !== undefined && (required.firstParty || (Array.isArray(agents) && agents.length === 0)))
    throw new Error("invalid installation activation");
  const acknowledge: NonNullable<ExtInstallParams["acknowledge"]> = ["capabilities"];
  if (required.unsigned) acknowledge.push("unsigned");
  if (required.unknownSigner) acknowledge.push("unknown-signer");
  if (required.replacement) acknowledge.push("downgrade");
  return {
    inspectionId: inspection.inspectionId,
    acknowledge,
    ...(chosen.bundle ? { members: chosen.names } : {}),
    ...(agents === undefined ? {} : { enable: { agents } }),
  };
}
/** What the human approved is compared with a fresh owned inspection immediately before mutation. */
export function inspectionIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inspectionIdentity).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${inspectionIdentity((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
