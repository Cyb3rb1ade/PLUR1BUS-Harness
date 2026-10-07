// The one API client of the app. Every page uses getApi(); the 401 handling of the shell lives here once: a call that finds
// the session gone sends the UI back to sign-in (with the "expired" notice when a write was interrupted). Created lazily, so
// importing a page does not touch `fetch`, and same-origin (tests run against the mock server on the page's origin).
import { sessionNotice, sessionState } from "../session.ts";
import { createApi, type Api } from "./client.ts";

let api: Api | undefined;

export function getApi(): Api {
  api ??= createApi({
    onUnauthenticated: (kind) => {
      if (kind === "session-expired") sessionNotice.value = "expired";
      sessionState.value = { status: "anonymous" };
    },
  });
  return api;
}

/** Component tests without a browser can swap the client; `undefined` restores the real one. */
export function setApiForTests(next: Api | undefined): void { api = next; }
