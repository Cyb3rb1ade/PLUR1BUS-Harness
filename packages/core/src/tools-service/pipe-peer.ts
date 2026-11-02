/** Windows peer lookup on the connected pipe itself. Node's stdio inheritance duplicates the existing kernel
 * handle into the native CLI; the helper only calls GetNamedPipeServerProcessId and never consumes RPC bytes. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Socket } from "node:net";
import { helperPinned } from "../attestation/helper.ts";
import { toolsEnvironment } from "./environment.ts";

/** Returns no PID on an unavailable helper, bad output, a disconnected socket or a timeout. No credentials cross
 * this process boundary. The caller must compare this OS result before authenticating. */
export async function toolsPipeServerPid(socket: Socket, nativeBinary = process.env.PLUR1BUS_NATIVE_BIN): Promise<number | undefined> {
  if (process.platform !== "win32" || socket.destroyed) return undefined;
  const binary = nativeBinary;
  if (!binary || !isAbsolute(binary) || !helperPinned(binary)) return undefined;
  return new Promise((resolve) => {
    let output = "";
    let failed = false;
    const child = spawn(binary, ["core", "__pipe-server-pid"], {
      stdio: [socket, "pipe", "ignore"], windowsHide: true, env: toolsEnvironment(process.env),
    });
    const kill = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(kill, 1000);
    socket.once("close", kill);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 32) kill();
    });
    child.once("error", () => { failed = true; });
    // Resolve after close so the child is always reaped before any token or key is sent.
    child.once("close", (code) => {
      clearTimeout(timer);
      socket.off("close", kill);
      const pid = /^\d+\r?\n?$/.test(output) ? Number(output.trim()) : NaN;
      resolve(!failed && !socket.destroyed && code === 0 && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff ? pid : undefined);
    });
  });
}
