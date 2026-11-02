/** Frozen pre-SH name heuristic: a test oracle for omissions, never a runtime sensitivity policy. */
const SENSITIVE = new RegExp(
  "key|token|secret|passw|pwd|passphrase|credential|authori[sz]ation|bearer|cookie|private" +
    "|signature|jwt|hmac|(^|[._-])auth$",
  "i",
);
const MORE_SECRET =
  /authori[sz]ation|bearer|cookie|passphrase|passwd|pwd|private|signature|jwt|hmac|(^|[._-])auth($|[._-])/i;
/** Pre-SH heuristic, deliberately independent of the runtime metadata lookup. */
export const legacySecretKey = (key: string): boolean => SENSITIVE.test(key) || MORE_SECRET.test(key);

/** The configuration-member subset inspected by the independent coverage oracle. */
export interface SchemaNode {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  format?: string;
  description?: string;
  properties?: Readonly<Record<string, SchemaNode>>;
  additionalProperties?: boolean | SchemaNode;
  items?: boolean | SchemaNode;
  "x-value-schema"?: SchemaNode;
  "x-sensitive"?: boolean;
  "x-url-credentials"?: boolean;
}
/** A declared member with inherited policy flags, using map and array wildcards in its key. */
export interface ConfigNode {
  key: string;
  node: SchemaNode;
  sensitive: boolean;
  urlCredentials: boolean;
}

/** Only configuration members, map values and array items; conditional validation fragments are not separate fields. */
export function configNodes(schema: SchemaNode): ConfigNode[] {
  const result: ConfigNode[] = [];
  function visit(node: SchemaNode, key: string, sensitive = false, urlCredentials = false): void {
    if (node["x-value-schema"])
      node = {
        ...node,
        ...node["x-value-schema"],
        properties: { ...node.properties, ...node["x-value-schema"].properties },
      };
    sensitive ||= node["x-sensitive"] === true;
    urlCredentials ||= node["x-url-credentials"] === true;
    if (key) result.push({ key, node, sensitive, urlCredentials });
    for (const [name, child] of Object.entries<SchemaNode>(node.properties ?? {}))
      visit(child, key ? `${key}.${name}` : name, sensitive, urlCredentials);
    if (node.additionalProperties && typeof node.additionalProperties === "object")
      visit(node.additionalProperties, `${key}.*`, sensitive, urlCredentials);
    if (node.items && typeof node.items === "object") visit(node.items, `${key}[]`, sensitive, urlCredentials);
  }
  visit(schema, "");
  return result;
}

/** Public heuristic matches require an exact key and a maintained justification. */
export const PUBLIC_EXCEPTIONS: Readonly<Record<string, string>> = {
  "import.ssh.connections.*.allowPrivate":
    "Boolean consent for private destination addresses, not private key material.",
  "import.ssh.connections.*.hostKey": "Public SSH host-key metadata; no private material.",
  "import.ssh.connections.*.hostKey.sha256": "Public host-key fingerprint.",
  "import.ssh.connections.*.hostKey.algorithm": "Public host-key algorithm.",
  "agents.*.memoryExposure.collab.recall.agentPrivate": "Boolean memory-scope permission.",
  "agents.*.memoryExposure.mcp.recall.agentPrivate": "Boolean memory-scope permission.",
  "agents.*.memoryExposure.a2a.recall.agentPrivate": "Boolean memory-scope permission.",
  "a2a.peers[].keySha256": "One-way peer-token fingerprint, not the bearer token.",
  "a2aServer.signingKey": "Mixed signing configuration; privateKeySecret is marked separately and kid is public.",
  "a2aServer.signingKey.kid": "Public signing-key identifier.",
  auth: "Mixed authentication policy container; secret-bearing descendants are marked separately.",
  "auth.requireSecondFactor": "Public second-factor policy enum.",
  "auth.openai": "Mixed provider policy container; secret-bearing descendants are marked separately.",
  "auth.openai.loopbackTimeoutMs": "Numeric login deadline.",
  "auth.openai.httpTimeoutMs": "Numeric HTTP deadline.",
  "auth.openai.refreshSkewSeconds": "Numeric refresh timing.",
  "auth.openai.liveHandleTtlSeconds": "Numeric handle lifetime.",
  "auth.openai.voiceDailySeconds": "Numeric daily voice limit.",
  "auth.openai.voiceCapacity": "Numeric voice concurrency limit.",
  "auth.openai.clientRegistration": "Public registration policy enum.",
  "auth.openai.storeBackend": "Public storage-backend selector, never a credential.",
  "auth.openai.federated":
    "Mixed supplier configuration; file, arguments and environment carry sensitivity separately.",
  "auth.openai.federated.command": "Executable path only; supplied arguments and environment are separate.",
  "auth.openai.federated.args": "Array container; each string item is marked sensitive.",
  "modelProfiles.*.params.maxTokens": "Numeric output-token limit.",
  "collaboration.limits.workTokens": "Numeric work-token budget, not authentication token material.",
  "a2aClient.peerTokens": "Numeric per-peer communication budget, not a peer bearer credential.",
  "a2aClient.turnTokens": "Numeric per-turn communication budget, not an authentication token.",
  secrets: "Secret-store policy container; it contains no stored secret values.",
  "secrets.fileFallback": "File-store policy container, not credential material.",
  "secrets.fileFallback.enabled": "Boolean file-fallback policy.",
  "session.compaction.summaryMaxTokens": "Numeric summary-token limit.",
  "session.compaction.maxMessageTokens": "Numeric context-message limit.",
  "voice.providers.polly.credentials":
    "AWS shared-config profile selector; inline credentials are explicitly forbidden.",
  "voice.providers.polly.credentials.profile": "Public AWS profile name; credential material is outside configuration.",
};

/** Non-endpoint URL members are excluded explicitly, never through a name-based runtime rule. */
export const URL_EXCEPTIONS: Readonly<Record<string, string>> = {
  $schema: "Public schema identifier; declarative metadata rather than a connection endpoint.",
};

/** Inventory URL-looking declarations by type, format, member name and description. */
export function urlField({ key, node }: ConfigNode): boolean {
  const stringLike =
    node.type === "string" || node.type === "array" || node.enum?.every((value: unknown) => typeof value === "string");
  return Boolean(
    stringLike &&
      (/url|uri/.test(node.format ?? "") ||
        /(?:url|uri|origin|endpoint|relay)s?$/i.test(key.replace(/\[\]$/, "").split(".").at(-1) ?? "") ||
        /\b(?:url|uri|endpoint|wss?\s+relays?)\b/i.test(node.description ?? "")),
  );
}
