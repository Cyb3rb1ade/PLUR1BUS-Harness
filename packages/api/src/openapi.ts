import { API_VERSION, COMPONENT_SCHEMAS, COOKIE_NAME, COOKIE_NAME_TLS, CSRF_HEADER, ROUTES, type RouteSpec } from "./routes.ts";

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

function operation(r: RouteSpec): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [String(r.successStatus)]: { description: r.success.description, content: { "application/json": { schema: r.success.schema } } },
  };
  for (const [status, x] of Object.entries(r.extra ?? {})) responses[status] = { description: x.description, content: { "application/json": { schema: x.schema } } };
  if (r.requestBody) { responses["400"] = errorResponse("Malformed JSON or a body that does not match the schema (`reason`: `json`, `body`)."); responses["415"] = errorResponse("The content type is not `application/json`."); }
  if (r.auth === "session") responses["401"] = errorResponse("No live session (`reason`: `no-session`).");
  else responses["401"] = errorResponse("The credentials are wrong (`reason`: `invalid-token` for the owner token, `invalid-credentials` for a local account).");
  const denied = typeof r.authz === "object" ? " The caller's role does not hold the route's action, or a token scope excludes it (`reason`: `role-denied`, `object-right-required`, `token-scope` …)." : "";
  if (r.csrf) responses["403"] = errorResponse(`The one-time CSRF token is missing, wrong, spent or expired (\`reason\`: \`csrf\`); or a foreign \`Origin\` / cross-site fetch (\`reason\`: \`origin\`, \`cross-site\`).${denied}`);
  else responses["403"] = errorResponse(`A foreign \`Origin\` or a cross-site fetch (\`reason\`: \`origin\`, \`cross-site\`).${denied}`);
  responses["413"] = errorResponse("The request body exceeds the size limit (`reason`: `body-too-large`).");
  responses["421"] = errorResponse("The `Host` header is not the API's own loopback name (`reason`: `host`).");
  responses["429"] = errorResponse("Rate limit exceeded (`reason`: `rate-limited`); `Retry-After` says when to try again.");
  responses["504"] = errorResponse("The handler did not answer in time (`reason`: `handler-timeout`).");
  return {
    operationId: r.id, tags: [r.tag], summary: r.summary,
    ...(r.auth === "session" ? { security: [{ cookieAuth: [] }] } : { security: [] }),
    ...(r.csrf ? { parameters: [{ name: "X-CSRF-Token", in: "header", required: true, description: "A one-time token from `GET /api/v1/csrf`.", schema: { type: "string" } }] } : {}),
    ...(r.requestBody ? { requestBody: { required: true, content: { "application/json": { schema: r.requestBody } } } } : {}),
    responses,
    "x-stability": r.stability, "x-since": r.since, "x-rate-class": r.rate, "x-csrf": r.csrf, "x-authz": authzLabel(r),
  };
}

/** What the surface map and the document show for a route's declared authorization. */
export function authzLabel(r: RouteSpec): string { return typeof r.authz === "object" ? r.authz.action : r.authz; }

/** The OpenAPI 3.1 document, generated from the route table and nothing else (`docs/openapi.json`). */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  return {
    openapi: "3.1.0",
    info: {
      title: "PLUR1BUS Harness API", version: API_VERSION,
      description: "Generated from `packages/api/src/routes.ts` by `scripts/gen-openapi.mjs`; do not edit by hand. Loopback only. Every response carries the security headers (CSP `default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, HSTS over TLS). Failures are `error/1` documents (ADR-016 §8).",
    },
    servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "0", description: "The loopback port the API listens on." } } }],
    tags: [{ name: "session" }, { name: "status" }, { name: "agents" }],
    paths,
    components: {
      securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: COOKIE_NAME, description: `The session cookie (\`${COOKIE_NAME_TLS}\` over TLS): HttpOnly, SameSite=Strict, Secure over TLS.` } },
      schemas: COMPONENT_SCHEMAS,
    },
    "x-csrf-header": CSRF_HEADER,
  };
}

/** `docs/api-surface.md` (ADR-004 action item 2): routes × method × auth × rate class, from the same table. */
export function buildSurfaceMarkdown(): string {
  const rows = ROUTES.map((r) => `| \`${r.method}\` | \`${r.path}\` | \`${r.id}\` | ${r.auth === "none" ? "public" : "session"} | \`${authzLabel(r)}\` | ${r.csrf ? "yes" : "no"} | ${r.rate} | ${r.stability} · ${r.since} |`);
  return `# Harness API surface (generated)

Generated from \`packages/api/src/routes.ts\` by \`scripts/gen-openapi.mjs\` — do not edit by hand; run \`pnpm docs:gen\`. The machine-readable form is [openapi.json](openapi.json). Every later endpoint is added to the route table first (ADR-004 action item 2).

Every route is **deny by default**: a route that is not \`public\` answers 401 without a live session, and every route declares the RBAC action it needs (\`Action\` column, \`authenticated\` = any live principal, for session handling only); a route without a declaration answers 403. Writes need a one-time CSRF token (\`X-CSRF-Token\`, from \`GET /api/v1/csrf\`). Rate classes are per principal and per IP; request bodies are limited in size; every response, errors included, carries the security headers.

| Method | Path | Operation | Auth | Action | CSRF | Rate class | Stability · since |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
}
