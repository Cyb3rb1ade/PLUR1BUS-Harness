import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseExposition } from "./exposition-parser.ts";

describe("Prometheus exposition parser", () => {
  it("requires HELP and TYPE metadata and the _total counter suffix", () => {
    assert.throws(() => parseExposition("# HELP requests_total Requests.\n"), /missing TYPE/);
    assert.throws(() => parseExposition("# HELP requests_total Requests.\nrequests_total 1\n"), /missing TYPE/);
    assert.doesNotThrow(() => parseExposition("# HELP requests_total Requests.\n# TYPE requests_total counter\n"));
    assert.throws(() => parseExposition("# HELP requests Requests.\n# TYPE requests counter\n"), /end with _total/);
    assert.throws(() => parseExposition("# TYPE requests_total counter\n"), /TYPE without HELP/);
  });

  it("rejects duplicate series and malformed names or label escapes", () => {
    assert.throws(() => parseExposition("# HELP requests_total Requests.\n# TYPE requests_total counter\nrequests_total{result=\"ok\"} 1\nrequests_total{result=\"ok\"} 2\n"), /duplicate series/);
    assert.throws(() => parseExposition("# HELP requests_total Requests.\n# TYPE requests_total counter\nrequests_total{first=\"a\",second=\"b\"} 1\nrequests_total{second=\"b\",first=\"a\"} 2\n"), /duplicate series/);
    assert.throws(() => parseExposition("# HELP bad-name Requests.\n# TYPE bad-name gauge\n"), /bad HELP/);
    assert.throws(() => parseExposition("# HELP requests_total Requests.\n# TYPE requests_total counter\nrequests_total{result=\"bad\\q\"} 1\n"), /bad escape/);
    assert.doesNotThrow(() => parseExposition("# HELP requests_total Requests.\n# TYPE requests_total counter\nrequests_total{a=\"b,c\",d=\"e\"} 1\nrequests_total{a=\"b\",c=\"d,e\"} 2\n"));
  });

  it("parses valid names and escaped label values", () => {
    const [family] = parseExposition('# HELP requests_total Requests.\n# TYPE requests_total counter\nrequests_total{result="quote\\" slash\\\\ newline\\n"} 1\n');
    assert.equal(family!.name, "requests_total");
    assert.equal(family!.type, "counter");
    assert.equal(family!.samples[0]!.labels.result, 'quote" slash\\ newline\n');
  });
});
