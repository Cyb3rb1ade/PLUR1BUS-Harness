/** SSH has its own Owner-configured endpoint allowance; HTTPS egress policy remains independent. */
import { resolveGuarded, makeAddressPolicy, systemResolver, type Resolver } from "../tools/web/guard.ts";
import { RpcError } from "../rpc/errors.ts";

const PRIVATE_SSH = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fc00::/7", "::1/128"];

/** Every DNS answer must pass, then the helper receives just one vetted numeric address and the configured port. */
export async function resolveSshEndpoint(host: string, port: number, allowPrivate: boolean,
  resolver: Resolver = systemResolver): Promise<{ ip: string; port: number }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const address = await Promise.race([
      resolveGuarded(host, resolver, makeAddressPolicy(allowPrivate ? PRIVATE_SSH : [])),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSH DNS deadline")), 5000); }),
    ]);
    return { ip: address.address, port };
  } catch {
    throw new RpcError("E_DENIED", "SSH destination is unavailable under this connection's egress policy", {
      reason: "ssh-egress-denied",
    });
  } finally { clearTimeout(timer); }
}
