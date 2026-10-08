// End to end over real sockets: node:tls servers and clients on loopback only, certificates made by this package.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import type { Server, TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { generateSelfSigned } from "../src/selfsigned.ts";
import { importCompanyCa } from "../src/company-ca.ts";
import { createMemorySecretPort, loadTlsMaterial } from "../src/secrets.ts";
import { certPin, pinOf } from "../src/fingerprint.ts";
import { presentedFromSocket, tlsServerOptions, verifySocket } from "../src/pinning.ts";
import { PairCodeStore } from "../src/pair-code.ts";
import { createClientNonce, createProofLimiter, handlePairProof, verifyPairProof } from "../src/pair-proof.ts";
import type { PairProofResponse } from "../src/pair-proof.ts";
import { admitSocket, compileAllowlist } from "../src/security.ts";
import { issueLeaf, makePki, NOW } from "./helpers.ts";

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return (server.address() as AddressInfo).port;
}

function connect(port: number, opts: Record<string, unknown> = {}): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: "127.0.0.1", port, ...opts });
    sock.once("secureConnect", () => resolve(sock));
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("closed before the handshake finished")));
  });
}

async function selfSigned(keyRef = "k") {
  const secrets = createMemorySecretPort();
  const gen = await generateSelfSigned({ hostnames: ["localhost"], ips: ["127.0.0.1"], now: new Date(), keyRef, secrets });
  const material = await loadTlsMaterial(secrets, keyRef, gen.certPem);
  return { gen, material };
}

test("self-signed: a client holding the pin trusts the server, a client holding another pin refuses, plain trust refuses", async () => {
  const { gen, material } = await selfSigned();
  const port = await listen(createTlsServer(tlsServerOptions(material), (s) => s.end("hello")));

  const sock = await connect(port, { rejectUnauthorized: false });
  assert.equal(presentedFromSocket(sock).leafPin, gen.certPin);
  assert.equal(verifySocket({ current: { kind: "cert", pin: gen.certPin } }, sock), "trusted");
  assert.equal(verifySocket({ current: { kind: "cert", pin: pinOf(Buffer.from("another certificate")) } }, sock), "certificate-changed");
  assert.equal(verifySocket({ current: { kind: "cert", pin: pinOf(Buffer.from("x")) }, next: { kind: "cert", pin: gen.certPin } }, sock), "trusted-next");
  assert.equal(verifySocket({ current: { kind: "ca", pin: gen.certPin } }, sock), "certificate-changed", "a leaf pin does not satisfy a CA anchor");
  sock.destroy();

  await assert.rejects(connect(port), (e: NodeJS.ErrnoException) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT", "without the pin the OS trust model refuses it");
});

test("self-signed: the server's key really belongs to the certificate it presents (handshake completes, data flows)", async () => {
  const { material } = await selfSigned();
  const port = await listen(createTlsServer(tlsServerOptions(material), (s) => s.end("hello")));
  const sock = await connect(port, { rejectUnauthorized: false });
  const data = await new Promise<string>((res) => { let buf = ""; sock.on("data", (d) => { buf += d; }); sock.on("end", () => res(buf)); });
  assert.equal(data, "hello");
  assert.ok(["TLSv1.2", "TLSv1.3"].includes(sock.getProtocol() ?? ""));
});

test("tlsServerOptions: TLS 1.2 floor, key and certificate passed through", async () => {
  const { material } = await selfSigned();
  assert.deepEqual(tlsServerOptions(material), { key: material.key, cert: material.cert, minVersion: "TLSv1.2" });
});

test("company CA: the chain verifies to the pinned root, a renewed leaf from the same CA needs no new pin, a stranger CA fails", async () => {
  const pki = makePki();
  const secrets = createMemorySecretPort();
  const imp = await importCompanyCa({
    certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem,
    hostnames: ["harness.corp.example"], ips: ["192.168.1.20"], now: NOW, keyRef: "c1", secrets,
  });
  assert.ok(imp.ok, JSON.stringify(imp));
  const device = { current: { kind: "ca", pin: imp.caPin! } } as const;
  const dial = (port: number, ca: string, extra: Record<string, unknown> = {}) =>
    connect(port, { servername: "harness.corp.example", ca: [ca], ...extra });

  const port1 = await listen(createTlsServer(tlsServerOptions(await loadTlsMaterial(secrets, "c1", imp.chainPem)), (s) => s.end()));
  const s1 = await dial(port1, pki.rootPem);
  assert.equal(s1.authorized, true);
  assert.equal(verifySocket(device, s1, pki.rootPem), "trusted");
  s1.destroy();

  // renewal: same CA, new leaf and key. The device's anchor is the CA, so nothing changes for it.
  const renewed = issueLeaf(pki);
  const imp2 = await importCompanyCa({
    certChainPem: renewed.leafPem + pki.interPem, keyPem: renewed.leafKeyPem, caPem: pki.rootPem,
    hostnames: ["harness.corp.example"], ips: ["192.168.1.20"], now: NOW, keyRef: "c2", secrets,
  });
  assert.ok(imp2.ok);
  assert.notEqual(imp2.leafPin, imp.leafPin);
  const port2 = await listen(createTlsServer(tlsServerOptions(await loadTlsMaterial(secrets, "c2", imp2.chainPem)), (s) => s.end()));
  const s2 = await dial(port2, pki.rootPem);
  assert.equal(verifySocket(device, s2, pki.rootPem), "trusted");
  assert.equal(presentedFromSocket(s2, pki.rootPem).leafPin, imp2.leafPin);
  s2.destroy();

  // a CA the server's chain does not lead to: not authorized, so no CA anchor is satisfied
  const stranger = makePki();
  const s3 = await dial(port1, stranger.rootPem, { rejectUnauthorized: false });
  assert.equal(s3.authorized, false);
  assert.equal(verifySocket(device, s3, stranger.rootPem), "certificate-changed");
  s3.destroy();

  // and with no CA configured the normal verification refuses the private chain
  await assert.rejects(dial(port1, "", { ca: undefined }), /.+/);
});

test("pair-proof over real TLS: the genuine harness is accepted, a relaying TLS-inspecting proxy is refused before the code is sent", async () => {
  const LOGICAL_ORIGIN = "https://harness.corp.example:18701";
  const LIGHT = { memoryKiB: 64, passes: 1, parallelism: 1 };
  const { gen, material } = await selfSigned("real");
  const store = new PairCodeStore({ params: LIGHT });
  const issued = store.issue(Date.now());
  const limiter = createProofLimiter();

  const real = createTlsServer(tlsServerOptions(material), (sock) => {
    sock.setEncoding("utf8");
    sock.once("data", (line: string) => {
      const res = handlePairProof(JSON.parse(line), { store, now: Date.now(), origin: LOGICAL_ORIGIN, servedFingerprint: gen.certPin, source: "127.0.0.1", limiter });
      sock.end(JSON.stringify(res.body));
    });
  });
  const realPort = await listen(real);

  // the proxy has its own certificate and relays every request to the real harness
  const { material: proxyMaterial } = await selfSigned("proxy");
  const seenByProxy: string[] = [];
  const proxy = createTlsServer(tlsServerOptions(proxyMaterial), (client) => {
    client.setEncoding("utf8");
    client.once("data", async (line: string) => {
      seenByProxy.push(line);
      const upstream = await connect(realPort, { rejectUnauthorized: false });
      upstream.setEncoding("utf8");
      upstream.write(line);
      let buf = "";
      upstream.on("data", (d) => { buf += d; });
      upstream.on("end", () => client.end(buf));
    });
  });
  const proxyPort = await listen(proxy);

  async function proveTo(port: number): Promise<{ ok: boolean; pin?: string }> {
    const sock = await connect(port, { rejectUnauthorized: false });
    const fingerprintSeen = pinOf(sock.getPeerCertificate().raw);
    const clientNonce = createClientNonce();
    sock.setEncoding("utf8");
    sock.write(JSON.stringify({ clientNonce }));
    const text = await new Promise<string>((res) => { let buf = ""; sock.on("data", (d) => { buf += d; }); sock.on("end", () => res(buf)); });
    const response = JSON.parse(text) as PairProofResponse;
    const r = verifyPairProof({ code: issued.code, response, fingerprintSeen, origin: LOGICAL_ORIGIN, clientNonce, params: LIGHT });
    return r.ok ? { ok: true, pin: fingerprintSeen } : { ok: false };
  }

  const direct = await proveTo(realPort);
  assert.deepEqual(direct, { ok: true, pin: gen.certPin }, "the client now pins the real certificate");
  assert.equal(certPin(gen.certPem), direct.pin);

  const viaProxy = await proveTo(proxyPort);
  assert.deepEqual(viaProxy, { ok: false });
  assert.equal(seenByProxy.length, 1);
  assert.ok(!seenByProxy.some((l) => l.includes(issued.code) || l.includes(issued.code.replace("-", ""))), "the proxy never saw the code");

  assert.equal(store.redeem(issued.code, Date.now(), "127.0.0.1").ok, true, "the code is still good: the proof never consumed it");
});

test("allow-list at the socket: an address outside the subnets is cut off before the TLS handshake", async () => {
  const { material } = await selfSigned();
  const serve = (rules: string[]) => {
    const compiled = compileAllowlist(rules);
    assert.ok(compiled.ok);
    const server = createTlsServer(tlsServerOptions(material), (s) => s.end("welcome"));
    server.on("connection", (raw) => { if (!admitSocket(compiled.list, raw)) raw.destroy(); });
    return listen(server);
  };
  const inside = await serve(["127.0.0.0/8"]);
  const ok = await connect(inside, { rejectUnauthorized: false });
  ok.destroy();
  const outside = await serve(["10.0.0.0/8"]);
  await assert.rejects(connect(outside, { rejectUnauthorized: false }), /.+/);
  const open = await serve([]);
  (await connect(open, { rejectUnauthorized: false })).destroy();
});

test("admitSocket: an empty list admits all, a non-empty list needs a parseable remote address on it", () => {
  const list = (r: string[]) => { const c = compileAllowlist(r); assert.ok(c.ok); return c.list; };
  assert.equal(admitSocket(list([]), {}), true);
  assert.equal(admitSocket(list(["10.0.0.0/8"]), {}), false);
  assert.equal(admitSocket(list(["10.0.0.0/8"]), { remoteAddress: "::ffff:10.2.3.4" }), true);
  assert.equal(admitSocket(list(["10.0.0.0/8"]), { remoteAddress: "11.2.3.4" }), false);
});
