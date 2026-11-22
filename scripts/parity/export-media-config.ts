import { pathToFileURL } from "node:url";
import { MEDIA_MODEL_CATALOG } from "@plur1bus/config-schema";
import { mediaConfigForLoad, productionMediaProviderCatalog, validateCaptionProvider, validateMediaEmbedding,
  type MediaEmbeddingConfig, type MediaModelInfo, type MediaValidationContext } from "../../packages/core/src/media-search/validate.ts";
import { exporterMain } from "./lib.mjs";

const known = { enabled: true, provider: "local", model: "google/embeddinggemma-2", dimensions: 768 } as const;
const badge = { provider: "fixture-cloud", by: "u", acknowledgedAt: "2026-01-01T00:00:00Z" };
const cloud: MediaModelInfo = { local: false, capabilities: { text: true, image: true, audio: false, video: false },
  licence: { id: "fixture-licence", nonCommercial: true }, dimensions: [8, 16] };

async function one(name: string) {
  let cfg: MediaEmbeddingConfig = name.startsWith("local") ? { ...known } : {
    enabled: true, provider: "fixture-cloud", model: "test", dimensions: 8, modalities: ["image"], privacyAck: badge,
  };
  let section = "embedding";
  switch (name) {
    case "disabled": cfg.enabled = false; cfg.model = "bad"; break;
    case "off": cfg.provider = "off"; cfg.model = "bad"; break;
    case "unknown": cfg.model = "bad"; break;
    case "no provider": delete cfg.provider; break;
    case "no ack": delete cfg.privacyAck; break;
    case "wrong ack": cfg.privacyAck = { ...badge, provider: "different" }; break;
    case "capability": cfg.modalities = ["audio"]; break;
    case "dimension": cfg.dimensions = 12; break;
    case "local dimension": cfg.dimensions = 12; break;
    case "caption": case "caption no ack": case "caption off":
      section = "caption";
      cfg = { ...known, caption: { provider: "fixture-cloud", model: "test",
        ...(name === "caption off" ? { source: "off" } : {}), ...(name === "caption no ack" ? {} : { privacyAck: badge }) } };
  }
  const calls: unknown[] = [];
  const context: MediaValidationContext = {
    catalog: { lookup(provider, model) {
      calls.push(["lookup", provider, model]);
      return provider === "fixture-cloud" && model === "test" ? cloud : productionMediaProviderCatalog.lookup(provider, model);
    } },
    privacyPinned: name === "pinned",
    licenceAccepted: model => { calls.push(["licence", model]); return name !== "licence"; },
    available: (provider, model) => { calls.push(["available", provider, model]); return name !== "unavailable"; },
  };
  let outcome: unknown = "ok";
  try { await (section === "caption" ? validateCaptionProvider : validateMediaEmbedding)(cfg, context); }
  catch (error) {
    if (!(error instanceof Error) || !("error" in error)) throw error;
    outcome = error.error;
  }
  return { name, cfg, section, calls, outcome };
}

export async function buildMediaConfigVectors() {
  const loads = [known, { ...known, model: "legacy", dimensions: 13 }, { ...known, dimensions: 512 },
    { ...known, dimensions: 13 }, { ...known, enabled: false, model: "legacy" },
    { ...known, provider: "unknown", dimensions: 13 }, { provider: "local" }];
  return { config: { catalog: MEDIA_MODEL_CATALOG,
    load: loads.map(before => ({ before, after: mediaConfigForLoad(before) })),
    validate: await Promise.all(["local", "local dimension", "disabled", "off", "unknown", "no provider", "cloud", "pinned",
      "no ack", "wrong ack", "capability", "dimension", "licence", "unavailable", "caption", "caption no ack", "caption off"].map(one)),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaConfigVectors });
}
