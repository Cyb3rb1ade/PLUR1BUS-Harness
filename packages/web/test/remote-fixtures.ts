import { randomBytes } from "node:crypto";
import type { App } from "./harness.ts";
import type { RemoteStatus } from "../src/pages/settings/sections/devices/remote.ts";
export function remoteFixture(app: App, given: Partial<RemoteStatus> = {}) {
  let remote: RemoteStatus = { publish: "local", tls: "self-signed", bind: {}, allowSubnets: [], noticeRequired: true,
    noticeItems: [{ code: "reachable-from-network", text: "Network peers may reach the login over TLS." }, { code: "never-public", text: "No public API sharing." }],
    status: { state: "local" }, ...given };
  let confirmStatus = 200; let readStatus = 200; let delay = 0; let confirmed = false; let pairing = true; let certificateStaged = false;
  let trust = { phase: "none" as "none" | "staged", current: { kind: "cert", pin: `sha256:${randomBytes(32).toString("hex")}` },
    next: undefined as { kind: string; pin: string } | undefined, stagedAt: undefined as number | undefined,
    progress: { received: 0, total: 0, missing: [] as { id: string; name: string }[] } };
  const calls: { method: string; path: string; body: unknown }[] = [];
  app.server.extensions.unshift(async (req, res, path, raw) => {
    if (!path.startsWith("/api/v1/remote") && !path.startsWith("/api/v1/devices/")) return false;
    if (!["/api/v1/remote", "/api/v1/remote/confirm", "/api/v1/remote/certificate", "/api/v1/devices/pairing", "/api/v1/devices/trust", "/api/v1/devices/trust/rotate"].includes(path)) return false;
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const session = app.server.sessionOf(req); if (!session) { send(401, { error: "E_UNAUTHENTICATED" }); return true; }
    if (req.method !== "GET") { const csrf = req.headers["x-csrf-token"]; if (typeof csrf !== "string" || !session.csrf.delete(csrf)) { send(403, { error: "E_DENIED", reason: "csrf" }); return true; } }
    const body = raw ? JSON.parse(raw) : {}; calls.push({ method: req.method!, path, body });
    if (path === "/api/v1/remote" && req.method === "GET") { if (delay) await new Promise(r => setTimeout(r, delay)); send(readStatus, readStatus === 200 ? remote : { error: readStatus === 403 ? "E_DENIED" : "E_INTERNAL" }); }
    else if (path === "/api/v1/remote/confirm") { if (confirmStatus !== 200) { send(confirmStatus, { error: "E_DENIED" }); return true; } confirmed = true; send(200, { ack: { by: "owner", at: Date.now(), version: 1 }, restartRequired: true }); }
    else if (path === "/api/v1/remote/certificate") { send(200, { certPin: trust.current.pin, restartRequired: true, staged: certificateStaged }); }
    else if (path === "/api/v1/remote" && req.method === "PATCH") { if (body.publish === "network" && !confirmed) { send(403, { error: "E_DENIED", reason: "network-notice-required" }); return true; } remote = { ...remote, ...body }; send(200, { publish: remote.publish, restartRequired: true }); }
    else if (path === "/api/v1/devices/pairing" && req.method === "GET") { send(200, { publish: remote.publish, pairingAvailable: remote.publish !== "local" && pairing, open: 0, pending: 0 }); }
    else if (path === "/api/v1/devices/pairing") {
      if (remote.publish === "local") { send(404, { error: "E_NOT_AVAILABLE" }); return true; }
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const code = [...randomBytes(8)].map(b => alphabet[b % alphabet.length]).join("");
      const link = `plur1bus://pair?${new URLSearchParams({ origin: "https://harness.example", code, pin: trust.current.pin })}`;
      send(200, { id: randomBytes(8).toString("hex"), link, qr: { text: link, mode: "byte", errorCorrection: "M", length: link.length, maxLength: 2331, fits: true }, code, expiresAt: Date.now() + 60_000, fingerprint: trust.current.pin });
    } else if (path === "/api/v1/devices/trust") { send(200, trust); }
    else if (path === "/api/v1/devices/trust/rotate") { if (body.operation === "stage") trust = { ...trust, phase: "staged", next: { kind: "cert", pin: `sha256:${randomBytes(32).toString("hex")}` }, stagedAt: Date.now() }; else trust = { ...trust, phase: "none", current: body.operation === "activate" && trust.next ? trust.next : trust.current, next: undefined }; send(200, trust); }
    return true;
  });
  return { calls, setConfirmStatus(status: number) { confirmStatus = status; }, setTrustStaged() { trust = { ...trust, phase: "staged", next: { kind: "cert", pin: `sha256:${randomBytes(32).toString("hex")}` }, stagedAt: Date.now() }; }, setReadStatus(status: number) { readStatus = status; }, setDelay(ms: number) { delay = ms; }, setPairingAvailable(value: boolean) { pairing = value; }, setCertificateStaged(value: boolean) { certificateStaged = value; },
    setTrustMissing(devices: { id: string; name: string }[]) { trust.progress = { received: 1, total: devices.length + 1, missing: devices }; },
  };
}
