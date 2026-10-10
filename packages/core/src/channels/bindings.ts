// The channels the switchboard can host. Each adapter is imported when its channel is first enabled, so a harness that uses no
// channel loads none of them. The manifests repeat the packages' `channel.json` (a test keeps them identical).
import type { AdapterDeps, ChannelBinding, HostedChannel } from "./switchboard.ts";

type Create = (cfg: Record<string, unknown>, deps: AdapterDeps) => HostedChannel;

const manifest = (name: string, displayName: string, chatKinds: string[]) => ({
  name, version: "0.1.0", kind: "channel", apiVersion: "1", displayName, chatKinds, startDelayMs: 0, maxRestarts: 8,
});

type HostDep = "secrets" | "pairing" | "outputs" | "logger" | "now";
/** The host's own deps an adapter takes (an adapter refuses a key it does not know), plus every test seam as given. */
function depsFor(d: AdapterDeps, wants: readonly HostDep[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { secrets, pairing, outputs, logger, now, stateDir: _stateDir, ...seams } = d;
  const host: Record<HostDep, unknown> = { secrets, pairing, outputs, logger, now };
  const out: Record<string, unknown> = {};
  for (const k of wants) if (host[k] !== undefined) out[k] = host[k];
  return { ...out, ...extra, ...seams };
}

// The adapters validate their own configuration (closed world) and take the schema's `channels.<id>` object as it is. The casts stop
// at this file: the packages' option types are not importable from the core's types.
export const DEFAULT_BINDINGS: readonly ChannelBinding[] = [
  {
    id: "discord", manifest: manifest("discord", "Discord", ["direct", "group"]),
    async load() {
      const m = await import("../../../channels-discord/src/index.ts");
      return ((c, d) => m.createDiscordChannel(c as never, depsFor(d, ["secrets", "pairing", "outputs", "logger", "now"], { stateStore: new m.FileGatewayStateStore(d.stateDir) }) as never)) as Create;
    },
  },
  {
    id: "slack", manifest: manifest("slack", "Slack", ["direct", "group"]),
    async load() {
      const m = await import("../../../channels-slack/src/index.ts");
      return ((c, d) => m.createSlackChannel(c as never, depsFor(d, ["secrets", "pairing", "outputs", "logger", "now"], { seen: new m.FileSeenStore(d.stateDir) }) as never)) as Create;
    },
  },
  {
    id: "matrix", manifest: manifest("matrix", "Matrix", ["direct", "group"]),
    async load() {
      const m = await import("../../../channels-matrix/src/index.ts");
      return ((c, d) => m.createMatrixChannel(c as never, depsFor(d, ["secrets", "pairing", "outputs", "logger", "now"], { syncStore: new m.FileSyncTokenStore(d.stateDir) }) as never)) as Create;
    },
  },
  {
    id: "signal", manifest: manifest("signal", "Signal", ["direct", "group"]),
    async load() {
      const m = await import("../../../channels-signal/src/index.ts");
      return ((c, d) => m.createSignalChannel(c as never, depsFor(d, ["pairing", "outputs", "logger", "now"]) as never)) as Create;
    },
  },
  {
    id: "email", manifest: manifest("email", "Email", ["direct"]),
    async load() {
      const m = await import("../../../channels-email/src/index.ts");
      return ((c, d) => m.createEmailChannel(c as never, depsFor(d, ["secrets", "pairing", "outputs", "logger", "now"], { uidStore: new m.FileUidStore(d.stateDir), threadStore: new m.FileThreadStore(d.stateDir) }) as never)) as Create;
    },
  },
  {
    id: "telegram", manifest: manifest("telegram", "Telegram", ["direct", "group"]),
    async load() {
      const m = await import("../../../channels-telegram/src/index.ts");
      return (((c: Record<string, unknown>, d: AdapterDeps) => m.createTelegramChannel(c as never, depsFor(d, ["secrets", "pairing", "outputs", "logger", "now"], { offsetStore: new m.FileOffsetStore(d.stateDir) }) as never)) as unknown) as Create;
    },
  },
];
