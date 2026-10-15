import { initSession } from "./session.ts";
const unpack = (s: string): ArrayBuffer => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)).buffer;
const pack = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error("Passkey request failed"); return await res.json() as Record<string, unknown>;
}
export async function passkeyLogin(username: string, passwordChallenge?: string): Promise<void> {
  const opts = await request("/session/passkey/options", { username, ...(passwordChallenge ? { challenge: passwordChallenge } : {}) });
  const credential = await navigator.credentials.get({ publicKey: { ...opts, challenge: unpack(opts.challenge as string) } as PublicKeyCredentialRequestOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey cancelled"); const r = credential.response as AuthenticatorAssertionResponse;
  await request("/session/passkey", { challenge: opts.challenge, id: credential.id, clientDataJSON: pack(r.clientDataJSON), authenticatorData: pack(r.authenticatorData), signature: pack(r.signature) }); await initSession();
}
export async function enrollPasskey(api: { post<T = unknown>(path: string, body?: unknown): Promise<T> }, name: string): Promise<void> {
  const opts = await api.post<Record<string, unknown>>("/api/v1/me/passkeys/options", {});
  const credential = await navigator.credentials.create({ publicKey: { ...opts, challenge: unpack(opts.challenge as string), user: { ...opts.user as object, id: unpack((opts.user as { id: string }).id) }, excludeCredentials: (opts.excludeCredentials as { id: string; type: "public-key" }[]).map(c => ({ ...c, id: unpack(c.id) })) } as PublicKeyCredentialCreationOptions }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey cancelled"); const r = credential.response as AuthenticatorAttestationResponse;
  await api.post("/api/v1/me/passkeys/register", { challenge: opts.challenge, name, id: credential.id, clientDataJSON: pack(r.clientDataJSON), attestationObject: pack(r.attestationObject) }); await initSession();
}
