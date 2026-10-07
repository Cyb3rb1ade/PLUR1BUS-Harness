// The session.* methods of docs/rpc.md that the chat page uses, merged into the typed API client. Shapes follow the
// documented schemas (SessionRecord, SessionMessage, SessionEvent). `caller` (required by the schema, CLI only) is not
// sent: a browser cannot supply an identity, so the Harness API has to derive it from the session cookie (open point).
export type MemoryMode = "remember" | "incognito";
export type TurnState = "running" | "completed" | "failed";
export type SessionEventType = "turn.started" | "delta" | "tool.call" | "tool.result" | "turn.completed" | "turn.failed";

export type SessionRecord = {
  id: string;
  kind: "direct" | "card" | "project" | "channel" | "acp";
  agentId: string;
  scope: string;
  chatKey: string | null;
  title: string;
  pinned: boolean;
  memoryMode: MemoryMode;
  createdAt: number;
  updatedAt: number;
  lastTurnAt: number | null;
  archivedAt: number | null;
  turnCount: number;
};

export type SessionMessage = {
  id: string;
  seq: number;
  turnId?: string | null;
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  createdAt: number;
};

export type SessionEvent = {
  sessionId: string;
  seq: number;
  turnId: string | null;
  type: SessionEventType;
  data: Record<string, unknown>;
  at: number;
};

/** The `session.event` notification as it travels (params of the JSON-RPC notification; assumed as the SSE data). */
export type SessionEventNotification = { agentId: string; event: SessionEvent };

/** `GET /api/v1/agents` (exists on origin/main). */
export type AgentsAnswer = { schema?: string; agents: { agentId: string; open: boolean; activity?: unknown }[] };

declare module "../../api/index.ts" {
  interface RpcMethods {
    "session.create": { params: { agentId: string; kind?: "direct"; title?: string; memoryMode?: MemoryMode }; result: { session: SessionRecord } };
    "session.list": { params: { kind?: SessionRecord["kind"]; agentId?: string; archived?: "exclude" | "only" | "any"; search?: string; limit?: number }; result: { sessions: SessionRecord[]; truncated: boolean } };
    "session.resume": { params: { sessionId: string; limit?: number }; result: { session: SessionRecord; runningTurnId: string | null; messages: SessionMessage[]; lastEventSeq: number } };
    "session.submit": { params: { sessionId: string; text: string; wait?: boolean }; result: { sessionId: string; turnId: string; messageId: string; state: TurnState; reply?: string; error?: string } };
    "session.events": { params: { sessionId: string; afterSeq?: number; limit?: number }; result: { sessionId: string; events: SessionEvent[]; lastSeq: number; running: boolean } };
    "session.cancel": { params: { sessionId: string }; result: { sessionId: string; turnId: string | null; cancelled: boolean } };
  }
}
