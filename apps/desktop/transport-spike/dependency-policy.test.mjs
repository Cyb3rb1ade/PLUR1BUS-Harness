import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("H: resolved spike graph pins russh/ring and excludes vulnerable RSA and aws-lc", () => {
  const manifest = fileURLToPath(new URL("Cargo.toml", import.meta.url));
  const data = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  const spike = data.packages.find(p => p.name === "plur1bus-ssh-spike");
  const nodes = new Map(data.resolve.nodes.map(n => [n.id, n]));
  const packages = new Map(data.packages.map(p => [p.id, p]));
  const reached = new Set();
  function visit(id) { if (reached.has(id)) return; reached.add(id); for (const d of nodes.get(id).dependencies) visit(d); }
  visit(spike.id);
  const resolved = [...reached].map(id => packages.get(id));
  const russh = resolved.find(p => p.name === "russh");
  assert.equal(russh.version, "0.64.1");
  assert.ok(nodes.get(russh.id).features.includes("ring"));
  assert.ok(!nodes.get(russh.id).features.includes("rsa"));
  for (const name of ["rsa", "aws-lc-rs", "aws-lc-sys", "russh-keys"]) assert.ok(!resolved.some(p => p.name === name), name);
  assert.ok(!data.packages.some(p => p.name === "rsa"), "rsa must be absent from the entire desktop workspace, including public-operation dependencies");
  for (const d of spike.dependencies.filter(d => d.source !== null)) assert.ok(d.req.startsWith("="), d.name);
  assert.ok(!data.packages.filter(p => p.name !== spike.name).some(p => p.dependencies.some(d => d.name === spike.name)), "research package must not enter the app");
});
