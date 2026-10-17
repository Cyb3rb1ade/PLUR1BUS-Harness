import { t } from "./i18n.ts";
import type { WriteFailure } from "./session.ts";

/** A wait longer than this is not shown as a number: a minute-scale hint is useful, "in 86400 s" is not. */
const MAX_SHOWN_WAIT_S = 3600;

/** The i18n text of a failed mutating request (session.ts `sessionWrite`), for whatever page issued it. */
export function writeFailureText(f: WriteFailure): string {
  switch (f.kind) {
    case "session-expired": return t("session.error.expired");
    case "csrf": return t("session.error.csrf");
    case "rate-limited": return f.retryAfterSeconds !== null && f.retryAfterSeconds > 0 && f.retryAfterSeconds <= MAX_SHOWN_WAIT_S ? t("session.error.rateWait", { seconds: f.retryAfterSeconds }) : t("session.error.rate");
    case "network": return t("session.error.network");
    case "server": return t("session.error.server", { status: f.status });
  }
}
