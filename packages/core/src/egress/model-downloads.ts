import type { EgressConfig } from "./policy.ts";

/** Named public model-catalog destinations observed for the engine's pinned artifacts. No API/provider wildcard. */
export const MODEL_DOWNLOAD_HOSTS = ["huggingface.co", "us.aws.cdn.hf.co"] as const;

/** Only credential-free reads of model repository files qualify; provider inference and arbitrary URLs never do. */
export function isModelArtifactRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method) || request.body || url.protocol !== "https:" || url.port || url.username || url.password || url.search) return false;
  if (url.hostname !== "huggingface.co") return false;
  let safe = true;
  request.headers.forEach((_value, name) => { if (!["accept", "user-agent", "range"].includes(name)) safe = false; });
  return safe && /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/resolve\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:json|onnx|onnx_data|txt|model)$/.test(url.pathname)
    && !url.pathname.split("/").some(part => part === ".." || part === ".");
}

/** For artifact requests this list is authoritative, even when ordinary egress permits '*'. */
export function modelDownloadPolicy(config: EgressConfig): EgressConfig {
  const raw = config.modelDownloads;
  const entries = raw?.allowHosts ?? MODEL_DOWNLOAD_HOSTS;
  const enabled = raw === undefined || raw.enabled === true;
  const valid = Array.isArray(entries) && entries.every(host => MODEL_DOWNLOAD_HOSTS.includes(host as typeof MODEL_DOWNLOAD_HOSTS[number]));
  return { ...config, allowHosts: enabled && valid ? [...entries] : [] };
}
