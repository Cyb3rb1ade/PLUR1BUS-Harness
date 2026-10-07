import { t } from "./i18n.ts";
import type { WriteFailure } from "./session.ts";

/** The i18n text of a failed mutating request (session.ts `sessionWrite`), for whatever page issued it. */
export function writeFailureText(f: WriteFailure): string {
  switch (f.kind) {
    case "session-expired": return t("session.error.expired");
    case "csrf": return t("session.error.csrf");
    case "rate-limited": return t("session.error.rate");
    case "network": return t("session.error.network");
    case "server": return t("session.error.server", { status: f.status });
  }
}
