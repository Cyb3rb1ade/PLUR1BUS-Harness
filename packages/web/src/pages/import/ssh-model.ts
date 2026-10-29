/** Owner SSH setup validates visible metadata and binds central egress consent to its exact displayed revision. */
import type { ConfigSetParams, SshConnectionInput, SshConnection } from "../../../../rpc-schema/generated/types.ts";

export interface SshForm {
  id: string;
  host: string;
  port: string;
  user: string;
  roots: string;
  allowPrivate: boolean;
}
export interface SshEgressSnapshot {
  revision: string;
  value: { allowHosts: string[]; allowPorts: number[]; allowLoopback?: boolean };
}
function host(value: string): string {
  const raw = value.trim().replace(/\.$/, "");
  if (!raw || raw.length > 253 || /[\s*\\/@?#\x00-\x1f\x7f]/.test(raw)) throw new Error("ssh-host");
  const authority = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  const url = new URL(`https://${authority}/`);
  if (url.port || url.username || url.password) throw new Error("ssh-host");
  const name = url.hostname.toLowerCase();
  if (name.startsWith("[")) return name.slice(1, -1);
  if (/^[0-9.]+$/.test(name)) {
    if (name !== raw) throw new Error("ssh-address");
  } else if (!name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new Error("ssh-host");
  return name;
}
/** Produces only the generated connection input; remote roots are absolute normalized SFTP paths, never shell commands. */
export function sshConnectionInput(form: SshForm): SshConnectionInput {
  const port = Number(form.port),
    roots = form.roots
      .split(/\r?\n/)
      .map((root) => root.trim())
      .filter(Boolean);
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(form.id) ||
    !/^\d+$/.test(form.port) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !form.user ||
    form.user.length > 128 ||
    /[\x00-\x1f\x7f]/.test(form.user) ||
    !roots.length ||
    roots.length > 32 ||
    new Set(roots).size !== roots.length ||
    roots.some(
      (root) =>
        root.length > 4096 ||
        !root.startsWith("/") ||
        /[\x00-\x1f\x7f\\]/.test(root) ||
        (root !== "/" && root.endsWith("/")) ||
        root.includes("//") ||
        root.split("/").some((part) => part === "." || part === ".."),
    )
  )
    throw new Error("ssh-connection");
  return {
    id: form.id,
    host: host(form.host),
    port,
    user: form.user,
    roots: roots as [string, ...string[]],
    allowPrivate: form.allowPrivate,
  };
}
function checked(snapshot: SshEgressSnapshot): void {
  if (
    !snapshot ||
    typeof snapshot.revision !== "string" ||
    !snapshot.revision ||
    !snapshot.value ||
    !Array.isArray(snapshot.value.allowHosts) ||
    snapshot.value.allowHosts.some((entry) => typeof entry !== "string") ||
    !Array.isArray(snapshot.value.allowPorts) ||
    snapshot.value.allowPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("ssh-egress-policy");
}
/** Includes both complete existing lists: a changed global policy requires another visible approval. */
export function egressConsentSubject(snapshot: SshEgressSnapshot, connection: SshConnectionInput): string {
  checked(snapshot);
  return JSON.stringify([
    snapshot.revision,
    connection.host,
    connection.port ?? 22,
    snapshot.value.allowHosts,
    snapshot.value.allowPorts,
  ]);
}
/** Adds exact entries without wildcard insertion or changing loopback policy; native config revision protects concurrent writes. */
export function sshEgressApproval(
  snapshot: SshEgressSnapshot,
  connection: SshConnectionInput,
  subject: string,
): ConfigSetParams {
  if (subject !== egressConsentSubject(snapshot, connection)) throw new Error("ssh-egress-consent");
  const exact = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  return {
    ifRevision: snapshot.revision,
    changes: [
      { key: "egress.allowHosts", value: [...new Set([...snapshot.value.allowHosts, exact])] },
      { key: "egress.allowPorts", value: [...new Set([...snapshot.value.allowPorts, connection.port ?? 22])] },
    ],
  };
}

/** A fresh probe may be displayed only for the exact connection metadata that the Owner saw. */
export function sameSshConnection(saved: SshConnection, current: SshConnection | undefined): boolean {
  const identity = (connection: SshConnection): string =>
    JSON.stringify([
      connection.id,
      connection.host,
      connection.port,
      connection.user,
      connection.roots,
      connection.allowPrivate,
      connection.hostKey?.sha256,
      connection.hostKey?.algorithm,
    ]);
  return current !== undefined && identity(saved) === identity(current);
}

/** Only the server's closed container metadata may supply the initial proposal; consent still starts empty. */
export function initialSshForm(
  suggestion: import("../../../../api/src/import-routes.ts").ImportSourcesResult["sshHostSuggestion"],
): SshForm {
  return {
    id: "",
    host: suggestion?.reason === "container-host" && suggestion.host === "host.docker.internal" ? suggestion.host : "",
    port: "22",
    user: "",
    roots: "",
    allowPrivate: false,
  };
}
