import { getApi } from "../common/load.ts";
export interface Output {
  id: string;
  agentId: string;
  createdAt: number;
  prompt: string;
  metadata: { adapter: string; model: string };
  files: { path: string; format: string; bytes: number }[];
}
export interface Project {
  id: string;
  name: string;
  owner: string;
  members: { userId: string; role: "member" | "lead" }[];
  agents: string[];
  archivedAt: number | null;
}
export interface Trace {
  traceId: string;
  projectId: string;
  status: string;
  spans: {
    spanId: string;
    parentSpanId: string | null;
    agentId: string;
    startedAt: number;
    endedAt: number | null;
    status: string;
    inputTokens: number;
    outputTokens: number;
    costEstimate: number | null;
    inputPreview: string;
    outputPreview: string;
  }[];
}
export interface IdentityList {
  humanId: string;
  links: { id: string; channel: string; accountId: string; userId: string }[];
  pairings: { id: string; channel: string; state: string; expiresAt: number }[];
}
export async function rpc<T>(
  method: string,
  params: object = {},
  signal?: AbortSignal,
  write = false,
): Promise<T> {
  return (await getApi().rpc(method, params, {
    write,
    ...(signal ? { signal } : {}),
  })) as T;
}
export function outputReference(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { isError?: unknown; value?: unknown };
  if (
    envelope.isError === false &&
    envelope.value &&
    typeof envelope.value === "object"
  )
    value = envelope.value;
  const o = value as { id?: unknown; files?: unknown };
  return typeof o.id === "string" &&
    /^[a-f0-9-]{36}$/.test(o.id) &&
    Array.isArray(o.files) &&
    o.files.length > 0
    ? o.id
    : null;
}
export function imageUrl(value: {
  data?: string;
  mimeType?: string;
}): string | null {
  return value.data &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    ) &&
    /^image\/(png|jpeg|webp)$/.test(value.mimeType ?? "")
    ? `data:${value.mimeType};base64,${value.data}`
    : null;
}
export function filterOutputs<
  T extends {
    agentId: string;
    createdAt: number;
    metadata: { adapter: string };
  },
>(
  outputs: T[],
  filter: { agent?: string; adapter?: string; after?: number; before?: number },
): T[] {
  return outputs.filter(
    (o) =>
      (!filter.agent || o.agentId === filter.agent) &&
      (!filter.adapter || o.metadata.adapter === filter.adapter) &&
      (filter.after === undefined || o.createdAt >= filter.after) &&
      (filter.before === undefined || o.createdAt <= filter.before),
  );
}
