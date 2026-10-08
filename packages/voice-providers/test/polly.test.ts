import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolly, mapAwsError, type PollyClientLike } from "../src/providers/polly.ts";
import { sinePcm16 } from "./helpers/fake-vendor.ts";
import { collect, usageSink } from "./helpers/common.ts";
import { isVoiceProviderError } from "../src/errors.ts";

function fakeClient(opts: { fail?: (n: number) => unknown } = {}) {
  const calls: Array<Parameters<PollyClientLike["synthesize"]>[0]> = [];
  const client: PollyClientLike = {
    async synthesize(input, signal) {
      calls.push(input);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const f = opts.fail?.(calls.length);
      if (f) throw f;
      const pcm = sinePcm16(160 * input.Text.length, Number(input.SampleRate));
      return (async function* () { yield pcm.subarray(0, pcm.length >> 1); yield pcm.subarray(pcm.length >> 1); })();
    },
    async describeVoices(input) {
      if (!input.NextToken) return { Voices: [{ Id: "Vicki", Name: "Vicki", Gender: "Female", LanguageCode: "de-DE", SupportedEngines: ["neural", "standard"] }], NextToken: "t2" };
      return { Voices: [{ Id: "Matthew", Name: "Matthew", LanguageCode: "en-US", AdditionalLanguageCodes: ["es-US"], SupportedEngines: ["neural", "generative"] }, { Name: "no id" }] };
    },
  };
  return { client, calls };
}

test("synthesize: engine/voice/format/rate go to the SDK call, audio and usage come back, no key anywhere in options", async () => {
  const { client, calls } = fakeClient();
  const { sink, reports } = usageSink();
  const polly = createPolly({ clientFactory: async () => client, defaultVoice: "Vicki", defaultModel: "neural", usage: sink });
  const r = await polly.synthesize("Hallo", { language: "de-DE" });
  assert.deepEqual(calls[0], { Text: "Hallo", VoiceId: "Vicki", Engine: "neural", OutputFormat: "pcm", SampleRate: "16000", LanguageCode: "de-DE" });
  assert.equal(r.format, "pcm16");
  assert.equal(r.sampleRate, 16000);
  assert.equal(r.data.byteLength, 160 * 5 * 2);
  assert.deepEqual(reports, [{ provider: "polly", operation: "tts", model: "neural", chars: 5 }]);
  const mp3 = await polly.synthesize("Hi", { voice: "Matthew", format: "mp3", sampleRate: 24000, model: "generative" });
  assert.equal(mp3.format, "mp3");
  assert.deepEqual([calls[1]!.OutputFormat, calls[1]!.SampleRate, calls[1]!.Engine, calls[1]!.VoiceId], ["mp3", "24000", "generative", "Matthew"]);
});

test("unsupported options are refused before any call: opus, odd sample rates, missing voice", async () => {
  const { client, calls } = fakeClient();
  const polly = createPolly({ clientFactory: async () => client });
  for (const opts of [{ voice: "V", format: "opus" as const }, { voice: "V", sampleRate: 44100 }, {}]) {
    await assert.rejects(polly.synthesize("x", opts), (e) => isVoiceProviderError(e) && (e.code === "unsupported" || e.code === "invalid_request"));
  }
  assert.equal(calls.length, 0);
});

test("text streaming has no vendor support: sentences are chunked and synthesized in order", async () => {
  const { client, calls } = fakeClient();
  const polly = createPolly({ clientFactory: async () => client, defaultVoice: "Vicki" });
  assert.equal(polly.textInputStreaming, false);
  async function* text() { yield "Erster Satz. Zwei"; yield "ter Satz. "; yield "Dritter"; }
  const out = await collect(polly.synthesizeStream(text()));
  assert.deepEqual(calls.map((c) => c.Text), ["Erster Satz.", "Zweiter Satz.", "Dritter"]);
  assert.equal(out.length, 3);
});

test("abort between sentences stops further calls with an aborted error", async () => {
  const { client, calls } = fakeClient();
  const polly = createPolly({ clientFactory: async () => client, defaultVoice: "Vicki" });
  const ctl = new AbortController();
  async function* text() { yield "Eins. "; yield "Zwei. "; yield "Drei. "; }
  const it = polly.synthesizeStream(text(), { signal: ctl.signal })[Symbol.asyncIterator]();
  await it.next();
  ctl.abort();
  await assert.rejects(it.next(), (e) => isVoiceProviderError(e) && e.code === "aborted");
  assert.ok(calls.length <= 2);
});

test("AWS errors map to unified codes without echoing SDK text", async () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("secret arn:aws:iam::123"), { name: "CredentialsProviderError" }), "auth"],
    [Object.assign(new Error("x"), { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }), "rate_limited"],
    [Object.assign(new Error("x"), { name: "ServiceFailureException" }), "overloaded"],
    [Object.assign(new Error("x"), { name: "InvalidSsmlException" }), "invalid_request"],
    [Object.assign(new Error("x"), { name: "Weird", $metadata: { httpStatusCode: 403 } }), "auth"],
  ];
  for (const [err, code] of cases) {
    const { client } = fakeClient({ fail: () => err });
    const polly = createPolly({ clientFactory: async () => client, defaultVoice: "V" });
    await assert.rejects(polly.synthesize("x"), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, code); assert.ok(!/arn:aws/.test(e.message)); return true; });
  }
  assert.equal(mapAwsError(new Error("x"), AbortSignal.abort()).code, "aborted");
});

test("discovery: voices (paged, ids required) and engines as models", async () => {
  const { client } = fakeClient();
  const polly = createPolly({ clientFactory: async () => client });
  const voices = await polly.listVoices();
  assert.deepEqual(voices.map((v) => v.id), ["Vicki", "Matthew"]);
  assert.deepEqual(voices[1], { id: "Matthew", name: "Matthew", languages: ["en-US", "es-US"], engines: ["neural", "generative"] });
  assert.deepEqual((await polly.listModels()).map((m) => m.id), ["generative", "neural", "standard"]);
});

test("without the AWS SDK installed the provider reports unavailable, not a crash; the config surface has no key fields", async () => {
  const polly = createPolly({ defaultVoice: "V", region: "eu-central-1", profile: "work" });
  await assert.rejects(polly.synthesize("x"), (e) => isVoiceProviderError(e) && (e.code === "unavailable" || e.code === "auth" || e.code === "network"));
});
