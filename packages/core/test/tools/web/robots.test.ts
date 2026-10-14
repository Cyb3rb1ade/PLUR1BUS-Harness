import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, HostPacer } from "../../../src/tools/web/robots.ts";
import { cpuMs } from "../../helpers/cpu-time.ts";

const UA = "PLUR1BUS";

describe("robots: parsing and matching (RFC 9309)", () => {
  it("empty or missing rules allow everything", () => {
    assert.equal(robotsAllows(parseRobots(""), UA, "/anything"), true);
    assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:"), UA, "/x"), true);
  });
  it("Disallow prefix applies to the * group", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\n");
    assert.equal(robotsAllows(r, UA, "/private/a"), false);
    assert.equal(robotsAllows(r, UA, "/public"), true);
  });
  it("a specific group beats *, matched on the product token case-insensitively", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: plur1bus\nAllow: /\nDisallow: /secret\n");
    assert.equal(robotsAllows(r, "PLUR1BUS/0.1 (+https://plur1bus.app/bot)", "/page"), true);
    assert.equal(robotsAllows(r, UA, "/secret/x"), false);
    assert.equal(robotsAllows(r, "otherbot", "/page"), false);
  });
  it("longest match wins, Allow wins a tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /c\nAllow: /c\n");
    assert.equal(robotsAllows(r, UA, "/a/x"), false);
    assert.equal(robotsAllows(r, UA, "/a/b/x"), true);
    assert.equal(robotsAllows(r, UA, "/c"), true);
  });
  it("wildcards and end anchors", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n");
    assert.equal(robotsAllows(r, UA, "/doc/a.pdf"), false);
    assert.equal(robotsAllows(r, UA, "/doc/a.pdf?x=1"), true);
    assert.equal(robotsAllows(r, UA, "/tmp123/cache"), false);
  });
  it("comments, CRLF, stacked user-agents and crawl-delay", () => {
    const r = parseRobots("# c\r\nUser-agent: a\r\nUser-agent: plur1bus # me\r\nDisallow: /x # no\r\nCrawl-delay: 5\r\n");
    assert.equal(robotsAllows(r, UA, "/x"), false);
    assert.equal(r.crawlDelaySeconds(UA), 5);
  });
  it("oversized input is truncated, junk lines ignored, never throws", () => {
    const r = parseRobots("garbage\n".repeat(100_000) + "User-agent: *\nDisallow: /\n");
    assert.equal(typeof robotsAllows(r, UA, "/"), "boolean");
  });
});

describe("robots: per-host pacing on a fake clock", () => {
  it("spaces requests to one host by the minimum interval and leaves other hosts alone", async () => {
    let t = 1000;
    const slept: number[] = [];
    const pacer = new HostPacer({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await pacer.wait("a.test"); // first: no wait
    await pacer.wait("a.test"); // second: full interval
    t += 400;
    await pacer.wait("a.test"); // 600 left
    await pacer.wait("b.test"); // other host: none
    assert.deepEqual(slept, [1000, 600]);
  });
  it("honours a larger crawl-delay", async () => {
    let t = 0;
    const slept: number[] = [];
    const pacer = new HostPacer({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await pacer.wait("a.test", 3000);
    await pacer.wait("a.test", 3000);
    assert.deepEqual(slept, [3000]);
  });
});

describe("robots: hostile robots.txt cannot stall the process", () => {
  it("a pattern with many wildcards matches in linear time (no regex backtracking)", () => {
    const r = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(6)}*b\n`);
    const t0 = cpuMs(); // CPU time, not wall clock: stays put while a loaded machine delays this process
    assert.equal(robotsAllows(r, UA, `/${"a".repeat(120)}`), true);
    assert.ok(cpuMs() - t0 < 200, `took ${Math.round(cpuMs() - t0)} ms of CPU`);
  });
  it("wildcard semantics are kept: inner stars, trailing star, anchored end", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a*b*c\nDisallow: /x*$\nDisallow: /e*d$\n");
    assert.equal(robotsAllows(r, UA, "/a-b-c"), false);
    assert.equal(robotsAllows(r, UA, "/a-c-b"), true);
    assert.equal(robotsAllows(r, UA, "/xyz"), false);
    assert.equal(robotsAllows(r, UA, "/e1d"), false);
    assert.equal(robotsAllows(r, UA, "/e1d2"), true);
  });
  it("an empty User-agent value names nobody (it must not capture every crawler)", () => {
    const r = parseRobots("User-agent: *\nAllow: /\n\nUser-agent:\nDisallow: /\n");
    assert.equal(robotsAllows(r, UA, "/page"), true);
  });
  it("an absurd Crawl-delay is capped, so a site cannot park the agent for hours", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 86400\n");
    assert.ok((r.crawlDelaySeconds(UA) ?? 0) <= 30);
  });
  it("the pacer's wait ends when the caller aborts, and a sleeping wait does not outlive it", async () => {
    const ac = new AbortController();
    const pacer = new HostPacer({ minIntervalMs: 60_000 });
    await pacer.wait("slow.test");
    const p = pacer.wait("slow.test", 0, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const t0 = performance.now();
    await assert.rejects(p, /abort|cancel/i);
    assert.ok(performance.now() - t0 < 2000);
  });
  it("an aborted wait gives its reserved slot back", async () => {
    let t = 0;
    const slept: number[] = [];
    const pacer = new HostPacer({ minIntervalMs: 1000, now: () => t, sleep: async (ms) => { slept.push(ms); } });
    await pacer.wait("a.test");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(pacer.wait("a.test", 0, ac.signal));
    await pacer.wait("a.test");
    assert.deepEqual(slept, [1000]);
  });
  it("the pacer forgets hosts whose slot has passed (bounded memory)", async () => {
    let t = 0;
    const pacer = new HostPacer({ minIntervalMs: 10, now: () => t, sleep: async () => {} });
    for (let i = 0; i < 5000; i++) { await pacer.wait(`h${i}.test`); t += 1000; }
    assert.ok(pacer.size <= 1024, `kept ${pacer.size}`);
  });
});
