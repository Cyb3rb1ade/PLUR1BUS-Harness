/**
 * N-G2: live evaluation refuses missing/malformed config, OpenAI profiles (D110) and any key from the environment,
 * resolves credentials through the harness secret store, and gates only measured real-adapter evidence.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuthSecretStore } from "../../src/auth/index.ts";
import {
  composeTurnEvalProviders, openTurnEvalSecrets, parseTurnEvalModels, storeTurnEvalCredentials, turnEvalHome,
  turnEvalLiveGate, turnEvalSecretName, type TurnEvalModel,
} from "../../src/toolcall/turn-eval-live.ts";
import { runTurnEval } from "../../src/toolcall/turn-eval.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { fakeEgress } from "../composition/helpers.ts";

const VALID = { provider: "provider", model: "model", baseUrl: "https://provider.example/v1", wireFormat: "chat_completions" };
const ANTHROPIC = { provider: "anthropic", model: "claude-model", baseUrl: "https://api.anthropic.com", wireFormat: "anthropic_messages" };
const parse = (...rows: object[]) => parseTurnEvalModels(JSON.stringify(rows));
const request = { model: "model", messages: [{ role: "user" as const, content: "hi" }] };
const run = promisify(execFile);
const scripts = fileURLToPath(new URL("../../../../scripts/eval/", import.meta.url));

/** Drives one request through an adapter and keeps what reached the transport; the transport always answers 500. */
async function sentHeaders(model: TurnEvalModel, secrets: ReturnType<typeof openTurnEvalSecrets>) {
  const seen: Headers[] = [];
  const providers = composeTurnEvalProviders([model], { secrets, egress: fakeEgress().egress,
    fetch: (async (_url: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response("{}", { status: 500 }); }) as typeof fetch });
  try {
    await assert.rejects(async () => { for await (const _ of providers.adapters[0]!.stream({ ...request, model: model.model })) { /* drain */ } });
  } finally { providers.close(); }
  return seen;
}

describe("live turn eval configuration and gates", () => {
  it("rejects absent, empty or malformed model configuration with an actionable error", () => {
    for (const value of [undefined, "", "[]", "{}", "broken"]) {
      assert.throws(() => parseTurnEvalModels(value), /PLUR1BUS_TURN_EVAL_MODELS/);
    }
  });

  it("accepts the non-OpenAI wires, rejects credentials in a URL, unknown wires and a named key variable", () => {
    for (const wireFormat of ["chat_completions", "anthropic_messages", "gemini"]) {
      assert.equal(parse({ ...VALID, wireFormat })[0]!.wireFormat, wireFormat);
    }
    assert.throws(() => parse({ ...VALID, baseUrl: "https://user:secret@example.com" }));
    assert.throws(() => parse({ ...VALID, wireFormat: "unknown" }));
    assert.throws(() => parse({ ...VALID, keyEnv: "PROVIDER_KEY" }), /secret store/);
  });

  it("D110: refuses every OpenAI profile, whichever way it is spelled, and nothing else", () => {
    const refused = [
      { ...VALID, wireFormat: "codex_responses" },
      { ...VALID, wireFormat: "codex_responses", baseUrl: "https://gateway.example/v1" },
      { ...VALID, baseUrl: "https://api.openai.com/v1" },
      { ...VALID, baseUrl: "https://API.OpenAI.com./v1" },
      { ...VALID, baseUrl: "https://eu.api.openai.com/v1" },
      { ...VALID, baseUrl: "https://chatgpt.com/backend-api" },
      { ...VALID, wireFormat: "anthropic_messages", baseUrl: "https://api.openai.com" },
      { ...VALID, provider: "openai" },
      { ...VALID, provider: "OpenAI-compat" },
    ];
    for (const row of refused) assert.throws(() => parse(row), /OpenAI profiles.*D110/, JSON.stringify(row));
    for (const row of [VALID, ANTHROPIC, { ...VALID, baseUrl: "https://notopenai.com/v1" },
      { ...VALID, baseUrl: "https://openai.example.com/v1" }, { ...VALID, local: true, baseUrl: "http://127.0.0.1:8080/v1" }]) {
      assert.equal(parse(row).length, 1, JSON.stringify(row));
    }
  });

  it("the setup step writes keys to the store under the name `plur1bus login` uses and fails closed without them", async () => {
    const home = tempDir("n2-eval-home-");
    const secrets = openTurnEvalSecrets(home);
    const models = parse(ANTHROPIC, { ...VALID, local: true, baseUrl: "http://127.0.0.1:8080/v1" });
    assert.deepEqual(await storeTurnEvalCredentials(models, { ANTHROPIC_API_KEY: "store-key" }, secrets),
      ["anthropic/api-key", "provider/api-key"]);
    const store = createAuthSecretStore(secrets);
    assert.equal(await store.get(turnEvalSecretName("anthropic")), "store-key");
    assert.equal(await store.get(turnEvalSecretName("provider")), "local", "a keyless local endpoint gets a placeholder");
    // The same store is reachable again by a later process: it is a file backend in the home.
    assert.equal(await createAuthSecretStore(openTurnEvalSecrets(home)).get("anthropic/api-key"), "store-key");
    await assert.rejects(storeTurnEvalCredentials(parse(ANTHROPIC), {}, secrets), /ANTHROPIC_API_KEY .* unavailable/);
    await assert.rejects(storeTurnEvalCredentials(parse(VALID), { PROVIDER_KEY: "x" }, secrets), /no credential source for provider/);
  });

  it("the setup script carries the key into the eval home across a process boundary and prints no value", async () => {
    const home = tempDir("n2-eval-home-");
    const env = { ...process.env, PLUR1BUS_TURN_EVAL_HOME: home, PLUR1BUS_TURN_EVAL_MODELS: JSON.stringify([ANTHROPIC]), ANTHROPIC_API_KEY: "key-from-ci-secret" };
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", join(scripts, "turn-eval-secrets.ts")], { env });
    assert.deepEqual(JSON.parse(stdout), { stored: ["anthropic/api-key"] });
    assert.doesNotMatch(stdout + stderr, /key-from-ci-secret/);
    assert.equal(await createAuthSecretStore(openTurnEvalSecrets(home)).get("anthropic/api-key"), "key-from-ci-secret");
  });

  it("resolves the key through the secret store and never reads one from the environment", async () => {
    const home = tempDir("n2-eval-home-");
    const secrets = openTurnEvalSecrets(home);
    const env = { ANTHROPIC_API_KEY: "env-decoy", PLUR1BUS_TURN_EVAL_API_KEY: "env-decoy", PROVIDER_KEY: "env-decoy" };
    const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
    Object.assign(process.env, env);
    try {
      const [model] = parse(ANTHROPIC);
      // Nothing was stored: the decoys in the environment must not be found.
      assert.deepEqual(await sentHeaders(model!, secrets), [], "no credential, no request");
      await secrets.set({ kind: "owner" }, turnEvalSecretName("anthropic"), "store-key");
      const [headers] = await sentHeaders(model!, secrets);
      assert.equal(headers!.get("x-api-key"), "store-key");
      assert.doesNotMatch(JSON.stringify([...headers!.entries()]), /env-decoy/);
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });

  it("sends a local endpoint through the egress gate with the stored placeholder, and refuses hosts it was not given", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => { seen.push(req.headers); res.statusCode = 500; res.end("{}"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    after(() => new Promise(resolve => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const home = tempDir("n2-eval-home-");
    const secrets = openTurnEvalSecrets(home);
    const models = parse({ ...VALID, local: true, baseUrl });
    await storeTurnEvalCredentials(models, {}, secrets);
    const providers = composeTurnEvalProviders(models, { secrets });
    try {
      await assert.rejects(async () => { for await (const _ of providers.adapters[0]!.stream(request)) { /* drain */ } });
    } finally { providers.close(); }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.authorization, "Bearer local");
    // One provider label stands for one endpoint.
    assert.throws(() => composeTurnEvalProviders(parse({ ...VALID, local: true, baseUrl }, { ...VALID, baseUrl: "http://127.0.0.1:1/v1" }), { secrets }), /two endpoints/);
  });

  it("the live script refuses an OpenAI profile before any request, and needs an eval home", async () => {
    const script = join(scripts, "turn-eval.ts");
    const node = ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", script, "--live"];
    const env = (models: object, home?: string) => ({ ...process.env, PLUR1BUS_TURN_EVAL_MODELS: JSON.stringify([models]),
      ...(home ? { PLUR1BUS_TURN_EVAL_HOME: home } : { PLUR1BUS_TURN_EVAL_HOME: "" }) });
    await assert.rejects(run(process.execPath, node, { env: env({ ...VALID, baseUrl: "https://api.openai.com/v1" }, tempDir("n2-eval-home-")) }),
      (error: { stderr: string }) => /OpenAI profiles/.test(error.stderr));
    await assert.rejects(run(process.execPath, node, { env: env(VALID) }),
      (error: { stderr: string }) => /PLUR1BUS_TURN_EVAL_HOME/.test(error.stderr));
    assert.throws(() => turnEvalHome({}), /PLUR1BUS_TURN_EVAL_HOME/);
  });

  it("the evaluation reads no key from the environment: its only variables are the model list and the eval home", () => {
    const script = readFileSync(join(scripts, "turn-eval.ts"), "utf8");
    assert.deepEqual([...script.matchAll(/process\.env\.(\w+)/g)].map(match => match[1]), ["PLUR1BUS_TURN_EVAL_MODELS"]);
    assert.doesNotMatch(script, /keyEnv|_API_KEY|process\.env\[/);
    const live = readFileSync(fileURLToPath(new URL("../../src/toolcall/turn-eval-live.ts", import.meta.url)), "utf8");
    // The one reader is the default of `turnEvalHome`; the setup step's keys arrive as an explicit `env` argument.
    assert.equal(live.match(/process\.env/g)?.length, 1);
    assert.doesNotMatch(readFileSync(join(scripts, "turn-eval-secrets.ts"), "utf8"), /process\.env\[/);
  });

  it("never accepts fixture reports as live quality evidence", async () => {
    const report = await runTurnEval([]);
    assert.equal(turnEvalLiveGate(report).passed, false);
    assert.ok(turnEvalLiveGate(report).failures.includes("real model evidence required"));
  });

  it("rejects the exact target misses while preserving the 95/5/90 percent boundaries", async () => {
    const report = { ...await runTurnEval([]), evidence: "live" as const };
    report.denominators.tools = 20;
    report.denominators.skills = 10;
    report.denominators.neededTurns = 20;
    report.metrics.toolHitRate = .95;
    report.metrics.missingToolRate = .05;
    report.metrics.skillHitRate = .9;
    assert.equal(turnEvalLiveGate(report).passed, true);
    report.metrics.toolHitRate = .949;
    report.metrics.missingToolRate = .051;
    report.metrics.skillHitRate = .899;
    report.metrics.policyViolations = 1;
    assert.equal(turnEvalLiveGate(report).failures.length, 4);
  });
});
