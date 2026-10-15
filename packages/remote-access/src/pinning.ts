// The node:tls glue for pinned and CA-anchored connections: server options with a TLS floor, and the step that turns
// "what this socket was shown" into the Presented value trust-rollover's evaluateConnection() decides on.
//
// Client recipe (the desktop app's Rust client does the same with rustls; this is the reference and the test harness):
//   self-signed (certPin):  tls.connect({ rejectUnauthorized: false })        then verifySocket(device, socket)
//   company CA  (caPin):    tls.connect({ ca: [caPem], servername: host })    then verifySocket(device, socket, caPem)
// For a CA anchor the chain and host name are verified normally by TLS against the pinned CA only (never the OS
// store); `socket.authorized` is the proof, so a leaf renewed by the same CA needs nothing. During a CA rollover a
// device dials with its current CA first and, if that fails to verify, with the next one.
import { X509Certificate } from "node:crypto";
import type { SecureContextOptions, TLSSocket } from "node:tls";
import { certPin, pinOf, toX509 } from "./fingerprint.ts";
import { evaluateConnection } from "./trust-rollover.ts";
import type { DeviceTrust, Presented, Verdict } from "./trust-rollover.ts";
import type { TlsMaterial } from "./secrets.ts";

export function tlsServerOptions(m: TlsMaterial): SecureContextOptions & { minVersion: "TLSv1.2" } {
  return { key: m.key, cert: m.cert, minVersion: "TLSv1.2" };
}

interface ChainLink { raw?: Uint8Array; issuerCertificate?: ChainLink }

/** Does the chain node reports for this connection really end at `caPem`? `authorized` only says it ended at *some* CA the
 *  connection was configured to trust; a caller that dialled with another CA (or the operating system's store) and names
 *  the pinned one here must not be believed. With no chain details reported (nothing to contradict the verification) it is. */
function chainEndsAt(peer: ChainLink, caPem: string): boolean {
  if (!peer.issuerCertificate) return true;
  const ca = toX509(caPem); const seen = new Set<ChainLink>(); let cur: ChainLink | undefined = peer; let top = peer;
  for (let hops = 0; cur && !seen.has(cur) && hops < 16; hops++) {
    seen.add(cur); top = cur;
    if (cur.raw && Buffer.from(cur.raw).equals(ca.raw)) return true;
    cur = cur.issuerCertificate;
  }
  try { const t = new X509Certificate(Buffer.from(top.raw ?? [])); return t.checkIssued(ca) && t.verify(ca.publicKey); } catch { return false; }
}

/** `trustedCaPem` is the CA the connection was configured to verify against, if any. */
export function presentedFromSocket(socket: TLSSocket, trustedCaPem?: string): Presented {
  const peer = socket.getPeerCertificate(true);
  if (!peer || !peer.raw) throw new Error("the peer presented no certificate");
  return {
    leafPin: pinOf(peer.raw),
    ...(trustedCaPem !== undefined && socket.authorized && chainEndsAt(peer as ChainLink, trustedCaPem) ? { chainCaPin: certPin(trustedCaPem) } : {}),
  };
}

export function verifySocket(device: DeviceTrust, socket: TLSSocket, trustedCaPem?: string): Verdict {
  return evaluateConnection(device, presentedFromSocket(socket, trustedCaPem));
}
