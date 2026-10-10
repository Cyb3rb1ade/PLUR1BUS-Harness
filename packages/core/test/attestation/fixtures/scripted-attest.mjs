// A scripted stand-in for the native `plur1bus-attest` helper, for the cases `fake-attest.mjs` cannot express (a malformed or
// partial reply, a hung helper that reports its pid). ATTEST_REPLY is the JSON object to answer with; a top-level string value of
// "$nonce" or "$hash" is filled from the request, `$omit` lists keys to leave out. `$hang: true` never answers and writes its pid to
// ATTEST_PID_FILE. `--probe` answers with `$probe` when the template gives one. Mirrors the protocol in pinned-fake's helper.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const tpl = JSON.parse(process.env.ATTEST_REPLY ?? "{}");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--probe")) {
  out(tpl.$probe ?? { v: 1, available: true, method: "scripted" });
  process.exit(0);
}

if (tpl.$hang === true) {
  writeFileSync(process.env.ATTEST_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000); // never answer; the core must kill us
} else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    const fill = { $nonce: req.nonce, $hash: req.actionHash };
    const reply = {};
    for (const [k, v] of Object.entries(tpl)) {
      if (k.startsWith("$")) continue;
      reply[k] = typeof v === "string" && v in fill ? fill[v] : v;
    }
    for (const k of tpl.$omit ?? []) delete reply[k];
    out(reply);
    process.exit(0);
  });
}
