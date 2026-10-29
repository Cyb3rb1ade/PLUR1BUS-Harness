// RE-08: derive wire data and operation signatures from RE-01. Runtime values (AbortSignal,
// functions, capture.done) cross RPC through cancellation/notifications instead of JSON properties.
import { readFileSync } from "node:fs";
const contractPath = new URL("../../../crates/plur1bus-engine/schema/engine-contract.schema.json", import.meta.url);
export const engineContract = JSON.parse(readFileSync(contractPath, "utf8"));
const dataName = (name) => `EngineContract${name}Data`;
const ref = (name) => ({ $ref: `#/$defs/${dataName(name)}` });
const string = { type: "string" };
const object = (properties = {}, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});
const opaque = { type: "object", additionalProperties: true };
export function contractWire(value) {
  if (Array.isArray(value)) return value.map(contractWire);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("x-"))
      .map(([key, v]) => {
        if (key === "$ref") return [key, v.replace("#/$defs/", "#/$defs/EngineContract") + "Data"];
        if (key === "title") return [key, dataName(v)];
        // JSON Schema does not define the Rust-only float format.
        if (key === "format" && ["float", "double"].includes(v)) return [key, undefined];
        return [key, contractWire(v)];
      })
      .filter(([, v]) => v !== undefined),
  );
}
const signature = (type, name) => engineContract.$defs[type]["x-methods"][name];
export function engineRpcSurface() {
  const definitions = {},
    methods = {},
    notifications = {};
  const add = (name, properties, required, result, description) => {
    methods[name] = {
      "x-server": name.startsWith("host.") ? "core" : "engine",
      "x-stability": "experimental",
      "x-since": "1.7.0",
      ...(name.startsWith("host.") ? { "x-feature": "engine" } : {}),
      description:
        description ??
        `The ${name.slice(name.indexOf(".") + 1)} operation on the ${name.startsWith("host.") ? "Core host-services" : "memory-engine"} RPC endpoint.`,
      params: object(properties, required),
      result,
    };
  };
  const from = (prefix, type) => {
    for (const [name, sig] of Object.entries(engineContract.$defs[type]["x-methods"] ?? {})) {
      const properties = Object.fromEntries(sig.parameters.map((p) => [p.name, contractWire(p.schema)]));
      add(
        `${prefix}.${name}`,
        properties,
        sig.parameters.filter((p) => !p.optional).map((p) => p.name),
        contractWire(sig.returns),
        sig.description,
      );
    }
  };
  add(
    "engine.auth",
    {
      token: { type: "string", minLength: 60, maxLength: 64 },
      clientId: { type: "string", minLength: 1, maxLength: 256 },
    },
    ["token", "clientId"],
    object(
      {
        contract: string,
        rpc: string,
        instanceId: string,
        pid: { type: "integer" },
        capabilities: { $ref: "#/$defs/Capabilities" },
        engineCapabilities: ref("EngineCapabilities"),
      },
      ["contract", "rpc", "instanceId", "pid", "capabilities"],
    ),
  );
  add("engine.open", { agentId: ref("AgentId") }, ["agentId"], ref("AgentStore"));
  add("engine.agent.close", { agentId: ref("AgentId") }, ["agentId"], object());
  add("engine.status", {}, [], ref("EngineStatus"));
  add("engine.shutdown", { budgetMs: { type: "number", minimum: 0 } }, [], object());
  add("engine.recall", { query: ref("RecallQuery"), options: ref("RecallOptions") }, ["query"], ref("RecallResult"));
  add("engine.capture", { turn: ref("TurnRecord"), options: ref("CaptureOptions") }, ["turn"], ref("CaptureHandle"));
  add("engine.capture.wait", { id: string, timeoutMs: { type: "number", minimum: 0 } }, ["id"], {
    anyOf: [ref("CaptureResult"), object({ pending: { const: true } }, ["pending"])],
  });
  add("engine.capture.abort", { id: string, reason: string }, ["id"], object());
  add(
    "engine.checkpoint",
    { agentId: ref("AgentId"), reason: ref("CheckpointReason") },
    ["agentId", "reason"],
    ref("CheckpointResult"),
  );
  add(
    "engine.systemSupplement",
    {},
    [],
    contractWire(signature("Engine", "systemSupplement").returns),
    "The contract's stable synchronous prefix, hydrated by EngineClient and returned as string[].",
  );
  from("engine.jobs", "JobRegistry");
  for (const verb of ["run", "history"]) {
    const old = methods[`engine.jobs.${verb}`];
    const opts = old.params.properties.opts;
    delete old.params.properties.opts;
    Object.assign(old.params.properties, opts.properties);
  }
  from("engine.embedding", "EmbeddingService");
  for (const verb of ["embed", "rerank"]) {
    const old = methods[`engine.embedding.${verb}`],
      opts = old.params.properties.o;
    delete old.params.properties.o;
    old.params.required = old.params.required.filter((n) => n !== "o").concat(opts.required ?? []);
    Object.assign(old.params.properties, opts.properties);
  }
  const probe = methods["engine.embedding.probe"];
  probe.params = object(probe.params.properties.opts.properties);
  add(
    "engine.embedding.fingerprint",
    { normalized: opaque },
    ["normalized"],
    object({ fingerprintId: string }, ["fingerprintId"]),
  );
  add("engine.config.normalizeEmbedding", { raw: opaque }, ["raw"], object({ normalized: opaque }, ["normalized"]));
  from("engine.models", "ModelsService");
  methods["engine.models.warm"].params = object(methods["engine.models.warm"].params.properties.opts.properties);
  add(
    "engine.models",
    {},
    [],
    ref("ModelsStatus"),
    "Compatibility alias for engine.models.status; model readiness follows RE-01's ModelsStatus.",
  );
  from("engine.memory", "MemoryOps");
  for (const action of ["keep", "drop"]) {
    const sig = structuredClone(methods["engine.memory.curation.resolve"]);
    delete sig.params.properties.action;
    sig.params.required = sig.params.required.filter((n) => n !== "action");
    sig.description = `Equivalent to engine.memory.curation.resolve with action ${action}.`;
    methods[`engine.memory.curation.${action}`] = sig;
  }
  from("engine.admin", "AdminOps");
  from("engine.admin.obsidian", "ObsidianOps");
  // Core's migration adapter predates RE-01's parameterless Promise<unknown> declarations.
  // Preserve its actual runtime arguments as optional, closed wire adapters (engine-port.ts).
  const fingerprint = object(
    {
      provider: string,
      model: string,
      dimensions: { type: "number" },
      revision: string,
      endpoint: string,
      queryPrefix: string,
      passagePrefix: string,
      pooling: string,
      normalize: { type: "boolean" },
      dtype: string,
      artifacts: { type: "array", items: object({ path: string, sha256: string }, ["path", "sha256"]) },
    },
    ["provider", "model", "dimensions"],
  );
  methods["engine.admin.reembedding.plan"].params = object({
    request: object(
      {
        id: string,
        target: object(
          {
            fingerprint,
            secretRef: object({ source: { const: "env" }, provider: { const: "default" }, id: string }, [
              "source",
              "provider",
              "id",
            ]),
          },
          ["fingerprint"],
        ),
        targetGeneration: string,
        confirmationTtlMs: { type: "number" },
      },
      ["id", "target"],
    ),
  });
  for (const verb of ["apply", "resume"])
    methods[`engine.admin.reembedding.${verb}`].params = object({
      request: object({ id: string, token: string }, ["id", "token"]),
    });
  methods["engine.admin.reembedding.validate"].params = object({ request: object({ id: string }, ["id"]) });
  methods["engine.admin.reembedding.status"].params = object({ id: string });

  from("engine.stores", "StoreOps");
  add(
    "engine.snapshot.create",
    { out: string },
    ["out"],
    opaque,
    "The engine-owned snapshot report (RE-10). Paths are local to the engine process.",
  );
  add(
    "engine.snapshot.verify",
    { dir: string },
    ["dir"],
    opaque,
    "The engine-owned snapshot verification report (RE-10).",
  );
  add("engine.tombstones.reapply", {}, [], opaque, "The engine-owned restored tombstone reapplication report (RE-10).");
  add(
    "host.llm.complete",
    { agentId: ref("AgentId"), params: ref("LlmParams") },
    ["params"],
    ref("LlmResult"),
    "Engine delegation only; uses the normal provider router, budget admission, privacy and D109 gates. T2 must send the owning registered agentId outside RE-01 LlmParams. agentId stays optional in the additive wire schema, but Core denies missing, unknown or unauthorized attribution before accessing the provider.",
  );
  const denyReasons = ["invalid-url", "scheme", "port", "host-not-allowed", "loopback", "private-address", "not-found"];
  const decision = {
    oneOf: [
      object(
        {
          allowed: { const: true },
          host: string,
          port: { type: "integer", minimum: 1, maximum: 65535 },
          address: string,
          family: { type: "integer", enum: [4, 6] },
        },
        ["allowed", "host", "port", "address", "family"],
      ),
      object({ allowed: { const: false }, reason: { enum: denyReasons }, message: string }, [
        "allowed",
        "reason",
        "message",
      ]),
    ],
  };
  add(
    "host.egress.decide",
    {
      scheme: { enum: ["http", "https"] },
      host: { type: "string", minLength: 1, maxLength: 253 },
      port: { type: "integer", minimum: 1, maximum: 65535 },
    },
    ["scheme", "host", "port"],
    decision,
    "Engine delegation only; evaluates the exact target with the core egress policy before each hop.",
  );
  add(
    "host.secret.get",
    { name: { type: "string", minLength: 1, maxLength: 256 } },
    ["name"],
    object({ value: { type: ["string", "null"] } }, ["value"]),
    "Engine delegation only; reads a fresh audited lease and revokes it before returning. Never log its value.",
  );
  add(
    "host.workspaceDir",
    { agentId: ref("AgentId") },
    ["agentId"],
    object({ path: { type: ["string", "null"] } }, ["path"]),
  );
  add("host.event", { name: ref("EngineEventName"), payload: {} }, ["name", "payload"], object());
  add("host.journalBacklog", {}, [], { anyOf: [ref("JournalBacklog"), { type: "null" }] });
  notifications["engine.capture.done"] = {
    "x-server": "engine",
    "x-stability": "experimental",
    "x-since": "1.7.0",
    ...object({ id: string, result: ref("CaptureResult") }, ["id", "result"]),
  };
  notifications["egress.changed"] = {
    "x-server": "core",
    "x-stability": "experimental",
    "x-since": "1.7.0",
    ...object(),
    description: "Engine policy cache invalidation; emitted when the core's egress policy changes.",
  };
  const engineEvent = {
    "x-server": "engine",
    "x-stability": "experimental",
    "x-since": "1.7.0",
    ...object({ name: ref("EngineEventName"), payload: {} }, ["name", "payload"]),
  };
  definitions.EngineTransportEvent = Object.fromEntries(
    Object.entries(engineEvent).filter(([key]) => !key.startsWith("x-")),
  );
  // Only data transitively referenced by wire operations is imported, with a prefix to avoid public Core type collisions.
  const pending = [methods, notifications, engineEvent];
  const scan = (value) => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/EngineContract")) {
      const key = value.$ref.slice("#/$defs/".length),
        name = key.slice("EngineContract".length, -"Data".length);
      if (!definitions[key]) {
        definitions[key] = contractWire(engineContract.$defs[name]);
        scan(definitions[key]);
      }
    }
    Object.values(value).forEach(scan);
  };
  pending.forEach(scan);
  return { definitions, methods, notifications, engineEvent };
}

// Replace one object member without reformatting unrelated, hand-authored RPC definitions.
function memberRange(text, name, spaces) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(^${spaces === undefined ? "[ \\t]*" : " ".repeat(spaces)})"${escaped}"\\s*:\\s*`,
    "m",
  ).exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  let i = start,
    depth = 0,
    quoted = false,
    escape = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) break;
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    } else if ((ch === "," || ch === "\n") && depth === 0) break;
  }
  return { start, end: i, indent: match[1] };
}
function setMember(text, group, name, value) {
  const range = memberRange(text, group, group === "$defs" ? 2 : 4);
  if (!range) throw new Error(`RPC schema namespace ${group} is missing or has inconsistent indentation`);
  const inner = text.slice(range.start, range.end);
  const found = memberRange(inner, name);
  if (found && JSON.stringify(JSON.parse(inner.slice(found.start, found.end))) === JSON.stringify(value)) return text;
  const indent = found?.indent ?? `${range.indent}  `;
  const rendered = JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
  const updated = found
    ? inner.slice(0, found.start) + rendered + inner.slice(found.end)
    : `{\n${indent}${JSON.stringify(name)}: ${rendered},` + inner.slice(1);
  return text.slice(0, range.start) + updated + text.slice(range.end);
}
export function syncEngineSchema(schemaPath, writeFile) {
  let text = readFileSync(schemaPath, "utf8").replaceAll("\r\n", "\n");
  const schema = JSON.parse(text),
    surface = engineRpcSurface();
  text = text.replace("/schema/rpc/1.6.0/rpc.schema.json", "/schema/rpc/1.7.0/rpc.schema.json");
  text = text.replace("PLUR1BUS harness RPC 1.6.0", "PLUR1BUS harness RPC 1.7.0");
  text = text.replace(
    "core, supervisor or (methods only, since 1.3.0) module.",
    "core, supervisor, module (methods only), or engine (since 1.7.0). host.* is served by core and requires the engine principal at dispatch.",
  );
  if (schema["x-rpc-version"] === "1.6.0") text = text.replace('"x-rpc-version": "1.6.0"', '"x-rpc-version": "1.7.0"');
  // 1.8.0 is reserved for package M. This package (M6-B) takes 1.9.0. Engine method x-since stays 1.7.0.
  if (!["1.6.0", "1.7.0", "1.9.0"].includes(schema["x-rpc-version"]))
    throw new Error("RE-08: RPC version changed; agree the next minor before generating engine methods");
  for (const [name, value] of Object.entries(surface.definitions)) text = setMember(text, "$defs", name, value);
  const delegation = object(
    { clientId: { const: "plur1bus-engine" }, token: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
    ["clientId", "token"],
  );
  text = setMember(text, "$defs", "EngineDelegation", delegation);
  for (const [name, value] of Object.entries(surface.methods)) text = setMember(text, "methods", name, value);
  for (const [name, value] of Object.entries(surface.notifications))
    text = setMember(text, "notifications", name, value);
  const event = { ...schema.$defs.notifications["engine.event"], "x-engine-notification": surface.engineEvent };
  text = setMember(text, "notifications", "engine.event", event);
  const auth = structuredClone(schema.$defs.methods["core.auth"]);
  auth.params.properties.engine = { $ref: "#/$defs/EngineDelegation" };
  text = setMember(text, "methods", "core.auth", auth);
  JSON.parse(text);
  if (text !== readFileSync(schemaPath, "utf8")) writeFile(schemaPath, text);
  return JSON.parse(text);
}
