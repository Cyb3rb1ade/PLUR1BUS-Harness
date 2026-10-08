// M8 container image: static invariants of the Dockerfile, .dockerignore and deploy/compose.yaml (desktop spec
// §6.15.7/§6.15.9/§6.15.11, DS18, DS19). The build and the smoke test themselves run in .github/workflows/container.yml.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");
// Dockerfile with line continuations joined and comments dropped, one instruction per entry.
const instructions = (src: string): string[] =>
  src.replace(/\\\r?\n/g, " ").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");
  const lines = instructions(dockerfile);
  const froms = lines.filter((l) => /^FROM\s/i.test(l));

  it("has the three stages and pins every external base image by digest", () => {
    assert.equal(froms.length, 3, froms.join("\n"));
    for (const f of froms) {
      const ref = f.split(/\s+/)[1] ?? "";
      assert.match(ref, /@sha256:[0-9a-f]{64}$/, `unpinned base image: ${f}`);
    }
  });

  it("runs as the non-root user 10001:10001", () => {
    const users = lines.filter((l) => /^USER\s/i.test(l));
    assert.equal(users.at(-1), "USER 10001:10001");
  });

  it("marks container mode and keeps state under /var/lib/plur1bus", () => {
    assert.match(dockerfile, /PLUR1BUS_CONTAINER=1/);
    assert.match(dockerfile, /PLUR1BUS_HOME=\/var\/lib\/plur1bus/);
    assert.match(dockerfile, /VOLUME\s+\[?"?\/var\/lib\/plur1bus/);
  });

  it("has a HEALTHCHECK that is not the shell form of a bare exit", () => {
    const hc = lines.find((l) => /^HEALTHCHECK\s/i.test(l));
    assert.ok(hc, "no HEALTHCHECK");
    assert.match(hc, /healthcheck\.mjs/);
  });

  it("puts no secret in an ARG, ENV or COPY, and reads the engine token only from a build secret mount", () => {
    for (const l of lines.filter((x) => /^(ARG|ENV|COPY|ADD)\s/i.test(x))) {
      assert.doesNotMatch(l, /token|secret|password|passwd|credential|\.npmrc|\.netrc|id_rsa|\.pem|\.env\b/i, l);
    }
    assert.match(dockerfile, /--mount=type=secret,id=engine_token,required=false/);
    // never echo the token
    assert.doesNotMatch(dockerfile, /echo[^\n]*engine_token/);
  });

  it("builds the Rust binary locked and installs Node dependencies from the frozen lockfile", () => {
    assert.match(dockerfile, /cargo build --release --locked -p plur1bus/);
    assert.match(dockerfile, /pnpm install --frozen-lockfile/);
  });

  it("normalizes the Rust binary timestamp to SOURCE_DATE_EPOCH", () => {
    assert.match(dockerfile, /ARG SOURCE_DATE_EPOCH=0/);
    assert.match(dockerfile, /touch -m -d "@\$\{SOURCE_DATE_EPOCH\}" \/out\/plur1bus/);
  });

  it("has a clean entrypoint", () => {
    const ep = lines.find((l) => /^ENTRYPOINT\s/i.test(l));
    assert.ok(ep);
    assert.match(ep, /^ENTRYPOINT \[".*plur1bus".*"supervise"\]$/);
  });
});

describe(".dockerignore", () => {
  const ignore = read(".dockerignore").split(/\r?\n/).map((l) => l.trim());
  it("keeps VCS data, build output, dependencies and secret-looking files out of the context", () => {
    for (const must of [".git", "target", "**/node_modules", "**/dist", ".env", "**/*.pem", "**/.npmrc", "**/.netrc"]) {
      assert.ok(ignore.includes(must), `.dockerignore lacks ${must}`);
    }
  });
  it("keeps the tracked root .npmrc (the frozen install needs auto-install-peers=false)", () => {
    assert.ok(ignore.includes("!/.npmrc"));
    assert.ok(ignore.indexOf("!/.npmrc") > ignore.indexOf("**/.npmrc"));
  });
});

describe("deploy/compose.yaml", () => {
  const compose = read("deploy/compose.yaml");
  it("hardens the harness service (spec §6.15.11)", () => {
    for (const re of [
      /^\s+read_only:\s*true/m,
      /^\s+restart:\s*unless-stopped/m,
      /^\s+stop_grace_period:\s*150s/m,
      /^\s+user:\s*"10001:10001"/m,
      /^\s+init:\s*true/m,
      /no-new-privileges:true/,
      /cap_drop:\s*\n\s+- ALL/,
      /^\s+healthcheck:/m,
      /plur1bus-state:\/var\/lib\/plur1bus/,
      /plur1bus-models:\/var\/lib\/plur1bus\/models/,
    ]) {
      assert.match(compose, re);
    }
  });
  it("grants nothing it must not: no privileged, host network, runtime socket or published port", () => {
    assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*"?host|docker\.sock|\bcap_add:|^\s+ports:/m);
  });
  it("references the image by a digest-able variable, never :latest", () => {
    assert.doesNotMatch(compose, /:latest/);
    assert.match(compose, /image:\s*\$\{PLUR1BUS_IMAGE:-/);
  });
});
