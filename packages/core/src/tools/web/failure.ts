// Typed failures for the web tools (D94 "Typed failures", D97 item 3). A failure is never a bare error: the agent
// learns why (`code`), what to try next (`hint`) and what to tell the person (`userAction`, one sentence).

export type WebFailureCode =
  | "invalid-arguments"
  | "invalid-url"
  | "private-address"
  | "egress-denied"
  | "not-found"
  | "gone"
  | "auth-required"
  | "paywall"
  | "rate-limited"
  | "timeout"
  | "too-large"
  | "unsupported-type"
  | "tls-error"
  | "needs-render"
  | "too-many-redirects"
  | "robots-disallowed"
  | "network-error"
  | "http-error"
  | "cursor-expired"
  | "no-provider"
  | "provider-failed";

const TEXTS: Record<WebFailureCode, { hint: string; userAction: string }> = {
  "invalid-arguments": { hint: "Fix the arguments named in the message and call again.", userAction: "I called the tool with a malformed request; I will correct it." },
  "invalid-url": { hint: "Use an absolute http:// or https:// URL without credentials.", userAction: "That link is not a normal web address; can you send the full http(s) URL?" },
  "private-address": {
    hint: "The address is internal (private, loopback, link-local or a cloud metadata address) and is never fetched. Use a public source instead.",
    userAction: "That address points to a private network and I do not read those; an administrator can allow a specific range in the web settings.",
  },
  "egress-denied": { hint: "This kind of request is not allowed by the web policy. Use an http(s) URL on a standard port.", userAction: "The web policy blocks that request." },
  "not-found": { hint: "The page does not exist at this URL. Search for the current location with web.search.", userAction: "That page is not there any more; I will look for another source." },
  gone: { hint: "The page was removed on purpose. Look for a replacement with web.search.", userAction: "The page has been taken down; I will look for another source." },
  "auth-required": { hint: "The page needs a login. Do not guess credentials; look for a public source.", userAction: "The page needs a login: sign in in the browser panel and say 'continue'." },
  paywall: { hint: "The content is behind a paywall. Look for a free source with web.search; do not try to bypass it.", userAction: "That article is paywalled: forward it to me or give me access; meanwhile I will look for free sources." },
  "rate-limited": { hint: "Retry after the stated delay, or use another source.", userAction: "The site limits automated requests; I will retry later." },
  timeout: { hint: "The site was too slow. Retry once, or fetch a different page of the site.", userAction: "The site did not answer in time; I will try again or use another source." },
  "too-large": { hint: "The response exceeds the size limit. Use a more specific URL or a page of the document.", userAction: "That file is too large to read in one go." },
  "unsupported-type": { hint: "Only HTML, plain text, Markdown, JSON, XML and CSV can be read here.", userAction: "I cannot read that kind of file yet; can you paste the relevant part?" },
  "tls-error": { hint: "The site's certificate could not be verified. Do not retry over plain http.", userAction: "The site's security certificate is not valid, so I did not open it." },
  "needs-render": { hint: "The page builds its content in the browser and no browser is available to render it.", userAction: "That page needs a browser to display; open it in the browser panel and tell me what you see." },
  "too-many-redirects": { hint: "The URL redirects in a loop or too many times. Try the final address from the site itself.", userAction: "That link keeps redirecting; I will look for the real address." },
  "robots-disallowed": { hint: "The site's robots.txt disallows crawling this path. Fetch only the page you were asked for.", userAction: "The site asks automated crawlers not to read that path." },
  "network-error": { hint: "The connection failed. Retry once; if it persists, use another source.", userAction: "I could not reach the site." },
  "http-error": { hint: "The server answered with an error status. See `status`; retry later or use another source.", userAction: "The site returned an error." },
  "cursor-expired": { hint: "Fetch the URL again without a cursor.", userAction: "I lost my place in that document and will reload it." },
  "no-provider": { hint: "No search provider is configured. Use web.fetch on a known URL.", userAction: "Web search is not set up: add a search provider in Settings › Web search." },
  "provider-failed": { hint: "Every configured search provider failed. Use web.fetch on a known URL.", userAction: "Web search is not answering right now." },
};

export interface WebFailureExtra {
  status?: number;
  url?: string;
  retryAfterSeconds?: number;
}

export class WebFailure extends Error {
  readonly code: WebFailureCode;
  readonly hint: string;
  readonly userAction: string;
  readonly extra: WebFailureExtra;

  constructor(code: WebFailureCode, message: string, extra: WebFailureExtra = {}) {
    super(message);
    this.name = "WebFailure";
    this.code = code;
    this.hint = TEXTS[code].hint;
    this.userAction = TEXTS[code].userAction;
    this.extra = extra;
  }

  /** The structured `isError` result the model sees (D97 item 3): no stack, a code and a hint. */
  toResult(): { isError: true; error: { code: WebFailureCode; message: string; hint: string; userAction: string } & WebFailureExtra } {
    return { isError: true, error: { code: this.code, message: this.message, hint: this.hint, userAction: this.userAction, ...this.extra } };
  }
}

export const isWebFailure = (e: unknown): e is WebFailure => e instanceof WebFailure;
