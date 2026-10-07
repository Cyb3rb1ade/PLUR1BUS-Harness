// Secret lookup through the injected getSecret only. A missing, empty or malformed value is `auth` and happens before
// any network call; the lookup's own error text is dropped because it may contain the secret.
import { AdapterError } from "./errors.ts";
import type { GetSecret } from "./types.ts";

export async function resolveSecret(getSecret: GetSecret, name: string | undefined, provider: string): Promise<string | undefined> {
  if (name === undefined) return undefined;
  let value: string | undefined;
  try {
    value = await getSecret(name);
  } catch {
    throw new AdapterError("auth", `could not resolve secret "${name}"`, { provider });
  }
  if (typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdapterError("auth", `secret "${name}" is not available`, { provider });
  }
  return value;
}
