// The node:tls glue for pinned and CA-anchored connections: server options with a TLS floor, and the step that turns
// "what this socket was shown" into the Presented value trust-rollover's evaluateConnection() decides on.
//
// Client recipe (the desktop app's Rust client does the same with rustls; this is the reference and the test harness):
//   self-signed (certPin):  tls.connect({ rejectUnauthorized: false })        then verifySocket(device, socket)
//   company CA  (caPin):    tls.connect({ ca: [caPem], servername: host })    then verifySocket(device, socket, caPem)
// For a CA anchor the chain and host name are verified normally by TLS against the pinned CA only (never the OS
// store); `socket.authorized` is the proof, so a leaf renewed by the same CA needs nothing. During a CA rollover a
// device dials with its current CA first and, if that fails to verify, with the next one.
import type { SecureContextOptions, TLSSocket } from "node:tls";
import { certPin, pinOf } from "./fingerprint.ts";
import { evaluateConnection } from "./trust-rollover.ts";
import type { DeviceTrust, Presented, Verdict } from "./trust-rollover.ts";
import type { TlsMaterial } from "./secrets.ts";

export function tlsServerOptions(m: TlsMaterial): SecureContextOptions & { minVersion: "TLSv1.2" } {
  return { key: m.key, cert: m.cert, minVersion: "TLSv1.2" };
}

/** `trustedCaPem` is the CA the connection was configured to verify against, if any. */
export function presentedFromSocket(socket: TLSSocket, trustedCaPem?: string): Presented {
  const peer = socket.getPeerCertificate();
  if (!peer || !peer.raw) throw new Error("the peer presented no certificate");
  return {
    leafPin: pinOf(peer.raw),
    ...(trustedCaPem !== undefined && socket.authorized ? { chainCaPin: certPin(trustedCaPem) } : {}),
  };
}

export function verifySocket(device: DeviceTrust, socket: TLSSocket, trustedCaPem?: string): Verdict {
  return evaluateConnection(device, presentedFromSocket(socket, trustedCaPem));
}
