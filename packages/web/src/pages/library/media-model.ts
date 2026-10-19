// Pure rules of the Library's generate/edit/jobs/preferences parts: reading media.adapters.list, deriving the parameter form
// from what an adapter advertises, building the media.generate/media.edit params, reading jobs and classifying failures.
// No DOM and no RPC in here (docs/media.md "MG-3 surfaces", docs/errors.md).

export type Kind = "image" | "video";
export type Operation = "generate" | "edit" | "inpaint" | "videoEdit" | "imageToVideo";

export interface VideoCaps {
  textToVideo: boolean;
  imageToVideo: boolean;
  videoToVideo: boolean;
  durationSeconds?: [number, number];
  resolutions?: string[];
  aspects?: string[];
  fps?: number[];
  audio?: boolean;
}

/** One form field, either advertised by the adapter (`capabilities.params`) or derived from its capabilities. */
export type ParamSpec =
  | { key: string; type: "int" | "number"; min?: number; max?: number; label?: string }
  | { key: string; type: "enum"; options: string[]; numeric?: boolean; label?: string }
  | { key: string; type: "bool"; label?: string }
  | { key: string; type: "size"; max: number; label?: string };

export interface Adapter {
  id: string;
  model: string;
  generate: boolean;
  edit: boolean;
  inpaint: boolean;
  video: VideoCaps | null;
  /** Anything the backend marks local; every other adapter counts as sending data out. */
  local: boolean;
  /** Parameters the adapter spells out itself; when present they replace the derived ones. */
  params: ParamSpec[] | null;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

function parseVideo(v: unknown): VideoCaps | null {
  const o = rec(v);
  const caps: VideoCaps = { textToVideo: o["textToVideo"] === true, imageToVideo: o["imageToVideo"] === true, videoToVideo: o["videoToVideo"] === true };
  if (!caps.textToVideo && !caps.imageToVideo && !caps.videoToVideo) return null;
  const d = o["durationSeconds"];
  if (Array.isArray(d) && typeof d[0] === "number" && typeof d[1] === "number") caps.durationSeconds = [d[0], d[1]];
  const resolutions = strs(o["resolutions"]);
  if (resolutions?.length) caps.resolutions = resolutions;
  const aspects = strs(o["aspects"]);
  if (aspects?.length) caps.aspects = aspects;
  if (Array.isArray(o["fps"])) {
    const fps = o["fps"].filter((x): x is number => typeof x === "number");
    if (fps.length) caps.fps = fps;
  }
  if (o["audio"] === true) caps.audio = true;
  return caps;
}

function parseParams(v: unknown): ParamSpec[] | null {
  if (!Array.isArray(v)) return null;
  const out: ParamSpec[] = [];
  for (const raw of v) {
    const o = rec(raw);
    const key = str(o["key"]);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    const label = str(o["label"]) || undefined;
    const base = label ? { label } : {};
    const type = o["type"];
    if (type === "int" || type === "number") {
      const min = num(o["min"]), max = num(o["max"]);
      out.push({ key, type, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...base });
    } else if (type === "enum") {
      const options = Array.isArray(o["options"]) ? o["options"].map((x) => String(x)) : [];
      if (options.length) out.push({ key, type, options, ...(Array.isArray(o["options"]) && o["options"].every((x) => typeof x === "number") ? { numeric: true } : {}), ...base });
    } else if (type === "bool") out.push({ key, type, ...base });
  }
  return out;
}

/** media.adapters.list → adapters. Unknown or malformed rows are dropped; nothing is invented for missing fields. */
export function parseAdapters(v: unknown): Adapter[] {
  const list = rec(v)["adapters"];
  if (!Array.isArray(list)) return [];
  const out: Adapter[] = [];
  for (const raw of list) {
    const o = rec(raw);
    const id = str(o["id"]);
    if (!id) continue;
    const caps = rec(o["capabilities"]);
    out.push({
      id,
      model: str(o["model"]),
      generate: caps["generate"] === true,
      edit: caps["edit"] === true,
      inpaint: caps["inpaint"] === true,
      video: parseVideo(caps["video"]),
      local: o["local"] === true || o["where"] === "local" || caps["local"] === true,
      params: parseParams(caps["params"]),
    });
  }
  return out;
}

/** Operations an adapter offers for `kind`. Nothing the adapter does not advertise is listed. */
export function generateKinds(adapters: readonly Adapter[]): Kind[] {
  const kinds: Kind[] = [];
  if (adapters.some((a) => a.generate)) kinds.push("image");
  if (adapters.some((a) => a.video?.textToVideo)) kinds.push("video");
  return kinds;
}

export function adaptersFor(adapters: readonly Adapter[], kind: Kind): Adapter[] {
  return adapters.filter((a) => (kind === "video" ? a.video?.textToVideo === true : a.generate));
}

export type EditOp = { op: Operation; kind: Kind; needsMask: boolean };

/** What can be done with an existing medium of `mediumKind`, from the adapter's capabilities. */
export function editOperations(adapter: Adapter, mediumKind: Kind | "audio"): EditOp[] {
  const ops: EditOp[] = [];
  if (mediumKind === "image") {
    if (adapter.edit) ops.push({ op: "edit", kind: "image", needsMask: false });
    if (adapter.edit && adapter.inpaint) ops.push({ op: "inpaint", kind: "image", needsMask: true });
    if (adapter.video?.imageToVideo) ops.push({ op: "imageToVideo", kind: "video", needsMask: false });
  } else if (mediumKind === "video") {
    if (adapter.video?.videoToVideo) ops.push({ op: "videoEdit", kind: "video", needsMask: false });
  }
  return ops;
}

const IMAGE_FORMATS = ["png", "jpeg", "webp"];

/** The form for `kind` on `adapter`. The adapter's own `params` win; otherwise image parameters are the closed set of the
 *  media.generate request (docs/rpc.md) and video parameters come from the advertised video ranges and lists. */
export function paramSpecs(adapter: Adapter, kind: Kind): ParamSpec[] {
  if (adapter.params) return adapter.params;
  if (kind === "video") {
    const v = adapter.video;
    const out: ParamSpec[] = [];
    if (!v) return out;
    if (v.durationSeconds) out.push({ key: "durationSeconds", type: "number", min: v.durationSeconds[0], max: v.durationSeconds[1] });
    if (v.resolutions) out.push({ key: "resolution", type: "enum", options: v.resolutions });
    if (v.aspects) out.push({ key: "aspect", type: "enum", options: v.aspects });
    if (v.fps) out.push({ key: "fps", type: "enum", options: v.fps.map(String), numeric: true });
    if (v.audio) out.push({ key: "audio", type: "bool" });
    return out;
  }
  return [
    { key: "n", type: "int", min: 1, max: 10 },
    { key: "size", type: "size", max: 8192 },
    { key: "aspect", type: "enum", options: ["1:1", "16:9", "9:16", "4:3", "3:4"] },
    { key: "format", type: "enum", options: IMAGE_FORMATS },
    { key: "seed", type: "int", min: 0 },
    { key: "steps", type: "int", min: 1, max: 1000 },
    { key: "guidance", type: "number" },
  ];
}

/** Raw form values by parameter key: strings from inputs, booleans from checkboxes; "" means "not set". */
export type FormValues = Record<string, string | boolean>;

export function paramProblem(spec: ParamSpec, values: FormValues): string | null {
  const raw = values[spec.key];
  if (spec.type === "size") {
    const w = String(values[`${spec.key}.width`] ?? ""), h = String(values[`${spec.key}.height`] ?? "");
    if (w === "" && h === "") return null;
    const ok = (s: string): boolean => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= spec.max;
    return ok(w) && ok(h) ? null : "range";
  }
  if (spec.type === "bool" || raw === undefined || raw === "") return null;
  if (spec.type === "enum") return spec.options.includes(String(raw)) ? null : "enum";
  const n = Number(raw);
  if (!Number.isFinite(n) || (spec.type === "int" && !Number.isInteger(n))) return "number";
  if (spec.min !== undefined && n < spec.min) return "range";
  if (spec.max !== undefined && n > spec.max) return "range";
  return null;
}

/** Request fields from the form: only what the person filled in or ticked. */
export function requestFromForm(specs: readonly ParamSpec[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.type === "size") {
      const w = String(values[`${spec.key}.width`] ?? ""), h = String(values[`${spec.key}.height`] ?? "");
      if (w !== "" && h !== "") out[spec.key] = { width: Number(w), height: Number(h) };
      continue;
    }
    const raw = values[spec.key];
    if (spec.type === "bool") {
      if (raw === true) out[spec.key] = true;
      continue;
    }
    if (raw === undefined || raw === "") continue;
    if (spec.type === "enum") out[spec.key] = spec.numeric ? Number(raw) : String(raw);
    else out[spec.key] = Number(raw);
  }
  return out;
}

export interface SubmitInput {
  operation: "generate" | "edit";
  agentId: string;
  adapter: string;
  kind: Kind;
  prompt: string;
  negativePrompt?: string;
  specs: readonly ParamSpec[];
  values: FormValues;
  referenceId?: string;
  referenceVideoId?: string;
  maskId?: string;
}

/** The params of media.generate / media.edit (docs/rpc.md; the params object is closed, so nothing else is added). */
export function buildParams(i: SubmitInput): { method: "media.generate" | "media.edit"; params: Record<string, unknown> } {
  const request: Record<string, unknown> = { prompt: i.prompt.trim(), ...requestFromForm(i.specs, i.values) };
  if (i.negativePrompt?.trim() && i.kind === "image") request["negativePrompt"] = i.negativePrompt.trim();
  if (i.referenceId) request["referenceIds"] = [i.referenceId];
  if (i.referenceVideoId) request["referenceVideoId"] = i.referenceVideoId;
  if (i.maskId) request["maskId"] = i.maskId;
  return {
    method: i.operation === "edit" ? "media.edit" : "media.generate",
    params: { agentId: i.agentId, adapter: i.adapter, kind: i.kind, request },
  };
}

// ---- Jobs -------------------------------------------------------------------------------------------------------------

export interface MediaJob {
  id: string;
  kind: string;
  agentId: string;
  adapter: string;
  operation: string;
  state: string;
  fraction: number;
  stage: string;
  outputId: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export const TERMINAL_STATES: readonly string[] = ["succeeded", "failed", "cancelled"];
export const isActive = (j: MediaJob): boolean => !TERMINAL_STATES.includes(j.state);

/** media.job.get / media.job.list row → job. The row carries no reference bytes or provider checkpoints. */
export function parseJob(v: unknown): MediaJob | null {
  const o = rec(v);
  const id = str(o["id"]);
  if (!id) return null;
  const progress = rec(o["progress"]);
  const f = num(progress["fraction"]) ?? 0;
  return {
    id,
    kind: str(o["kind"]) || "image",
    agentId: str(o["agentId"]),
    adapter: str(o["adapter"]),
    operation: str(o["operation"]),
    state: str(o["state"]) || "queued",
    fraction: Math.min(1, Math.max(0, f)),
    stage: str(progress["stage"]),
    outputId: str(o["outputId"]),
    error: str(o["error"]),
    createdAt: num(o["createdAt"]) ?? 0,
    updatedAt: num(o["updatedAt"]) ?? 0,
  };
}

export function parseJobList(v: unknown): MediaJob[] {
  const list = rec(v)["jobs"];
  if (!Array.isArray(list)) return [];
  return list.map(parseJob).filter((j): j is MediaJob => j !== null).sort((a, b) => b.createdAt - a.createdAt);
}

/** The job id an event names. Events are only a hint: the data always comes from media.job.get. */
export function eventJobId(data: string): string | null {
  try {
    const id = rec(JSON.parse(data))["jobId"];
    return typeof id === "string" && /^[a-f0-9-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ---- Failures -----------------------------------------------------------------------------------------------------------

export type FailureText =
  | "adapter" | "license" | "privacy" | "budget" | "budgetUnavailable" | "denied" | "approval" | "policy" | "quota" | "tooLarge"
  | "invalid" | "timeout" | "cancelled" | "interrupted" | "authInvalid" | "response" | "capability" | "unsupportedKind" | "notFound"
  | "unavailable" | "generic";

export interface MediaFailure {
  text: FailureText;
  /** The error code of docs/errors.md (`E_*`) or the media job code, always shown beside the text. */
  code: string;
  reason: string;
}

/** Classifies whatever a media call (or a failed job's `error` code) rejected with. The code and reason are kept for display. */
export function classifyFailure(e: unknown): MediaFailure {
  const o = rec(e);
  const data = rec(o["data"]);
  const wire = str(data["error"]);
  const errorCode = str(o["errorCode"]) || wire;
  const reason = str(o["reason"]) || str(data["reason"]);
  const message = str(o["message"]);
  const code = errorCode || (typeof e === "string" ? e : "") || str(o["kind"]) || "E_INTERNAL";
  const done = (text: FailureText): MediaFailure => ({ text, code, reason });
  if (typeof e === "string") return classifyJobCode(e);
  if (wire === "E_MEDIA_PRIVACY" || errorCode === "E_MEDIA_PRIVACY") return done("privacy");
  if (errorCode === "E_MEDIA_LICENSE") return done("license");
  if (errorCode === "E_MEDIA_CAPABILITY") return done("capability");
  if (errorCode === "E_MEDIA_UNSUPPORTED_KIND") return done("unsupportedKind");
  if (errorCode === "E_MEDIA_UNAVAILABLE" || errorCode === "E_MEDIA_DIMENSION") return done("adapter");
  if (reason === "budget_exceeded") return done("budget");
  if (errorCode === "E_NOT_AVAILABLE" && /budget/i.test(message) && reason === "") return done("budgetUnavailable");
  if (errorCode === "E_APPROVAL_REQUIRED") return done("approval");
  const byReason = classifyJobCode(reason);
  if (byReason.text !== "generic") return { ...byReason, code, reason };
  if (errorCode === "E_DENIED" || o["kind"] === "forbidden") return done(reason === "policy" ? "policy" : "denied");
  if (errorCode === "E_NOT_FOUND") return done("notFound");
  if (errorCode === "E_NOT_AVAILABLE" || errorCode === "E_CORE_UNAVAILABLE" || o["kind"] === "unavailable") return done("unavailable");
  if (errorCode === "E_INVALID_PARAMS") return done("invalid");
  return done("generic");
}

/** A media error code of the media library (`MediaError.code`) as it appears in a job's `error` or an RPC `reason`. */
export function classifyJobCode(code: string): MediaFailure {
  const text = ((): FailureText => {
    switch (code) {
      case "backend_unavailable": return "adapter";
      case "auth_invalid": case "auth_forbidden": return "authInvalid";
      case "content_policy": return "policy";
      case "quota": return "quota";
      case "too_large": return "tooLarge";
      case "unsupported_parameter": return "invalid";
      case "timeout": return "timeout";
      case "cancelled": return "cancelled";
      case "interrupted": return "interrupted";
      case "invalid_response": return "response";
      default: return "generic";
    }
  })();
  return { text, code, reason: "" };
}
