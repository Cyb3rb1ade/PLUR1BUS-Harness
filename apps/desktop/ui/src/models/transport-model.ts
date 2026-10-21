import type { CheckTarget, Purpose, Transport, TransportHint, TransportReport } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";

/** One line of text for the check panel or the banner: a catalogue key and its parameters (transport choice §7.2). */
export type Line = { key: MessageKey; values: Record<string, string> };

/** Tailscale notice texts (spec §5.3, §7.2); `note` picks a variant. */
const tailscaleKeys: Record<string, MessageKey> = {
  "tailscale-ok": "transport.tailscale.ok",
  "tailscale-self": "transport.tailscale.self",
  "tailscale-subnet-route": "transport.tailscale.subnet-route",
  "tailscale-not-installed": "transport.tailscale.not-installed",
  "tailscale-check-unavailable": "transport.tailscale.check-unavailable",
  "tailscale-daemon-down": "transport.tailscale.daemon-down",
  "tailscale-needs-login": "transport.tailscale.needs-login",
  "tailscale-stopped": "transport.tailscale.stopped",
  "tailscale-peer-unknown": "transport.tailscale.peer-unknown",
  "tailscale-peer-offline": "transport.tailscale.peer-offline",
  "tailscale-unreachable": "transport.tailscale.unreachable",
  "tailscale-route-mismatch": "transport.tailscale.route-mismatch",
  "tailscale-not-tailnet-target": "transport.tailscale.not-tailnet-target",
  "tailscale-short-name": "transport.tailscale.short-name",
};

/** Notices about the target itself (spec §8). */
const targetKeys: Record<string, MessageKey> = {
  "target-special": "transport.special",
  "target-not-connectable": "transport.error.target-not-connectable",
  "target-unresolved": "transport.unresolved",
  "target-dns-timeout": "transport.dns-timeout",
  "target-via-jump": "transport.via-jump",
  "range-public": "transport.range.public",
  "transport-store-readonly": "transport.store.newer",
};

/** Refusals and command errors a check or a pairing can return (spec §8, §4.4). */
const errorKeys: Record<string, MessageKey> = {
  "host-invalid": "transport.error.host-invalid",
  "host-ipv4-noncanonical": "transport.error.host-ipv4-noncanonical",
  "target-not-connectable": "transport.error.target-not-connectable",
  "target-unresolved": "transport.unresolved",
  "target-dns-timeout": "transport.dns-timeout",
  "transport-store-readonly": "transport.store.newer",
  "transport-confirm-needed": "transport.public.title",
};

/** States without a hint of their own (spec §5.3): `tailscale-peer-online` claims nothing about the path. */
const stateKeys: Record<string, MessageKey> = {
  "tailscale-peer-online": "transport.tailscale.peer-online",
};

const publicCodes = new Set(["target-public", "target-mixed", "target-changed-public"]);

/** Whether a hint is one of the public warnings the banner shows. */
export function isPublic(hint: TransportHint): boolean {
  return publicCodes.has(hint.code);
}

/** The lines of one non-public hint, `null` for a code this shell does not know (never shown raw). */
export function hintLines(hint: TransportHint): Line[] | null {
  const params = hint.params;
  if (hint.code === "tailscale-check-unavailable" && params.note === "flatpak") return [{ key: "transport.tailscale.check-unavailable.flatpak", values: params }];
  const key = tailscaleKeys[hint.code] ?? targetKeys[hint.code];
  if (!key) return null;
  const lines: Line[] = [{ key, values: params }];
  if (hint.code === "tailscale-peer-unknown" && params.note === "cgnat") lines.push({ key: "transport.tailscale.peer-unknown.cgnat", values: params });
  return lines;
}

/** The banner text of a public target (spec §7.2): the purpose's text, the mixed note, or the changed text. */
export function publicLines(report: TransportReport, purpose: Purpose): Line[] {
  const hint = report.hints.find(isPublic);
  if (!hint) return [];
  if (hint.code === "target-changed-public") return [{ key: "transport.public.changed", values: hint.params }];
  const lines: Line[] = [{ key: purpose === "remote" ? "transport.public.remote" : "transport.public.ssh", values: hint.params }];
  if (hint.code === "target-mixed") lines.push({ key: "transport.public.mixed", values: hint.params });
  return lines;
}

/** The notices of a report besides the public banner, then a hint-less Tailscale state. */
export function noticeLines(report: TransportReport): Line[] {
  const lines = report.hints.filter(hint => !isPublic(hint)).flatMap(hint => hintLines(hint) ?? []);
  const state = report.tailscale?.state;
  const stateKey = state ? stateKeys[state] : undefined;
  if (stateKey && !report.hints.some(hint => hint.code.startsWith("tailscale-"))) lines.push({ key: stateKey, values: { peer: report.tailscale?.peer ?? "" } });
  return lines;
}

/** Whether a report carries a Tailscale notice (the „Tailscale getrennt“ chip, spec §7.3). */
export function tailscaleNotice(report: TransportReport | null | undefined): boolean {
  return !!report?.hints.some(hint => hint.code.startsWith("tailscale-") && hint.severity === "notice");
}

/** The text of a refusal or command error, `null` for a code that is not a transport code. */
export function errorLine(code: string, host: string): Line | null {
  const key = errorKeys[code];
  return key ? { key, values: { host, address: host } } : null;
}

export type CheckFn = (target: CheckTarget, transport: Transport, purpose: Purpose) => Promise<TransportReport>;
export type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
export type ModelState = {
  transport: Transport | null;
  ack: boolean;
  target: CheckTarget | null;
  host: string;
  status: "idle" | "waiting" | "checking" | "done" | "error";
  report: TransportReport | null;
  error: string | null;
};

const fresh = (transport: Transport | null = null): ModelState => ({ transport, ack: false, target: null, host: "", status: "idle", report: null, error: null });

/**
 * The path choice and its check (spec §7.1, §5.4): a check runs 600 ms after target and path are valid; a newer
 * input supersedes an older request, whose late answer (or its `transport-check-busy`) is dropped. A change of target
 * or path clears the confirmation, as it does in Rust.
 */
export function createTransportModel(check: CheckFn | undefined, purpose: Purpose, timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }, debounceMs = 600) {
  let state = fresh();
  let sequence = 0;
  let timer: unknown;
  let listener: ((state: ModelState) => void) | null = null;
  const emit = () => listener?.(state);
  function schedule(delay: number) {
    sequence++;
    if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    if (!state.target || !state.transport || !check) { state = { ...state, status: "idle", report: null, error: null }; emit(); return; }
    state = { ...state, status: "waiting", report: null, error: null };
    emit();
    timer = timers.set(() => { timer = undefined; void run(); }, delay);
  }
  async function run() {
    const mine = ++sequence;
    const { target, transport } = state;
    if (!target || !transport || !check) return;
    state = { ...state, status: "checking" };
    emit();
    try {
      const report = await check(target, transport, purpose);
      if (mine !== sequence) return;
      state = { ...state, status: "done", report, error: null, ack: report.needsPublicAck && state.ack };
    } catch (error) {
      if (mine !== sequence || error === "transport-check-busy") return;
      state = { ...state, status: "error", report: null, error: typeof error === "string" ? error : "network" };
    }
    emit();
  }
  const confirmMissing = () => !!state.report?.needsPublicAck && !state.ack;
  /** Banners this choice already announced: a view rebuilt for the same choice does not announce them again. */
  const announced = new Set<string>();
  return {
    get state(): ModelState { return state; },
    purpose,
    announced,
    /** The latest view only; a re-rendered view replaces the previous listener. */
    subscribe(next: (state: ModelState) => void) { listener = next; },
    setTarget(target: CheckTarget | null, host: string) {
      if (JSON.stringify(target) === JSON.stringify(state.target)) return;
      state = { ...state, target, host, ack: false };
      schedule(debounceMs);
    },
    setTransport(transport: Transport) {
      if (transport === state.transport) return;
      state = { ...state, transport, ack: false };
      schedule(debounceMs);
    },
    setAck(ack: boolean) { state = { ...state, ack }; emit(); },
    /** *Verbindung prüfen*: check now. */
    checkNow() { schedule(0); },
    /** Whether a confirmation is needed and not given. */
    confirmMissing,
    /** A path is chosen and a needed confirmation is ticked. */
    ready(): boolean { return state.transport !== null && !confirmMissing(); },
    reset(transport: Transport | null = null) {
      sequence++;
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
      state = fresh(transport);
      announced.clear();
      emit();
    },
  };
}
export type TransportModel = ReturnType<typeof createTransportModel>;

/** The host of a normalized origin, as the check shows it (no brackets). */
export function originHost(origin: string): string {
  try { return new URL(origin).hostname.replace(/^\[|\]$/g, ""); } catch { return ""; }
}
