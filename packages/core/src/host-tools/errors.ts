export const HOST_FAILURE_CODES = [
  "not_supported_on_platform",
  "not_found",
  "permission_denied",
  "timeout",
  "aborted",
  "denied_by_denylist",
  "invalid_input",
  "too_large",
] as const;

export type HostFailureCode = (typeof HOST_FAILURE_CODES)[number];

export class HostFailure extends Error {
  readonly code: HostFailureCode;
  constructor(code: HostFailureCode, message: string) {
    super(message);
    this.name = "HostFailure";
    this.code = code;
  }
  toResult(): { isError: true; error: { code: HostFailureCode; message: string } } {
    return { isError: true, error: { code: this.code, message: this.message } };
  }
}

export function throwInvalid(message: string): never {
  throw new HostFailure("invalid_input", message);
}

export function requireInt(v: unknown, name: string, min = 1, max = 2_147_483_647): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throwInvalid(`${name} must be an integer ${min}..${max}`);
  }
  return v;
}

export function requireString(v: unknown, name: string, min = 1, max = 4096): string {
  if (typeof v !== "string" || v.includes("\0") || v.length < min || v.length > max) {
    throwInvalid(`${name} must be a string of ${min}..${max} characters`);
  }
  return v;
}
