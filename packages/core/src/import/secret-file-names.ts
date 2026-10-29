// File names that carry credentials by convention. Pure and dependency-free: the importer, the skill scan and the
// skill tools (a running core) all share it, and none of them has to load the importer's SQLite/LanceDB code for it.

const SECRET_NAMES = new Set([".env", "auth.json", "credentials.json", ".netrc", ".npmrc", ".pypirc"]);

/** File names a skill copy never carries and a report never reads (credentials by convention). */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || n.startsWith(".env.") || n.endsWith(".pem") || n.endsWith(".key") || n.startsWith("id_rsa") || n.startsWith("id_ed25519") || n.startsWith("id_ecdsa");
}
