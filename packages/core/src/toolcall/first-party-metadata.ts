// N-C6: trusted discovery metadata for the tools shipped by the harness. Registration and policy remain at composition.
import { SPECS } from "../../../hostctl/src/index.ts";
import { HOST_TOOLS } from "../host-tools/catalog.ts";
import type { ToolDef } from "../tools/registry.ts";
import { FS_CAPABILITIES } from "../tools/fs/tools.ts";
import { WEB_CAPABILITIES } from "../tools/web/tools.ts";

type Discovery = NonNullable<ToolDef["discovery"]>;

const POLICY_SCOPE = "Operations outside the dispatcher's policy, granted roots or approving person's authority.";

function metadata(category: string, summary: string, useWhen: string, notFor = POLICY_SCOPE): Discovery {
  return { kind: "tool", category, summary, useWhen, notFor };
}

const EXPLICIT: Readonly<Record<string, Discovery>> = {
  "exec.run": metadata("ops.process", "Run an enabled program with bounded arguments inside a granted folder.",
    "Run a local command required to inspect, build, test or change an authorized project."),
  secret_names: metadata("plur1bus.configure", "List this agent's available secret names, scopes and presence without values.",
    "Check which configured secret name an authorized integration can use.", "Revealing secret values or credentials."),
  "document.render": metadata("docs.create", "Render a designed document with an approved template and review its layout.",
    "Create a PDF report, proposal, letter, invoice, CV or presentation for the person."),
  "image.generate": metadata("media.image", "Generate an image and return a durable media reference.",
    "Create a requested illustration, photograph, diagram or other new image."),
  "image.edit": metadata("media.image", "Edit reference images and return a durable media reference.",
    "Change a supplied image while keeping the requested reference content."),
  "media.generate": metadata("media.video", "Generate image or video media and return a durable output reference.",
    "Create requested visual media with the configured generation backend."),
  "media.edit": metadata("media.video", "Edit image or video references and return a durable output reference.",
    "Transform supplied visual media with the configured editing backend."),
  consult_agent: metadata("project.delegate", "Ask an authorized project peer for advice.",
    "Get focused advice from a peer while retaining ownership of the current task."),
  delegate_task: metadata("project.delegate", "Delegate an authorized project task through the shared target port.",
    "Assign a bounded independent task to another available agent."),
  request_review: metadata("code.review", "Request independent project peer review with evidence.",
    "Have another agent review an implementation or other completed project work."),
  handoff: metadata("project.delegate", "Transfer task ownership after the receiving agent acknowledges.",
    "Pass responsibility for the current authorized project task to another agent."),
  post_to_project: metadata("project.track", "Post a comment to an authorized existing project card.",
    "Record progress, findings or evidence on the project's existing work card."),
  read_project_board: metadata("project.track", "Read the authorized project's board, columns and cards.",
    "Inspect current project work and card state before choosing or updating a task."),
  coding_complete: metadata("code.test", "Verify format, lint, type checks, tests and review before completing a coding card.",
    "Finish an assigned coding card after independent verification of the current worktree."),
  "capabilities.search": metadata("plur1bus.extensions", "Find available tools and skills by their discovery metadata.",
    "Discover a tool or skill when the currently offered capabilities do not clearly fit."),
  "skill.load": metadata("plur1bus.extensions", "Load an available skill's instructions and list its supporting files.",
    "An available skill matches the task and its instructions are needed before acting."),
  "skill.read": metadata("plur1bus.extensions", "Read a supporting file within an available skill's folder.",
    "A loaded skill asks for a reference, playbook, script source or other supporting file.",
    "Executing scripts; use an authorized execution tool for that."),
};

const HOST_FAMILIES: Readonly<Record<string, { category: string; useWhen: string }>> = {
  fs: { category: "files.manage", useWhen: "Inspect or change a local file inside the person's granted folders." },
  proc: { category: "ops.process", useWhen: "Inspect, run or manage an authorized local process." },
  sys: { category: "ops.system", useWhen: "Inspect the current computer's hardware, operating system or service health." },
  pkg: { category: "ops.package", useWhen: "Inspect or manage software packages with the computer's package manager." },
  apps: { category: "os.apps", useWhen: "Find or manage a local desktop application." },
  app: { category: "os.apps", useWhen: "Open an authorized local document or web URL in its desktop application." },
  clipboard: { category: "os.apps", useWhen: "Read or update the person's local clipboard with dispatcher approval." },
  notify: { category: "comm.notify", useWhen: "Display a requested local desktop notification." },
};

function hostMetadata(name: string, summary: string): Discovery | undefined {
  const local = name.replace(/^hostctl\./, "");
  const family = HOST_FAMILIES[local.split(".")[0]!];
  if (!family) return undefined;
  let category = family.category;
  if (local === "sys.network") category = "ops.network";
  if (local === "sys.services") category = "ops.service";
  return metadata(category, summary, family.useWhen);
}

const SHIPPED = new Map<string, Discovery>(Object.entries(EXPLICIT));
for (const row of WEB_CAPABILITIES) {
  SHIPPED.set(row.name, metadata(row.category.primary, row.summary, row.useWhen, row.notFor));
}
for (const row of FS_CAPABILITIES) {
  SHIPPED.set(row.name, metadata(row.name === "file.read" ? "files.read" : "files.manage",
    row.summary, row.useWhen, row.notFor));
}
for (const tool of HOST_TOOLS) {
  const discovery = hostMetadata(tool.name, tool.description);
  if (discovery) SHIPPED.set(tool.name, discovery);
}
for (const [name, spec] of Object.entries(SPECS)) {
  const discovery = hostMetadata(`hostctl.${name}`, spec.description);
  if (discovery) SHIPPED.set(`hostctl.${name}`, discovery);
}
for (const operation of ["recall", "capture", "correct", "share", "dream", "manage"]) {
  SHIPPED.set(`memory.${operation}`, metadata(`memory.${operation}`,
    `Use the authorized memory ${operation} operation.`,
    "Read or maintain the person's relevant saved memory with the requested scope."));
}

/** Return isolated authored metadata for a shipped tool name; unknown and third-party names remain unclassified. */
export function firstPartyDiscovery(name: string): Discovery | undefined {
  const discovery = SHIPPED.get(name);
  return discovery ? { ...discovery } : undefined;
}
