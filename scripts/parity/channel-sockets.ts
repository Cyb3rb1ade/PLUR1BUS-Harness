import { Gateway } from "../../packages/channels-discord/src/gateway.ts";
import { FakeGateway } from "../../packages/channels-discord/test/helpers/fake-discord.ts";
import { FakeClock } from "../../packages/channels-discord/test/helpers/fake-clock.ts";
import { SocketMode } from "../../packages/channels-slack/src/socket.ts";
import { FakeSocket } from "../../packages/channels-slack/test/helpers/fake-slack.ts";

type Frame = Record<string, unknown>;
type Step = { frame?: Frame; advance?: number; sent: string[] };

function exchanges(steps: Step[]) {
  const recorded = [];
  let send: unknown[] = [];
  for (const step of steps) {
    if (step.frame) {
      recorded.push({ send, receive: [step.frame] });
      send = [];
    }
    send.push(...step.sent.map((text) => JSON.parse(text)));
  }
  if (send.length) recorded.push({ send, receive: [] });
  return recorded;
}

export async function discordGateway(resume: boolean) {
  const clock = new FakeClock();
  const abort = new AbortController();
  const peer = new FakeGateway();
  peer.auto = false;
  const token = "synthetic-discord-marker";
  const events: unknown[] = [];
  const steps: Step[] = [];
  const session = resume ? {
    sessionId: "recorded-session", botId: "42", seq: 7, resumeGatewayUrl: "wss://gateway.discord.gg",
  } : undefined;
  const gateway = new Gateway({
    token, intents: 513, url: "wss://gateway.discord.gg",
    webSocket: (url) => {
      const ws = peer.factory(url);
      const send = ws.send.bind(ws);
      ws.send = (raw) => {
        steps.at(-1)?.sent.push(raw.replaceAll(token, "[FIXTURE:DISCORD]").replace(`"os":"${process.platform}"`, '"os":"fixture-os"'));
        send(raw);
      };
      return ws;
    },
    signal: abort.signal, sleep: clock.sleep, random: () => 0.5, now: clock.now,
    botId: "42", session,
    onReady: (info, resumed) => events.push({ ready: info.sessionId, resumed }),
    onDispatch: (name, data) => events.push({ dispatch: name, data }),
    onSession: () => {},
    onConnection: () => {},
    onFatal: (code) => events.push({ fatal: code }),
    log: () => {},
  });
  const running = gateway.run();
  try {
    await clock.flush();
    const put = (frame: Frame) => {
      steps.push({ frame, sent: [] });
      peer.latest.server(frame);
    };
    const advance = async (ms: number) => {
      steps.push({ advance: ms, sent: [] });
      await clock.advance(ms);
    };
    put({ op: 10, d: { heartbeat_interval: 1000 } });
    if (resume) put({ op: 0, t: "RESUMED", s: 8, d: {} });
    else put({ op: 0, t: "READY", s: 1, d: {
      user: { id: "42" }, application: { id: "43" },
      session_id: "recorded-session", resume_gateway_url: "wss://gateway.discord.gg",
    } });
    put({ op: 0, t: "MESSAGE_CREATE", s: 11, d: { id: "44", content: "Hallo", author: { id: "43" }, type: 0 } });
    await advance(500);
    put({ op: 11 });
    await advance(1000);
    await advance(1000); // missing ACK, then close with a resumable code
    return {
      source: "packages/channels-discord/src/gateway.ts", transport: "websocket", exchanges: exchanges(steps),
      steps, initialSession: session, expected: { events, close: peer.latest.closed, session: gateway.session },
    };
  } finally {
    abort.abort();
    await running;
  }
}

export async function slackSocket() {
  const abort = new AbortController();
  const peer = new FakeSocket("wss://slack.fixture.invalid", false);
  const steps: Step[] = [];
  const events: unknown[] = [];
  const mode = new SocketMode({
    openUrl: async () => peer.url,
    socketFactory: () => peer,
    onEnvelope: (event) => events.push({ received: event.envelope_id, ackCount: peer.sent.length }),
    onState: (connected) => { if (connected) events.push({ connected }); },
    onFatal: (error) => events.push({ fatal: error.code }),
    log: () => {}, sleep: async () => {}, random: () => 0.5, now: () => 0,
  });
  const put = (frame: Frame) => {
    const prior = peer.sent.length;
    peer.serverSend(frame);
    steps.push({ frame, sent: peer.sent.slice(prior) });
  };
  try {
    const starting = mode.start(abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    peer.open();
    put({ type: "events_api", envelope_id: "early" });
    put({ type: "hello", num_connections: 1 });
    await starting;
    put({ type: "events_api", envelope_id: "e-1", payload: { event: { text: "Hallo" } } });
    put({ type: "events_api", envelope_id: "e-1", retry_attempt: 2 });
    put({ type: "events_api", envelope_id: "has spaces" });
    put({ type: "events_api", envelope_id: "e-2" });
    put({ type: "disconnect", reason: "link_disabled" });
    await Promise.resolve();
    await Promise.resolve();
    if (!peer.closed) throw new Error("Slack fixture did not settle after its fatal frame");
    return { source: "packages/channels-slack/src/socket.ts", transport: "websocket", exchanges: exchanges(steps), steps, expected: { events } };
  } finally {
    abort.abort();
    await mode.stop();
  }
}
