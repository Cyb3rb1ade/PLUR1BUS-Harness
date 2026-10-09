import { canOpenGraphicalBrowser, type EnvSnapshot } from "./env.ts";
import { deviceUrl, type AuthProfile } from "./profile.ts";

export type LoginMethod =
  | "enter_key"        // api_key: the person pastes a key (or a user-obtained token)
  | "federated_token" // configured external supplier, no interactive flow
  | "adc"              // adc: discover the ambient Google credential, nothing to log in to
  | "delegated_cli"    // external_cli: the person runs the vendor's own login, then attaches
  | "device_code"
  | "loopback_pkce"    // browser on this machine
  | "loopback_ssh"     // loopback PKCE with an `ssh -L` hint: the browser is on the person's own machine
  | "paste_callback";  // print the URL, paste the full callback URL back

export interface LoginPlan {
  /** The method the CLI starts with, and tells the person it used. */
  method: LoginMethod;
  /** Methods to fall back to, in order, if `method` fails or is refused. */
  fallbacks: LoginMethod[];
  /** Shown with `loopback_ssh`. `port` is the profile's fixed loopback port, or the one the flow bound. */
  sshHint?: (port: number) => string;
  headless: boolean;
}

export interface PlanOptions { pasteCallback?: boolean | undefined }

/** The headless ladder. RULING (ADR-005 Q "decided per environment probe"): the ladder device code, then loopback
 *  with `ssh -L`, then paste-callback applies when no graphical browser is reachable. With a local browser the
 *  profile's loopback flow is preferred over device code (fewer steps), and device code stays the first fallback.
 *  `--paste-callback` (opts.pasteCallback) always wins for flows that have a callback. */
export function planLogin(profile: AuthProfile, snap: EnvSnapshot, opts: PlanOptions = {}): LoginPlan {
  const graphical = canOpenGraphicalBrowser(snap);
  const headless = !graphical; // a remote session never counts as graphical (see env.ts)
  const hint = (port: number) => `ssh -L ${port}:127.0.0.1:${port} <this-host>`;
  switch (profile.kind) {
    case "api_key": return { method: "enter_key", fallbacks: [], headless };
    case "federated_token": return { method: "federated_token", fallbacks: [], headless };
    case "adc": return { method: "adc", fallbacks: [], headless };
    case "external_cli": return { method: "delegated_cli", fallbacks: [], headless };
    case "device_code": return { method: "device_code", fallbacks: [], headless };
    case "oauth_pkce": {
      const hasDevice = Boolean(deviceUrl(profile));
      if (opts.pasteCallback) return { method: "paste_callback", fallbacks: [], headless };
      if (!headless) return { method: "loopback_pkce", fallbacks: [...(hasDevice ? ["device_code" as const] : []), "paste_callback"], headless };
      if (hasDevice) return { method: "device_code", fallbacks: ["loopback_ssh", "paste_callback"], sshHint: hint, headless };
      return { method: "loopback_ssh", fallbacks: ["paste_callback"], sshHint: hint, headless };
    }
  }
}
