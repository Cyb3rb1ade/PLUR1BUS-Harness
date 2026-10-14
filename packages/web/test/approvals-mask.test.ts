// Approvals: credentials that slip into an approval's text are hidden before the page shows them. The server redacts `targets`
// and `summary` (rpc.schema.json), but `agentReason` is the model's own text, and a redactor that works on exact values cannot
// know a value it was never given. Test credentials are assembled at run time, so no token-shaped literal sits in the source.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { maskSecrets } from "../src/pages/approvals/mask.ts";

const sk = ["sk", "q".repeat(24)].join("-");
const gh = ["ghp", "Z".repeat(30)].join("_");
const jwt = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");

describe("maskSecrets", () => {
  test("hides bearer and basic credentials, keeps the scheme", () => {
    assert.equal(maskSecrets(`curl -H "Authorization: Bearer ${sk}" https://example.test/x`), `curl -H "Authorization: Bearer [hidden]" https://example.test/x`);
    assert.equal(maskSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA=="), "Authorization: Basic [hidden]");
  });
  test("hides the password of a URL and keeps user and host", () => {
    assert.equal(maskSecrets("git clone https://bob:hunter22@git.example.test/r.git"), "git clone https://bob:[hidden]@git.example.test/r.git");
  });
  test("hides values of credential-named flags, variables and query parameters", () => {
    assert.equal(maskSecrets("deploy --password hunter22 --region eu"), "deploy --password [hidden] --region eu");
    assert.equal(maskSecrets("deploy --api-key=abc123def"), "deploy --api-key=[hidden]");
    assert.equal(maskSecrets("API_TOKEN=abc123def ./run.sh"), "API_TOKEN=[hidden] ./run.sh");
    assert.equal(maskSecrets("GET /v1?access_key=abc123def&x=1"), "GET /v1?access_key=[hidden]&x=1");
    assert.equal(maskSecrets('{"client_secret": "abc123def"}'), '{"client_secret": "[hidden]"}');
  });
  test("hides well-known token shapes and private key blocks", () => {
    assert.equal(maskSecrets(`use ${sk} and ${gh}`), "use [hidden] and [hidden]");
    assert.equal(maskSecrets(`jwt ${jwt}`), "jwt [hidden]");
    const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\nMIIabc\n" + ["-----END", "PRIVATE KEY-----"].join(" ");
    assert.equal(maskSecrets(`cat > k <<EOF\n${pem}\nEOF`), "cat > k <<EOF\n[hidden]\nEOF");
  });
  test("leaves ordinary text, paths, hashes and the server's own redaction markers alone", () => {
    const plain = [
      "rm -rf /srv/data/archive/old_backups",
      "the token bucket refills every second",
      "sha256sum e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "export TOKEN=[REDACTED:env]",
      "Bearer authentication and Basic documentation are described below",
      "ssh-keygen -f ~/.ssh/id_ed25519",
    ];
    for (const s of plain) assert.equal(maskSecrets(s), s);
  });
  test("is idempotent and total on empty and huge input", () => {
    const once = maskSecrets(`x --token ${sk}`);
    assert.equal(maskSecrets(once), once);
    assert.equal(maskSecrets(""), "");
    const big = "a ".repeat(200_000) + "--password hunter22";
    assert.ok(maskSecrets(big).endsWith("--password [hidden]"));
  });
});
