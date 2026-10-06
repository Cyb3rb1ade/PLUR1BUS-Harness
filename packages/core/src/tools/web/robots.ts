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
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (value !== "") cur.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
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

function patternToRegExp(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** `path` includes the query string, as robots.txt rules are matched against it. */
export function robotsAllows(robots: Robots, userAgent: string, path: string): boolean {
  const token = productToken(userAgent);
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const groups = specific.length > 0 ? specific : robots.groups.filter((g) => g.agents.includes("*"));
  let best: { len: number; allow: boolean } | undefined;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!patternToRegExp(r.pattern).test(path)) continue;
      const len = r.pattern.replace(/\*/g, "").length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

export interface PacerOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Spaces requests per host. Clock and sleep are injectable so tests never wait. */
export class HostPacer {
  private readonly next = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: PacerOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async wait(host: string, crawlDelayMs = 0): Promise<void> {
    const interval = Math.max(this.minIntervalMs, crawlDelayMs);
    const at = Math.max(this.now(), this.next.get(host) ?? 0); // reserve synchronously so concurrent callers queue
    this.next.set(host, at + interval);
    const delay = at - this.now();
    if (delay > 0) await this.sleep(delay);
  }
}
