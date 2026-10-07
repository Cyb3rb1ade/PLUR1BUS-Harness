// Security pieces of `network` exposure (desktop spec §6.2): the client-subnet allow-list, the confirmation record for
// the security notice, and `firstAidChecks`, the warnings `1staid check` reports while network publishing is on (and,
// for a detected Funnel, at every level). Plain data in, plain data out; the API package feeds the state in.
import { cidrContains, formatCidr, parseCidr, parseIp } from "./net-address.ts";
import type { ParsedCidr } from "./net-address.ts";
import type { RemoteConfig } from "./exposure.ts";
import type { EpochMs, NoticeAck, Note } from "./types.ts";

const DAY_MS = 86_400_000;

// --- allow-list ----------------------------------------------------------------------------------------------------

export interface Allowlist {
  /** Normalised, de-duplicated rules in the order given. */
  readonly cidrs: readonly string[];
  /** True for an empty list: every client may connect (pairing is still required for every device). */
  readonly isEmpty: boolean;
  /** Whether a client address passes. IPv4-mapped IPv6 addresses count as the IPv4 address they carry; an address that
   *  does not parse never passes a non-empty list. */
  allows(address: string): boolean;
}
export interface AllowlistIssue extends Note { readonly path: string }

export function compileAllowlist(rules: readonly string[]): { ok: true; list: Allowlist } | { ok: false; issues: readonly AllowlistIssue[] } {
  const issues: AllowlistIssue[] = [];
  const parsed: ParsedCidr[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const cidr = typeof rule === "string" ? parseCidr(rule) : undefined;
    if (!cidr) { issues.push({ path: `[${i}]`, code: "invalid-cidr", message: `${String(rule)} is not a valid IPv4 or IPv6 CIDR` }); return; }
    const text = formatCidr(cidr);
    if (!seen.has(text)) { seen.add(text); parsed.push(cidr); }
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    list: {
      cidrs: parsed.map(formatCidr),
      isEmpty: parsed.length === 0,
      allows(address) {
        if (parsed.length === 0) return true;
        const ip = parseIp(address);
        return ip !== undefined && parsed.some((c) => cidrContains(c, ip));
      },
    },
  };
}

// --- security notice -----------------------------------------------------------------------------------------------

/** Raised when the notice text changes in substance, so an old confirmation stops counting. */
export const SECURITY_NOTICE_VERSION = 1;

export interface NoticeItem { readonly code: string; readonly text: string }

/** What the person is shown before network publishing can be confirmed. Codes are stable keys for translation. */
export function securityNoticeItems(config: RemoteConfig): NoticeItem[] {
  if (config.publish !== "network") return [];
  const items: NoticeItem[] = [
    { code: "reachable-from-network", text: "Other computers on this network (LAN, VPN or company network) will be able to reach the harness's login and API over TLS." },
    { code: "pairing-required", text: "Every device must still pair with a one-time code and gets its own revocable token; reaching the address is not enough to sign in." },
    { code: "tls-inspection", text: "A company proxy that inspects TLS and re-signs traffic breaks a pinned self-signed certificate on purpose: devices will show 'certificate changed' and refuse. Exclude this address from inspection or use a company certificate." },
    { code: "allow-list", text: "You can restrict which client subnets may connect (CIDR notation). Pairing and sign-in apply either way." },
  ];
  if (config.allowSubnets.length === 0) {
    items.push({ code: "allow-list-empty", text: "No client subnet is restricted right now: any machine that can reach this address may attempt to connect." });
  }
  items.push({ code: "never-public", text: "The API is never published to the internet: there is no Funnel and no public sharing of the API at any level." });
  return items;
}

export type ConfirmResult =
  | { readonly ok: true; readonly ack: NoticeAck & { readonly version: number } }
  | { readonly ok: false; readonly code: "not-confirmed" | "bad-record"; readonly message: string };

/** Builds the who/when record. Refuses anything but an explicit `confirmed: true` by a named person for this version. */
export function confirmSecurityNotice(input: unknown): ConfirmResult {
  if (typeof input !== "object" || input === null) return { ok: false, code: "bad-record", message: "expected an object" };
  const o = input as { by?: unknown; at?: unknown; confirmed?: unknown; version?: unknown };
  if (o.confirmed !== true) return { ok: false, code: "not-confirmed", message: "the security notice must be confirmed explicitly" };
  if (typeof o.by !== "string" || o.by.trim() === "") return { ok: false, code: "bad-record", message: "who confirmed is required" };
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return { ok: false, code: "bad-record", message: "when it was confirmed is required" };
  if (o.version !== undefined && o.version !== SECURITY_NOTICE_VERSION) return { ok: false, code: "bad-record", message: "this confirmation is for another version of the notice" };
  return { ok: true, ack: { by: o.by.trim(), at: o.at, version: SECURITY_NOTICE_VERSION } };
}

/** Network publishing needs a confirmation of the current notice version. */
export function noticeNeeded(config: RemoteConfig, ack: NoticeAck | undefined): boolean {
  return config.publish === "network" && (ack === undefined || ack.version !== SECURITY_NOTICE_VERSION);
}

// --- 1staid --------------------------------------------------------------------------------------------------------

export const CERT_WARN_DAYS = 30;

export interface FirstAidState {
  readonly now: EpochMs;
  /** Expiry of the certificate the network listener serves. */
  readonly certNotAfter?: EpochMs | undefined;
  readonly noticeAck?: NoticeAck | undefined;
  /** `parseServeStatus().funnelActive` from the last Tailscale check. */
  readonly funnelActive?: boolean | undefined;
  /** False when the network listener has no usable certificate and key. */
  readonly tlsReady?: boolean | undefined;
}

export interface FirstAidEntry {
  readonly id: string;
  readonly severity: "warn";
  readonly message: string;
  readonly fix?: string;
}

/** The `warn` entries `1staid check` shows for remote access. A detected Funnel is reported whatever the configured level. */
export function firstAidChecks(config: RemoteConfig, state: FirstAidState): FirstAidEntry[] {
  const out: FirstAidEntry[] = [];
  const warn = (id: string, message: string, fix?: string) => out.push({ id, severity: "warn", message, ...(fix !== undefined ? { fix } : {}) });

  if (state.funnelActive) {
    warn("remote.funnel-active", "Tailscale Funnel is active on this machine: whatever it serves is reachable from the internet. The harness API must never be.",
      "Turn Funnel off (tailscale funnel reset, or the Tailscale admin console) and keep remote.publish at tailnet or network.");
  }
  if (config.publish !== "network") return out;

  warn("remote.network-on", "Network publishing is on: other machines on the network can reach the harness's TLS listener.", "Set remote.publish to tailnet or local when it is not needed.");
  if (noticeNeeded(config, state.noticeAck)) {
    warn("remote.notice-unconfirmed", "The security notice for network publishing has not been confirmed (for this version of the notice).", "Review and confirm the notice in Devices & Remote.");
  }
  if (state.tlsReady === false) {
    warn("remote.tls-not-ready", "Network publishing is on but there is no usable TLS certificate and key: the listener stays off.", "Generate the self-signed certificate or upload a company certificate.");
  }
  if (state.certNotAfter !== undefined) {
    const left = state.certNotAfter - state.now;
    if (left < 0) {
      warn("remote.cert-expired", "The TLS certificate has expired: paired devices will refuse the connection.", "Stage a new certificate and switch (trust rollover).");
    } else if (left <= CERT_WARN_DAYS * DAY_MS) {
      warn("remote.cert-expiring", `The TLS certificate expires in ${Math.floor(left / DAY_MS)} days.`, "Stage a new certificate now so paired devices receive it before the switch (trust rollover).");
    }
  }
  if (config.allowSubnets.length === 0) {
    warn("remote.allowlist-empty", "No client subnet allow-list is set: any machine that can reach the address may attempt to connect.", "Add the subnets your devices connect from (remote.allowSubnets).");
  }
  return out;
}
