/** SSH setup approval names exact central host/port entries and is invalidated by changed endpoint or revision. */
import test from "node:test";
import type { SshConnection } from "../../rpc-schema/generated/types.ts";
import assert from "node:assert/strict";
import { sshConnectionInput, egressConsentSubject, sshEgressApproval } from "../src/pages/import/ssh-model.ts";

const input = {
  id: "source",
  host: "Example.TEST",
  port: "22",
  user: "reader",
  roots: "/home/reader/source",
  allowPrivate: false,
};
const policy = { revision: "r1", value: { allowHosts: ["provider.example"], allowPorts: [443], allowLoopback: false } };
test("explicit SSH approval adds only the exact host and port in one revision-guarded batch", () => {
  const connection = sshConnectionInput(input);
  assert.equal(connection.host, "example.test");
  const subject = egressConsentSubject(policy, connection);
  assert.deepEqual(sshEgressApproval(policy, connection, subject), {
    ifRevision: "r1",
    changes: [
      { key: "egress.allowHosts", value: ["provider.example", "example.test"] },
      { key: "egress.allowPorts", value: [443, 22] },
    ],
  });
  assert.deepEqual(policy.value.allowHosts, ["provider.example"]);
  assert.throws(() => sshEgressApproval(policy, connection, ""));
  assert.throws(() => sshEgressApproval({ ...policy, revision: "r2" }, connection, subject));
  assert.throws(() => sshEgressApproval(policy, { ...connection, host: "other.test" }, subject));
  assert.throws(() => sshEgressApproval(policy, { ...connection, port: 2222 }, subject));
});
test("SSH setup rejects wildcard/userinfo/path hosts, ambiguous addresses, unsafe roots and invalid ports", () => {
  for (const host of [
    "*",
    "*.example.test",
    "user@example.test",
    "example.test/path",
    "example.test:22",
    "127.1",
    "0x7f000001",
  ])
    assert.throws(() => sshConnectionInput({ ...input, host }));
  for (const port of ["0", "65536", "1.5", "x"]) assert.throws(() => sshConnectionInput({ ...input, port }));
  for (const roots of ["", "relative", "/source/../outside", "/source\n/source"])
    assert.throws(() => sshConnectionInput({ ...input, roots }));
  const ipv6 = sshConnectionInput({ ...input, host: "[::1]" });
  assert.equal(ipv6.host, "::1");
  assert.equal(
    sshEgressApproval(policy, ipv6, egressConsentSubject(policy, ipv6)).changes[0]!.value instanceof Array,
    true,
  );
});

test("host-key consent cannot label a current probe with a stale saved connection endpoint", async () => {
  const { sameSshConnection } = await import("../src/pages/import/ssh-model.ts");
  const saved = {
    id: "source",
    host: "source.example",
    port: 22,
    user: "reader",
    roots: ["/source"] as [string],
    allowPrivate: false,
  };
  assert.equal(sameSshConnection(saved, { ...saved, roots: [...saved.roots] }), true);
  const changed: (SshConnection | undefined)[] = [
    undefined,
    { ...saved, host: "changed.example" },
    { ...saved, port: 2222 },
    { ...saved, user: "changed" },
    { ...saved, roots: ["/other"] },
    { ...saved, allowPrivate: true },
    { ...saved, hostKey: { sha256: "SHA256:new" } },
  ];
  for (const current of changed) assert.equal(sameSshConnection(saved, current), false);
});

test("only authoritative container metadata supplies a host proposal and never approves a private address", async () => {
  const { initialSshForm } = await import("../src/pages/import/ssh-model.ts");
  assert.equal(initialSshForm(undefined).host, "");
  const suggested = initialSshForm({ host: "host.docker.internal", reason: "container-host" });
  assert.equal(suggested.host, "host.docker.internal");
  assert.equal(suggested.allowPrivate, false);
  assert.equal(suggested.id, "");
  assert.equal(suggested.roots, "");
});
