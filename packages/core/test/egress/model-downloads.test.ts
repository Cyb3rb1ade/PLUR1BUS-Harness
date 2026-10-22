import { test } from "node:test";
import assert from "node:assert/strict";
import { createEgress } from "../../src/egress/service.ts";

const artifact = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/config.json";
test("named model download policy admits catalog origin/CDN while ordinary requests remain denied", async () => {
  const seen: string[] = [];
  const egress = createEgress({ config: () => ({ allowHosts: [], allowPorts: [443], allowLoopback: false }), resolver: async host => { seen.push(host); return []; } });
  for (const url of [artifact, "https://us.aws.cdn.hf.co/model"]) {
    await assert.rejects(() => egress.request(url, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "not-found");
  }
  assert.deepEqual(seen, ["huggingface.co", "us.aws.cdn.hf.co"]);
  await assert.rejects(() => egress.request(artifact, { userAgent: "test" }), (e: any) => e.code === "egress-denied");
  await assert.rejects(() => egress.request("https://attacker.example/model", { userAgent: "test", modelDownload: true }), (e: any) => e.code === "egress-denied");
});

test("removing a download host or disabling downloads takes effect live and wildcards fail closed", async () => {
  let modelDownloads: { enabled: boolean; allowHosts: string[] } = { enabled: true, allowHosts: ["huggingface.co"] };
  const seen: string[] = [];
  const egress = createEgress({ config: () => ({ allowHosts: ["*"], allowPorts: [443], allowLoopback: false, modelDownloads }), resolver: async host => { seen.push(host); return []; } });
  await assert.rejects(() => egress.request(artifact, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "not-found");
  modelDownloads.allowHosts = [];
  await assert.rejects(() => egress.request(artifact, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "egress-denied");
  modelDownloads = { enabled: false, allowHosts: ["huggingface.co"] };
  await assert.rejects(() => egress.request(artifact, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "egress-denied");
  modelDownloads = { enabled: true, allowHosts: ["*"] };
  await assert.rejects(() => egress.request(artifact, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "egress-denied");
  assert.equal(seen.length, 1);
});

test("catalog exceptions retain private-address/DNS-rebinding refusal", async () => {
  const egress = createEgress({ config: () => ({ allowHosts: [], allowPorts: [443], allowLoopback: true }), resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(() => egress.request(artifact, { userAgent: "test", modelDownload: true }), (e: any) => e.code === "private-address");
});

test("only credential-free repository file reads qualify; query, inference, auth and body never use exception", async () => {
  const { isModelArtifactRequest } = await import("../../src/egress/model-downloads.ts");
  assert.equal(isModelArtifactRequest(new Request(artifact)), true);
  assert.equal(isModelArtifactRequest(new Request(artifact, { method: "HEAD", headers: { range: "bytes=0-5" } })), true);
  for (const request of [new Request(artifact+"?text=private"), new Request(artifact,{headers:{authorization:"Bearer private"}}), new Request(artifact,{headers:{"x-api-key":"private"}}), new Request(artifact,{method:"POST",body:"private"}), new Request("https://huggingface.co/api/inference"), new Request("https://attacker.example/model.onnx")]) assert.equal(isModelArtifactRequest(request),false);
});
