// robots.txt for the crawl path (D94 "Robots"): RFC 9309 matching plus a per-host pacer. A single page the person
// or task asked for does not consult robots.txt; following links beyond it, or more than 20 pages per task on a
// host, does, and is paced (default 1 request/s per host).

interface Rule {
  allow: boolean;
  pattern: string;
}
interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

export interface Robots {
  groups: Group[];
  crawlDelaySeconds(userAgent: string): number | undefined;
}

const MAX_ROBOTS_BYTES = 500 * 1024;
/** A site's Crawl-delay is honoured up to this; a larger value must not park the agent (or its slot) for hours. */
export const MAX_CRAWL_DELAY_SECONDS = 30;
/** The pacer forgets hosts beyond this many once their slot has passed. */
const MAX_PACED_HOSTS = 1024;

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  let cur: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.slice(0, MAX_ROBOTS_BYTES).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      // An empty value names nobody: kept as a group boundary, but it must not match every crawler by prefix.
      if (value !== "") cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (value !== "") cur.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = Math.min(n, MAX_CRAWL_DELAY_SECONDS);
    }
  }
  const pick = (ua: string): Group[] => {
    const token = productToken(ua);
    const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
    return specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  };
  return {
    groups,
    crawlDelaySeconds: (ua) => pick(ua).find((g) => g.crawlDelay !== undefined)?.crawlDelay,
  };
}

const productToken = (ua: string): string => (/^[A-Za-z0-9_-]+/.exec(ua.trim())?.[0] ?? "").toLowerCase();

/**
 * RFC 9309 pattern match: `*` is any run of characters, a trailing `$` anchors the end. Done segment by segment (leftmost
 * match of each literal piece), never as a regular expression: a hostile robots.txt such as `/*a*a*a*a*b` would make a
 * backtracking engine run for hours on a long path.
 */
function patternMatches(p: string, path: string): boolean {
  const anchored = p.endsWith("$");
  const parts = (anchored ? p.slice(0, -1) : p).split("*");
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = path.indexOf(parts[i]!, pos);
    if (at === -1) return false;
    pos = at + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) !== -1;
}

/** `path` includes the query string, as robots.txt rules are matched against it. */
export function robotsAllows(robots: Robots, userAgent: string, path: string): boolean {
  const token = productToken(userAgent);
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const groups = specific.length > 0 ? specific : robots.groups.filter((g) => g.agents.includes("*"));
  let best: { len: number; allow: boolean } | undefined;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!patternMatches(r.pattern, path)) continue;
      const len = r.pattern.replace(/\*/g, "").length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

export interface PacerOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Spaces requests per host. Clock and sleep are injectable so tests never wait. */
export class HostPacer {
  private readonly next = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: PacerOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Hosts currently remembered (tests). */
  get size(): number { return this.next.size; }

  async wait(host: string, crawlDelayMs = 0, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("the wait was cancelled");
    const interval = Math.max(this.minIntervalMs, crawlDelayMs);
    const previous = this.next.get(host);
    const at = Math.max(this.now(), previous ?? 0); // reserve synchronously so concurrent callers queue
    const reserved = at + interval;
    this.next.set(host, reserved);
    if (this.next.size > MAX_PACED_HOSTS) this.prune();
    const delay = at - this.now();
    if (delay > 0) {
      try { await this.sleep(delay, signal); }
      catch (e) {
        // A cancelled wait gives its slot back, unless a later caller has queued behind it.
        if (this.next.get(host) === reserved) { if (previous === undefined) this.next.delete(host); else this.next.set(host, previous); }
        throw e;
      }
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [h, until] of this.next) if (until <= t) this.next.delete(h);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("the wait was cancelled"));
    const onAbort = (): void => { clearTimeout(timer); reject(new Error("the wait was cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
