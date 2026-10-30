// The shell receives only public device-approval metadata. Rust owns private challenges and proofs.
import type { StepUpPublic, StepUpPurpose } from "../ipc.ts";
type Connection = { id: string; origin: string };
type Handle = { connectionId: string; handle: string };
function read(raw: unknown, connection: Connection, purpose: StepUpPurpose, now: number): StepUpPublic {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
  const value = raw as Record<string, unknown>;
  const keys = ["handle", "userCode", "verificationUri", "purpose", "expiresAt", "state"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || typeof value.handle !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.handle)
    || typeof value.userCode !== "string" || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.userCode)
    || value.verificationUri !== `${connection.origin}/#/desktop/approve` || value.purpose !== purpose
    || !Number.isSafeInteger(value.expiresAt) || value.state !== "expired" && (value.expiresAt as number) <= now || (value.expiresAt as number) > now + 300_000
    || !["pending", "approved", "declined", "expired"].includes(String(value.state))) throw new Error("invalid");
  return value as unknown as StepUpPublic;
}
export function createStepUp(connection: Connection, purpose: StepUpPurpose, now = Date.now) {
  let value: StepUpPublic | null = null, busy = false, error = false, generation = 0;
  let retryAfter: number | null = null;
  const request = (): Handle => ({ connectionId: connection.id, handle: value!.handle });
  async function update(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    const own = ++generation; busy = true; error = false; retryAfter = null;
    try {
      const response = await action();
      if (own !== generation) return false;
      value = read(response, connection, purpose, now()); return true;
    } catch (failure) {
      if (own === generation) {
        error = true;
        const match = typeof failure === "string" ? /^rate-limited:([1-9]|[1-5][0-9]|60)$/.exec(failure) : null;
        retryAfter = match ? Number(match[1]) : null;
      }
      return false;
    }
    finally { if (own === generation) busy = false; }
  }
  return {
    get value() { return value; }, get busy() { return busy; }, get error() { return error; }, get purpose() { return purpose; },
    get retryAfter() { return retryAfter; },
    begin(send: (request: {connectionId: string; purpose: StepUpPurpose}) => Promise<unknown>) {
      return update(() => send({connectionId: connection.id, purpose}));
    },
    async poll(send: (request: Handle) => Promise<unknown>): Promise<boolean> {
      if (!value) return false;
      if (value.expiresAt <= now()) { value = {...value, state: "expired"}; return false; }
      const input = request(); return update(() => send(input));
    },
    async open(send: (request: Handle) => Promise<unknown>): Promise<boolean> {
      if (!value || value.expiresAt <= now()) return false;
      try { await send(request()); return true; } catch { error = true; return false; }
    },
    async cancel(send: (request: Handle) => Promise<unknown>): Promise<void> {
      const input = value ? request() : null;
      generation++; value = null; busy = false; error = false;
      if (input) try { await send(input); } catch { error = true; }
    },
  };
}
