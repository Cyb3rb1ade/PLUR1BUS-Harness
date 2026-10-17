// Nightly live check of the SearXNG provider (M2 criterion 13, D95). Runs only when PLUR1BUS_SEARXNG_LIVE_URL names a
// SearXNG instance whose address the sidecar rule admits (container network, tailnet or loopback; see docs/web-search.md);
// ordinary and PR runs skip it. It asks one broad question and checks the shape of the answer, never its content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearxngWebSearch } from "../../src/sidecars/web-search.ts";

const url = process.env.PLUR1BUS_SEARXNG_LIVE_URL;

test("live SearXNG answers a search with normalised results", { skip: !url ? "PLUR1BUS_SEARXNG_LIVE_URL is not set" : false }, async () => {
  const ws = createSearxngWebSearch({ config: () => ({ searxng: { mode: "remote", url: url!, timeoutMs: 20_000 } }), env: {}, timeoutMs: 20_000 });
  const out = await ws.search.search({ query: "wikipedia", count: 5 });
  assert.equal(out.provider, "searxng");
  assert.ok(out.results.length >= 1, "a broad query returns at least one result");
  for (const r of out.results) {
    assert.match(r.url, /^https?:\/\//);
    assert.ok(r.title.length > 0 && r.source.length > 0);
  }
  assert.equal(out.provenance.trust, "untrusted");
  assert.equal(ws.status().state, "ok");
});
