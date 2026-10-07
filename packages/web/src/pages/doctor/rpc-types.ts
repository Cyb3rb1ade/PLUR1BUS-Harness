// RPC methods the Doctor page calls, merged into the client's method map (docs/rpc.md `core.status`, stable since 1.0.0).
// ASSUMED on /rpc: origin/main serves no /rpc yet, so the client reports `unavailable` and the page says so for this part.
// The result is declared `unknown` on purpose: model.ts `parseCoreStatus` is the one place that reads it, defensively.
export {};

declare module "../../api/index.ts" {
  interface RpcMethods {
    "core.status": { params: undefined; result: unknown };
  }
}
