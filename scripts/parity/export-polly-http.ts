// Re-record with an external, test-only @aws-sdk/client-polly 3.922.0 install.
// The SDK uses synthetic credentials and its transport can reach only our local fixture.
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPolly, loadSdkClient } from "../../packages/voice-providers/src/providers/polly.ts";
import { VoiceProviderError } from "../../packages/voice-providers/src/errors.ts";
import { json, startFakeVendor } from "../../packages/voice-providers/test/helpers/fake-vendor.ts";
import { exporterMain } from "./lib.mjs";

const sdkDirectory = process.argv[2];
if (!sdkDirectory) throw new Error("Pass the directory containing the test-only Polly SDK installation");
const external = createRequire(resolve(sdkDirectory, "package.json"));
const sdk = "@aws-sdk/client-polly";
const release = external(`${sdk}/package.json`) as { version: string };
if (release.version !== "3.922.0") throw new Error("Polly wire recording requires AWS SDK 3.922.0");
const sdkEntry = external.resolve(sdk);
const handlerDependency = createRequire(sdkEntry);
type SdkRequest = { protocol: string; hostname: string; port?: number };
const { NodeHttpHandler } = handlerDependency("@smithy/node-http-handler") as {
  NodeHttpHandler: new () => {
    handle(request: SdkRequest, options: unknown): Promise<unknown>;
    destroy(): void;
  };
};
const sdkUrl = pathToFileURL(sdkEntry).href;
const providerUrl = new URL("../../packages/voice-providers/src/providers/polly.ts", import.meta.url).href;
const hook = registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier === sdk && context.parentURL === providerUrl ? sdkUrl : specifier, context),
});

process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_MAX_ATTEMPTS = "1";
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;

async function build() {
  const audio = Buffer.from([1, 4, 6, 9]);
  const page = { Voices: [{ Id: "fixture-a", Name: "Fixture A", SupportedEngines: ["neural"] }],
    NextToken: "second + page /" };
  const tail = { Voices: [{ Id: "fixture-b", SupportedEngines: ["standard"] }] };
  const rejected = { message: "synthetic refusal detail" };
  const responses: Array<{ status: number; body?: unknown; chunksBase64?: string[]; headers?: Record<string, string> }> = [
    { status: 200, chunksBase64: [audio.toString("base64")], headers: { "content-type": "audio/pcm" } },
    { status: 200, body: page },
    { status: 200, body: tail },
    { status: 400, body: rejected, headers: { "x-amzn-errortype": "AccessDeniedException" } },
  ];
  let next = 0;
  const server = await startFakeVendor({
    http: (_request, reply) => {
      const response = responses[next++];
      if (!response) throw new Error("Unexpected Polly request");
      if (response.chunksBase64) {
        reply.writeHead(response.status, response.headers);
        reply.end(audio);
      } else json(reply, response.status, response.body, response.headers);
    },
  });
  const loopback = new URL(server.httpUrl);
  const transport = new NodeHttpHandler();
  const requestHandler = {
    handle: (request: SdkRequest, options: unknown) => transport.handle({
      ...request, protocol: loopback.protocol, hostname: loopback.hostname, port: Number(loopback.port),
    }, options),
  };
  try {
    const input = { text: "A fixture voice 👋", voice: "FixtureVoice", language: "de-DE" };
    const provider = createPolly({ clientFactory: async () => await loadSdkClient({ region: "us-east-1" }, requestHandler) });
    const synthesis = await provider.synthesize(input.text, { voice: input.voice, language: input.language });
    const voices = await provider.listVoices!();
    let errorCode;
    try {
      await provider.synthesize(input.text, { voice: input.voice });
    } catch (error) {
      if (!(error instanceof VoiceProviderError)) throw error;
      errorCode = error.code;
    }
    if (next !== responses.length || !errorCode) throw new Error("Incomplete Polly HTTP recording");
    return {
      "polly-http": {
        transport: "http", exporter: "scripts/parity/export-polly-http.ts",
        sdk: release.version, input,
        expected: {
          dataBase64: Buffer.from(synthesis.data).toString("base64"),
          format: synthesis.format, sampleRate: synthesis.sampleRate, voices, errorCode,
        },
        exchanges: server.requests.map((request, index) => {
          if (typeof request.headers.authorization !== "string") throw new Error("Unsigned Polly fixture request");
          return {
            request: {
              method: request.method, path: request.url, bodyText: request.body.toString("utf8"),
              headers: { authorization: "<credential>", ...(request.headers["content-type"]
                ? { "content-type": request.headers["content-type"] } : {}) },
            },
            response: responses[index]!,
          };
        }),
      },
    };
  } finally {
    transport.destroy();
    await server.close();
  }
}

try {
  process.exitCode = await exporterMain({ area: "voice", build, argv: process.argv.slice(3) });
} finally {
  hook.deregister();
}
