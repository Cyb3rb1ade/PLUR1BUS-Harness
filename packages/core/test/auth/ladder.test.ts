import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planLogin } from "../../src/auth/ladder.ts";
import { canOpenGraphicalBrowser, isRemoteSession, type EnvSnapshot } from "../../src/auth/env.ts";
import { validateProfile } from "../../src/auth/profile.ts";

const common = { display_name: "E", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" };
const P = {
  key: validateProfile({ ...common, id: "e:key", kind: "api_key" }),
  adc: validateProfile({ ...common, id: "e:adc", kind: "adc" }),
  cli: validateProfile({ ...common, id: "e:cli", kind: "external_cli" }),
  pkce: validateProfile({ ...common, id: "e:pkce", kind: "oauth_pkce", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t" }),
  pkceDev: validateProfile({ ...common, id: "e:pd", kind: "oauth_pkce", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t", device_authorization_endpoint: "https://e.test/d" }),
  dev: validateProfile({ ...common, id: "e:dev", kind: "device_code", device_authorization_endpoint: "https://e.test/d", token_endpoint: "https://e.test/t" }),
};
const env = (e: Record<string, string>, platform: NodeJS.Platform = "linux", tty = true): EnvSnapshot => ({ env: e, platform, stdoutIsTTY: tty });
const E = {
  desktopLinux: env({ DISPLAY: ":0" }),
  mac: env({}, "darwin"),
  ssh: env({ SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }), // X forwarding must not make it "local"
  bareLinux: env({}),
  ci: env({}, "linux", false),
  wayland: env({ WAYLAND_DISPLAY: "wayland-0" }),
  codespace: env({ CODESPACES: "true" }),
};

describe("environment predicates", () => {
  it("table", () => {
    const rows: Array<[string, EnvSnapshot, boolean, boolean]> = [
      ["desktop linux", E.desktopLinux, true, false], ["mac", E.mac, true, false], ["ssh with X", E.ssh, false, true],
      ["bare linux", E.bareLinux, false, false], ["wayland", E.wayland, true, false], ["codespaces", E.codespace, false, true],
    ];
    for (const [n, s, gui, remote] of rows) { assert.equal(canOpenGraphicalBrowser(s), gui, n + " gui"); assert.equal(isRemoteSession(s), remote, n + " remote"); }
  });
});

describe("headless ladder (M2 acceptance 1)", () => {
  type Row = [string, keyof typeof P, EnvSnapshot, { paste?: boolean }, string, string[]];
  const rows: Row[] = [
    ["api key anywhere", "key", E.ssh, {}, "enter_key", []],
    ["adc", "adc", E.ci, {}, "adc", []],
    ["external cli attaches", "cli", E.ssh, {}, "delegated_cli", []],
    ["device-code profile, headless", "dev", E.ssh, {}, "device_code", []],
    ["pkce local desktop", "pkce", E.desktopLinux, {}, "loopback_pkce", ["paste_callback"]],
    ["pkce + device endpoint local desktop", "pkceDev", E.mac, {}, "loopback_pkce", ["device_code", "paste_callback"]],
    ["pkce over ssh, no device code", "pkce", E.ssh, {}, "loopback_ssh", ["paste_callback"]],
    ["pkce over ssh, device code documented", "pkceDev", E.ssh, {}, "device_code", ["loopback_ssh", "paste_callback"]],
    ["pkce no display", "pkce", E.bareLinux, {}, "loopback_ssh", ["paste_callback"]],
    ["pkce in CI (no tty)", "pkce", E.ci, {}, "loopback_ssh", ["paste_callback"]],
    ["pkce codespaces", "pkceDev", E.codespace, {}, "device_code", ["loopback_ssh", "paste_callback"]],
    ["--paste-callback beats everything", "pkceDev", E.mac, { paste: true }, "paste_callback", []],
    ["--paste-callback over ssh", "pkce", E.ssh, { paste: true }, "paste_callback", []],
  ];
  for (const [name, p, e, o, method, fb] of rows) it(name, () => {
    const plan = planLogin(P[p], e, { pasteCallback: o.paste });
    assert.equal(plan.method, method); assert.deepEqual(plan.fallbacks, fb);
  });
  it("loopback_ssh carries the ssh -L hint with the bound port", () => {
    const plan = planLogin(P.pkce, E.ssh);
    assert.match(plan.sshHint!(47123), /^ssh -L 47123:localhost:47123 /);
    assert.equal(plan.headless, true);
  });
});
