// Shared mock setup for the Switchboard channel tests.
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export type ChannelSummary = {
  id: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  state: "not-registered" | "stopped" | "waiting" | "starting" | "running" | "backoff" | "failed";
  health: "ok" | "failing" | "unknown";
  lastError?: string;
};

export type ChannelDetail = ChannelSummary & {
  configurable: boolean;
  restart: string;
  missing: string[];
  secrets: { key: string; name: string; present: boolean }[];
  config: Record<string, unknown>;
  attempts: number;
  linkHelp: string;
  probe?: { ok: boolean; detail?: string };
};

export const sampleChannel = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  id: "discord",
  displayName: "Discord",
  enabled: true,
  configured: true,
  state: "running",
  health: "ok",
  configurable: true,
  restart: "module:discord",
  missing: [],
  secrets: [{ key: "tokenSecret", name: "channels.discord.token", present: true }],
  config: {
    enabled: true,
    tokenSecret: "channels.discord.token",
    replyPolicy: "mention",
    allowlist: ["123456789012345678"],
  },
  attempts: 0,
  linkHelp: "In Discord, type /link <code> to pair your identity.",
  probe: { ok: true, detail: "connected to gateway" },
  ...over,
});

export const sampleTelegram = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  id: "telegram",
  displayName: "Telegram",
  enabled: false,
  configured: false,
  state: "stopped",
  health: "unknown",
  configurable: true,
  restart: "module:telegram",
  missing: ["botTokenSecret"],
  secrets: [{ key: "botTokenSecret", name: "channels.telegram.token", present: false }],
  config: {
    enabled: false,
    botTokenSecret: "channels.telegram.token",
  },
  attempts: 0,
  linkHelp: "In Telegram, send /link <code> to the bot.",
  ...over,
});

export type SwitchboardFixtureState = {
  host: boolean;
  channels: ChannelDetail[];
};

export function seedSwitchboard(
  rpc: MockRpc,
  initial: ChannelDetail[] = [sampleChannel(), sampleTelegram()],
  host = true,
): SwitchboardFixtureState {
  const state: SwitchboardFixtureState = {
    host,
    channels: [...initial],
  };

  rpc.handle(
    "channel.list",
    () => ({
      host: state.host,
      channels: state.channels.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        enabled: c.enabled,
        configured: c.configured,
        state: state.host ? c.state : "not-registered",
        health: state.host ? c.health : "unknown",
        lastError: c.lastError,
      })),
    }),
    { write: false },
  );

  rpc.handle(
    "channel.status",
    () => ({
      host: state.host,
      channels: state.channels.map((c) => ({
        id: c.id,
        enabled: c.enabled,
        state: state.host ? c.state : "not-registered",
        health: state.host ? c.health : "unknown",
        lastError: c.lastError,
      })),
    }),
    { write: false },
  );

  rpc.handle(
    "channel.get",
    (p) => {
      const { id } = p as { id: string };
      const c = state.channels.find((ch) => ch.id === id);
      if (!c) throw rpcError("E_NOT_FOUND", "unknown-channel", "unknown-channel");
      return {
        ...c,
        state: state.host ? c.state : "not-registered",
      };
    },
    { write: false },
  );

  rpc.handle("channel.enable", (p) => {
    const { id } = p as { id: string };
    const c = state.channels.find((ch) => ch.id === id);
    if (!c) throw rpcError("E_NOT_FOUND", "unknown-channel", "unknown-channel");
    const changed = !c.enabled;
    c.enabled = true;
    c.state = state.host ? "running" : "not-registered";
    return {
      id: c.id,
      enabled: true,
      changed,
      restart: { live: [], core: false, modules: [c.id] },
      missing: c.missing,
    };
  });

  rpc.handle("channel.disable", (p) => {
    const { id } = p as { id: string };
    const c = state.channels.find((ch) => ch.id === id);
    if (!c) throw rpcError("E_NOT_FOUND", "unknown-channel", "unknown-channel");
    const changed = c.enabled;
    c.enabled = false;
    c.state = state.host ? "stopped" : "not-registered";
    return {
      id: c.id,
      enabled: false,
      changed,
      restart: { live: [], core: false, modules: [c.id] },
      missing: c.missing,
    };
  });

  rpc.handle("channel.set", (p) => {
    const { id, key, value, text } = p as { id: string; key: string; value?: unknown; text?: string };
    const c = state.channels.find((ch) => ch.id === id);
    if (!c) throw rpcError("E_NOT_FOUND", "unknown-channel", "unknown-channel");
    // Refuse secret values
    const stringVal = typeof text === "string" ? text : typeof value === "string" ? value : "";
    if (key.endsWith("Secret") && stringVal.startsWith("sk-")) {
      throw rpcError("E_CONFIG_INVALID", "secret-value", "secret-value");
    }
    const val = value !== undefined ? value : text;
    c.config[key] = val;
    return {
      id: c.id,
      key,
      changed: true,
      restart: { live: [], core: false, modules: [c.id] },
      value: val,
    };
  });

  rpc.handle("channel.test", (p) => {
    const { id, sendOwner } = p as { id: string; sendOwner?: boolean };
    const c = state.channels.find((ch) => ch.id === id);
    if (!c) throw rpcError("E_NOT_FOUND", "unknown-channel", "unknown-channel");
    return {
      id: c.id,
      ok: true,
      state: c.state,
      detail: "Test succeeded",
      sent: Boolean(sendOwner),
      ...(sendOwner ? { sentTo: { linkId: "usr_owner_1" } } : {}),
    };
  });

  return state;
}
