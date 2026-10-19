// Research-only OpenSSH fixture. No personal agent, key, keychain or ssh config.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

if (process.platform === "win32") throw new Error("S0 Unix fixture; Windows named-pipe acceptance remains open");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "p1t-rsa-agent-"));
const children = [];
const socket = join(dir, "agent.sock");
const env = { ...process.env, SSH_AUTH_SOCK: socket, SSH_ASKPASS_REQUIRE: "never" };
delete env.SSH_AGENT_PID;
delete env.SSH_ASKPASS;
delete env.DISPLAY;

function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...options });
  } catch (error) {
    throw new Error(`${file} fixture command failed: ${String(error.stderr ?? "").slice(-8192)}`);
  }
}

function startReady(file, args, marker) {
  const child = spawn(file, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((accept, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("OpenSSH fixture readiness timeout")), 10_000);
    const onData = data => {
      output = (output + data.toString("utf8")).slice(-8192);
      if (output.includes(marker)) finish();
    };
    const onExit = () => finish(new Error("OpenSSH fixture exited before readiness"));
    const onError = () => finish(new Error("OpenSSH fixture could not start"));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", onData); child.stderr.off("data", onData);
      child.off("exit", onExit); child.off("error", onError);
      if (error) reject(error); else accept(child);
    }
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.once("exit", onExit); child.once("error", onError);
  });
}

try {
  // Build before allocating test services, so compilation cannot exhaust their deadlines.
  run("cargo", ["build", "--offline", "--locked", "--manifest-path", "apps/desktop/Cargo.toml", "-p", "plur1bus-ssh-spike", "--example", "rsa_agent"], { timeout: 300_000 });
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host")]);
  // Only external OpenSSH processes see this test-generated RSA private key.
  run("ssh-keygen", ["-q", "-t", "rsa", "-b", "3072", "-N", "", "-f", join(dir, "identity")]);
  await writeFile(join(dir, "authorized_keys"), await readFile(join(dir, "identity.pub")), { mode: 0o600 });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const config = [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(dir, "host")}`,
    `PidFile ${join(dir, "sshd.pid")}`, `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
    `AllowUsers ${userInfo().username}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey", "PubkeyAcceptedAlgorithms rsa-sha2-256,rsa-sha2-512",
    "UsePAM no", "StrictModes yes", "LogLevel VERBOSE", "AllowAgentForwarding no",
    "AllowTcpForwarding no", "X11Forwarding no", "PermitTunnel no", "PermitUserRC no",
  ].join("\n") + "\n";
  await writeFile(join(dir, "sshd_config"), config, { mode: 0o600 });
  await startReady("/usr/sbin/sshd", ["-D", "-e", "-f", join(dir, "sshd_config")], "Server listening on 127.0.0.1");
  await startReady("ssh-agent", ["-D", "-a", socket], "SSH_AUTH_SOCK=");
  run("ssh-add", [join(dir, "identity")]);
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "apps/desktop/target");
  const output = run(join(target, "debug/examples/rsa_agent"), [String(port), userInfo().username,
    join(dir, "host.pub"), join(dir, "identity.pub"), socket]);
  process.stdout.write(output);
  console.log("PASS: isolated OpenSSH RSA agent, SHA-256 + SHA-512, no private key input to Rust");
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await ended; } finally { clearTimeout(timer); }
    }
  }
  await rm(dir, { recursive: true, force: true });
}
