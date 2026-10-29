import { ApiError, errors } from "./errors.ts";
import type { Handler, HandlerDeps } from "./routes.ts";
import type { DesktopPurpose } from "./desktop-stepup.ts";

function body(value: unknown, fields: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw errors.badRequest("body", "closed approval request required");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || Object.keys(result).some(field => !fields.includes(field))
    || fields.some(field => typeof result[field] !== "string" || (result[field] as string).length > 128)) throw errors.badRequest("body", "invalid approval request");
  return result as Record<string, string>;
}
export function buildDesktopStepUpHandlers(d: HandlerDeps): Record<string, Handler> {
  const authority = () => {
    if (!d.desktopStepUp) throw new ApiError(503, "E_NOT_AVAILABLE", "native approval unavailable");
    return d.desktopStepUp;
  };
  const bearer = (headers: import("node:http").IncomingHttpHeaders | undefined) => {
    const authorization = headers?.authorization;
    const token = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] : undefined;
    if (!token) throw errors.unauthenticated("invalid-device-token");
    return token;
  };
  return {
    "desktop.step-up.start": async i => {
      const value = body(i.body, ["purpose"]);
      if (!["session", "extensions", "imports"].includes(value.purpose!)) throw errors.badRequest("body", "invalid approval purpose");
      return { body: { schema: "desktop.step-up.start/1", ...await authority().start(bearer(i.headers), value.purpose as DesktopPurpose) } };
    },
    "desktop.step-up.poll": async i => ({ body: { schema: "desktop.step-up.poll/1",
      ...await authority().poll(bearer(i.headers), body(i.body, ["challengeId"]).challengeId!) } }),
    "desktop.step-up.cancel": async i => {
      await authority().cancel(bearer(i.headers), body(i.body, ["challengeId"]).challengeId!);
      return { body: { schema: "desktop.step-up.cancel/1", ok: true } };
    },
    "desktop.step-up.approval": async i => {
      if (!i.session) throw errors.unauthenticated();
      return { body: { schema: "desktop.step-up.approval/1", ...await authority().lookup(i.session, i.pathParams?.userCode ?? "") } };
    },
    "desktop.step-up.decision": async i => {
      if (!i.session) throw errors.unauthenticated();
      const value = body(i.body, ["userCode", "decision"]);
      if (value.decision !== "approve" && value.decision !== "decline") throw errors.badRequest("body", "invalid approval decision");
      return { body: { schema: "desktop.step-up.decision/1", ...await authority().decision(i.session, value.userCode!, value.decision) } };
    },
  };
}
