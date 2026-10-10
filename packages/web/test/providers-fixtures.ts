// Shared mock setup for the Settings > Providers tests.
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export type AuthCredential = {
  id: string;
  person: string;
  workspace: string;
  kind: "oauth_pkce";
  billingPath: "plan";
  expiresAt: number | null;
  needsLogin: boolean;
  provider?: string;
};

export const sampleCredential = (over: Partial<AuthCredential> = {}): AuthCredential => ({
  id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  person: "owner",
  workspace: "ws_default",
  kind: "oauth_pkce",
  billingPath: "plan",
  expiresAt: 1799999999000,
  needsLogin: false,
  provider: "openai",
  ...over,
});

export type ProvidersFixtureState = {
  credentials: AuthCredential[];
  pendingLogins: number;
  lastAttemptId: string | null;
  awaitHandler?: (attemptId: string) => AuthCredential | Promise<AuthCredential>;
};

export function seedProviders(
  rpc: MockRpc,
  initial: AuthCredential[] = [sampleCredential()],
): ProvidersFixtureState {
  const state: ProvidersFixtureState = {
    credentials: [...initial],
    pendingLogins: 0,
    lastAttemptId: null,
  };

  rpc.handle(
    "auth.credentials.list",
    () => ({ credentials: state.credentials }),
    { write: false },
  );

  rpc.handle(
    "auth.status",
    () => ({
      credentials: state.credentials,
      pendingLogins: state.pendingLogins,
    }),
    { write: false },
  );

  rpc.handle("auth.login.start", (p) => {
    state.pendingLogins += 1;
    const attemptId = `att-${Date.now()}`;
    state.lastAttemptId = attemptId;
    return {
      attemptId,
      authorizeUrl: "https://auth.openai.com/oauth/authorize?test=1",
      callbackPort: 49152,
    };
  });

  rpc.handle("auth.login.await", async (p) => {
    const { attemptId } = p as { attemptId: string };
    if (state.awaitHandler) {
      const cred = await state.awaitHandler(attemptId);
      state.credentials.push(cred);
      if (state.pendingLogins > 0) state.pendingLogins -= 1;
      return cred;
    }
    const cred = sampleCredential({ id: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210", workspace: "ws_new" });
    state.credentials.push(cred);
    if (state.pendingLogins > 0) state.pendingLogins -= 1;
    return cred;
  });

  rpc.handle("auth.login.cancel", (p) => {
    if (state.pendingLogins > 0) state.pendingLogins -= 1;
    return { cancelled: true };
  });

  rpc.handle("auth.logout", (p) => {
    const { id } = p as { id: string };
    const idx = state.credentials.findIndex((c) => c.id === id);
    if (idx < 0) throw rpcError("E_NOT_FOUND", "credential not found");
    state.credentials.splice(idx, 1);
    return { id, loggedOut: true };
  });

  // Optional callback endpoint
  rpc.handle("auth.login.callback", (p) => {
    return { ok: true };
  });

  // Seed secret.list and secret.set for API-Key flow
  const secrets: { name: string; backend: string; createdAt: string; updatedAt: string }[] = [];
  rpc.handle("secret.list", () => ({ secrets }), { write: false });
  rpc.handle("secret.set", (p) => {
    const { name } = p as { name: string; value: string };
    secrets.push({ name, backend: "keyring", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return { name, backend: "keyring" };
  });

  return state;
}
