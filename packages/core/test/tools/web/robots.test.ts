import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, HostPacer } from "../../../src/tools/web/robots.ts";

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
