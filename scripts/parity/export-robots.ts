import { fileURLToPath } from "node:url";
import { parseRobots, robotsAllows } from "../../packages/core/src/tools/web/robots.ts";
import { exporterMain } from "./lib.mjs";

export function captureRobots() {
  const inputs = [
    { body: "User-agent: *\nDisallow: /draft\nAllow: /draft/preview\nCrawl-delay: 45",
      agent: "FixtureBot/1", paths: ["/", "/draft", "/draft/preview"] },
    { body: "User-agent: *\nDisallow: /\nUser-agent: Fixture\nUser-agent: Sample\nAllow: /\nCrawl-delay: 0x5",
      agent: "FixtureBot/1", paths: ["/", "/draft"] },
    { body: "User-agent: *\nDisallow: /same\nAllow: /same\nDisallow: /assets/*.png$",
      agent: "FixtureBot", paths: ["/same", "/assets/a.png", "/assets/a.png?x=1", "/assets/.png"] },
    { body: "User-agent:\nDisallow: /secret\nUser-agent: *\nCrawl-delay: 0.5 # comment",
      agent: "FixtureBot", paths: ["/", "/secret"] },
    { body: "User-agent: *\r\nDisallow:\r\nDisallow: /print$\r\nCrawl-delay: -1",
      agent: "test", paths: ["/print", "/printer", "/print/"] },
  ];
  return { robots: { source: "packages/core/src/tools/web/robots.ts", cases: inputs.map(input => {
    const parsed = parseRobots(input.body);
    return { ...input, expected: {
      delay: parsed.crawlDelaySeconds(input.agent) ?? null,
      decisions: input.paths.map(path => robotsAllows(parsed, input.agent, path)),
    } };
  }) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "webtools", build: captureRobots });
}
