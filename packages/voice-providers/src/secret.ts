// Secret lookup through the injected getSecret only. A missing or malformed value is `auth` before any network call;
// the lookup's own error text is dropped because it may contain the secret.
import { VoiceProviderError } from "./errors.ts";
import type { GetSecret } from "./types.ts";

export async function resolveSecret(getSecret: GetSecret, ref: string | undefined, provider: string): Promise<string> {
  if (ref === undefined || ref === "") throw new VoiceProviderError("auth", `${provider}: no API key reference configured`, { provider });
  let value: string | undefined;
  try {
    value = await getSecret(ref);
  } catch {
    throw new VoiceProviderError("auth", `${provider}: could not resolve secret "${ref}"`, { provider });
  }
  if (typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/.test(value)) throw new VoiceProviderError("auth", `${provider}: secret "${ref}" is not available`, { provider });
  return value;
}
