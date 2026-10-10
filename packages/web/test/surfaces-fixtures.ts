import type { MockRpc } from "./mock-rpc.ts";
import type {
  ExtItem,
  ExtDetail,
  ExtInspection,
  ApprovalRecord,
  GrantRecord,
  JobsListResult,
  JobRun,
  SystemJobRun,
} from "../src/pages/common/surfaces-rpc.ts";

export const sampleSkills: ExtItem[] = [
  {
    name: "github-tools",
    id: "plur1bus/github-tools",
    kind: "skill",
    version: "1.0.0",
    source: "file",
    trust: "release",
    state: "enabled",
    overlays: [],
    enabled: true,
    agents: "all",
  },
  {
    name: "code-analysis",
    id: "local/code-analysis",
    kind: "skill",
    version: "0.2.1",
    source: "local",
    trust: "dev",
    state: "installed",
    overlays: ["needs-setup"],
    enabled: false,
    agents: ["coder-agent"],
  },
];

export const samplePlugins: ExtItem[] = [
  {
    name: "telegram-channel",
    id: "plur1bus/telegram-channel",
    kind: "channel",
    version: "1.2.0",
    source: "file",
    trust: "release",
    state: "enabled",
    overlays: [],
    enabled: true,
    agents: "all",
  },
  {
    name: "auth-oauth",
    id: "plur1bus/auth-oauth",
    kind: "module",
    version: "2.0.0",
    source: "file",
    trust: "first-party",
    state: "installed",
    overlays: [],
    enabled: false,
    agents: "all",
  },
];

export const sampleApprovals: ApprovalRecord[] = [
  {
    id: "apr_0123456789abcdef01234567",
    status: "pending",
    capability: "fs.delete",
    tool: "rm_dir",
    risk: "high",
    reversible: false,
    principal: "usr_owner",
    subject: { kind: "agent", id: "assistant" },
    actionHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    targets: ["/srv/data/archive/old_backups"],
    summary: 'rm -rf "/srv/data/archive/old_backups"',
    agentReason: "Cleaning up legacy backups to free disk space.",
    createdAt: "2026-10-10T12:00:00Z",
    expiresAt: "2026-10-11T12:00:00Z",
    delegable: false,
    grantOptions: [
      { scope: "once", requiredSurface: 1 },
      { scope: "task", requiredSurface: 2 },
      { scope: "always", requiredSurface: 2 },
    ],
  },
];

export const sampleGrants: GrantRecord[] = [
  {
    id: "grt_0123456789abcdef01234567",
    capability: "fs.read",
    person: "usr_owner",
    agent: "assistant",
    scope: "always",
    match: { kind: "capability" },
    state: "active",
    createdBy: "usr_owner",
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: "2026-12-30T10:00:00Z",
    delegable: true,
    surface: 2,
    attestedVia: "attested:touch-id",
  },
];

export const sampleJobs: JobsListResult["jobs"] = [
  {
    name: "consolidate",
    needsLlm: false,
    singleton: true,
    kind: "agent",
    schedule: { every: 3600000, jitter: 0.1 },
    nextRunAt: Date.now() + 1800000,
  },
  {
    name: "models.scan",
    needsLlm: false,
    singleton: true,
    kind: "system",
    schedule: { every: 86400000, jitter: 0.05 },
    nextRunAt: Date.now() + 72000000,
  },
];

export const sampleHistory: (JobRun | SystemJobRun)[] = [
  {
    runId: "run_999888777",
    job: "consolidate",
    agentId: "agt_main",
    trigger: "cron",
    outcome: "completed",
    startedAt: Date.now() - 3600000,
    finishedAt: Date.now() - 3595000,
    durationMs: 5000,
    attempt: 1,
  },
];

export function seedExtensions(
  rpc: MockRpc,
  items: ExtItem[] = [...sampleSkills, ...samplePlugins]
): void {
  rpc.handle("ext.list", () => ({ items }), { write: false });
  rpc.handle("ext.show", (params) => {
    const { name } = params as { name: string };
    const it = items.find((x) => x.name === name) || items[0]!;
    const detail: ExtDetail = {
      item: it,
      manifest: { name: it.name, version: it.version },
      capabilities: { network: "none", filesystem: ["read"] },
      scripts: [],
      trust: { tier: it.trust, label: it.trust },
      files: { count: 12, bytes: 45000 },
      dependents: [],
      trash: [{ trashId: `trash_${it.name}_1`, version: it.version, removedAt: "2026-10-09T08:00:00Z" }],
    };
    return detail;
  }, { write: false });
  rpc.handle("ext.inspect", () => {
    const insp: ExtInspection = {
      inspectionId: "insp_test_123",
      expiresAt: "2026-10-10T16:00:00Z",
      sha256: "abcdef1234567890abcdef1234567890",
      manifest: { id: "test/uploaded", version: "1.0.0" },
      trust: { tier: "unsigned", label: "unsigned" },
      checks: [{ id: "size", status: "pass", detail: "ok" }],
      capabilities: { network: "any" },
      scripts: [],
      requires: {},
    };
    return insp;
  }, { write: false });
  rpc.handle("ext.install", () => ({ name: "test-uploaded", version: "1.0.0" }));
  rpc.handle("ext.uninstall", (params) => {
    const { name } = params as { name: string };
    return { name, trashId: `trash_${name}_now` };
  });
  rpc.handle("ext.restore", () => ({ name: "restored-ext", version: "1.0.0" }));
  rpc.handle("ext.enable", (params) => {
    const { name } = params as { name: string };
    const it = items.find((x) => x.name === name);
    if (it) { it.enabled = true; it.state = "enabled"; }
    return { name, state: "enabled", restart: { modules: [] }, heldBack: [] };
  });
  rpc.handle("ext.disable", (params) => {
    const { name } = params as { name: string };
    const it = items.find((x) => x.name === name);
    if (it) { it.enabled = false; it.state = "installed"; }
    return { name, state: "installed", restart: { modules: [] }, heldBack: [] };
  });
  rpc.handle("ext.watch", () => ({ items }), { write: false });
}

export function seedApprovals(
  rpc: MockRpc,
  approvals: ApprovalRecord[] = sampleApprovals,
  grants: GrantRecord[] = sampleGrants
): void {
  rpc.handle("approval.list", () => ({ approvals }), { write: false });
  rpc.handle("approval.get", (params) => {
    const { id } = params as { id: string };
    return approvals.find((a) => a.id === id) || approvals[0]!;
  }, { write: false });
  rpc.handle("approval.decide", (params) => {
    const { id, decision } = params as { id: string; decision: "approve" | "deny" };
    const apr = approvals.find((a) => a.id === id) || approvals[0]!;
    return { approval: { ...apr, status: decision === "approve" ? "approved" : "denied" } };
  });
  rpc.handle("approval.cancel", (params) => {
    const { id } = params as { id: string };
    const apr = approvals.find((a) => a.id === id) || approvals[0]!;
    return { ...apr, status: "cancelled" };
  });
  rpc.handle("grant.list", () => ({ grants }), { write: false });
  rpc.handle("grant.revoke", (params) => {
    const { id } = params as { id: string };
    const g = grants.find((x) => x.id === id) || grants[0]!;
    return { ...g, state: "revoked" };
  });
}

export function seedJobs(
  rpc: MockRpc,
  jobs: JobsListResult["jobs"] = sampleJobs,
  history: (JobRun | SystemJobRun)[] = sampleHistory
): void {
  rpc.handle("jobs.list", () => ({ jobs }), { write: false });
  rpc.handle("jobs.history", () => ({ runs: history }), { write: false });
  rpc.handle("jobs.run", (params) => {
    const { job } = params as { job: string };
    return {
      runId: `run_${Date.now()}`,
      job,
      trigger: "manual",
      outcome: "completed",
      startedAt: Date.now(),
      finishedAt: Date.now() + 100,
      durationMs: 100,
    };
  });
}
