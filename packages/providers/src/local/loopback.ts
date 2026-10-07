// Loopback-only guard for local model endpoints. Fail closed: anything that is not clearly loopback is refused.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // RULING: `localhost` is accepted by name (RFC 6761 reserves it for loopback); no other name is.
  if (h === "localhost") return true;
  if (h === "::1") return true;
  const m = IPV4.exec(h);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) && o[0] === 127;
}

export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname);
}
