// A2A server vocabulary (ADR-008 §A2A). Wire shapes follow A2A Protocol 0.3.0 dotted JSON-RPC names
// (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`,
// `tasks/pushNotificationConfig/{set,get,list,delete}`). See https://a2a-protocol.org/v0.3.0/specification/

export const A2A_PROTOCOL_VERSION = "0.3.0";

export const A2A_ACTIONS = ["card.read", "task.send", "task.read", "task.cancel", "task.push"] as const;
export type A2aAction = (typeof A2A_ACTIONS)[number];

export const TASK_STATES = [
  "submitted", "working", "input-required", "auth-required",
  "completed", "failed", "canceled", "rejected",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled", "rejected"]);
export const CANCELABLE_STATES: ReadonlySet<TaskState> = new Set(["submitted", "working", "input-required", "auth-required"]);
export const RESUMABLE_STATES: ReadonlySet<TaskState> = new Set(["input-required", "auth-required"]);

export interface A2aTextPart { kind: "text"; text: string; metadata?: Record<string, unknown> }
export interface A2aFilePart {
  kind: "file";
  file: { name?: string; mimeType?: string; bytes?: string; data?: string; uri?: string };
  metadata?: Record<string, unknown>;
}
export interface A2aDataPart { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> }
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart;

export interface A2aMessage {
  kind: "message";
  role: "user" | "agent";
  messageId: string;
  parts: A2aPart[];
  contextId?: string;
  taskId?: string;
}
export interface A2aArtifact { artifactId: string; name?: string; parts: A2aPart[] }
export interface A2aTask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: A2aMessage };
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
}

export interface A2aStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: A2aTask["status"];
  final?: boolean;
}
export interface A2aArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
}
export type A2aStreamEvent = A2aTask | A2aStatusUpdateEvent | A2aArtifactUpdateEvent | A2aMessage;

export interface A2aSkill {
  id: string; name: string; description: string; tags: string[];
  inputModes?: string[]; outputModes?: string[];
}

/** What the host knows about an exposed agent. Only these fields can ever reach a card (content-free, ADR-008). */
export interface A2aAgentInfo {
  /** Per-agent opt-in (ADR-008 "off by default"). false behaves exactly like an unknown agent. */
  optIn: boolean;
  displayName?: string; description?: string;
  skills?: readonly { id: string; name: string; description?: string; tags?: readonly string[]; inputModes?: readonly string[]; outputModes?: readonly string[] }[];
  defaultInputModes?: readonly string[];
  defaultOutputModes?: readonly string[];
}
export type A2aAgentSource = (agentId: string) => A2aAgentInfo | undefined;

/** An external A2A caller: its own principal `a2a-peer`, never a harness user. Rights are explicit and per agent. */
export interface A2aPeerConfig {
  id: string;
  /** Lower-case hex SHA-256 of the bearer key. The key itself is never stored or logged. */
  keySha256: string;
  /** agentId -> the actions this peer holds on it. Absent agent or action = denied. */
  grants: Readonly<Record<string, readonly A2aAction[]>>;
}

export interface A2aPushAuthentication { schemes: string[]; credentials?: string }
export interface A2aPushConfig {
  id?: string;
  url: string;
  token?: string;
  authentication?: A2aPushAuthentication;
}
export interface A2aTaskPushConfig { taskId: string; pushNotificationConfig: A2aPushConfig }

export interface A2aCardFeatures { streaming: boolean; pushNotifications: boolean }

export interface A2aLimits {
  maxBodyBytes: number; maxTextBytes: number; maxParts: number; maxFileBytes: number; maxDataBytes: number;
  /** Requests per minute per peer (ADR-008: default 60). */
  peerRatePerMinute: number;
  /** Requests per minute per remote address, authenticated or not. */
  addressRatePerMinute: number;
  /** Failed authentications per minute per remote address before it is refused outright. */
  failedAuthPerMinute: number;
  maxLiveTasksPerPeer: number; maxStoredTasks: number; retentionMs: number; replyTimeoutMs: number;
  maxHistoryLength: number;
  maxStreamConnectionsPerPeer: number;
  pushMaxAttempts: number;
  pushBackoffMs: number;
}
export const DEFAULT_LIMITS: A2aLimits = {
  maxBodyBytes: 1024 * 1024, maxTextBytes: 64 * 1024, maxParts: 16, maxFileBytes: 256 * 1024, maxDataBytes: 64 * 1024,
  peerRatePerMinute: 60, addressRatePerMinute: 240, failedAuthPerMinute: 10,
  maxLiveTasksPerPeer: 8, maxStoredTasks: 1000, retentionMs: 60 * 60_000, replyTimeoutMs: 120_000,
  maxHistoryLength: 20,
  maxStreamConnectionsPerPeer: 8,
  pushMaxAttempts: 3,
  pushBackoffMs: 100,
};

// JSON-RPC 2.0 and A2A 0.3 error codes (spec §8).
export const RPC = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  taskNotFound: -32001, taskNotCancelable: -32002, pushNotSupported: -32003, unsupportedOperation: -32004,
  contentTypeNotSupported: -32005, invalidAgentResponse: -32006,
  limit: -32000,
} as const;
