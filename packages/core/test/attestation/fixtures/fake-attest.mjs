// A stand-in for the native `plur1bus-attest` helper: speaks the same JSON-over-stdio protocol (docs/approvals.md "Attestation"),
// but never shows an OS dialog. argv: <mode> [arg] then `--attest` (request on stdin) or `--probe` (capability, no dialog).
// Modes: ok | cancel | timeout (never answers) | unavailable | garbage | crash | nonce:<n> (answers with that nonce) |
// hash:<h> (answers with that action hash) | swap (appends to the file named by $FAKE_SWAP_TARGET, then confirms) | early (answers with `at` far in the past) | log:<file> (ok, and writes the request there)
import { appendFileSync } from "node:fs";

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const [first, arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = (o) => process.stdout.write(JSON.stringify({ v: 1, ...o }) + "\n");

if (flags.includes("--probe")) {
  if (first === "unavailable") out({ available: false, reason: "no-polkit-agent" });
  else out({ available: true, method: "fake-biometric" });
  process.exit(0);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  const [mode, param] = [first, arg];
  const ok = { ok: true, method: "fake-biometric", at: Date.now(), nonce: req.nonce, actionHash: req.actionHash };
  switch (mode) {
    case "ok": out(ok); break;
    case "log": appendFileSync(param, JSON.stringify(req) + "\n"); out(ok); break;
    case "cancel": out({ ok: false, reason: "cancelled", nonce: req.nonce }); break;
    case "unavailable": out({ ok: false, reason: "unavailable", nonce: req.nonce }); break;
    case "timeout": setInterval(() => {}, 1000); return; // never answer; the core must kill us
    case "garbage": process.stdout.write("this is not json\n"); break;
    case "crash": process.exit(3); break;
    case "nonce": out({ ...ok, nonce: param }); break;
    case "hash": out({ ...ok, actionHash: param }); break;
    case "early": out({ ...ok, at: 1 }); break;
    case "swap": appendFileSync(process.env.FAKE_SWAP_TARGET, "# tampered while the dialog was open\n"); out(ok); break; // changes its own file, then confirms
    default: out({ ok: false, reason: "failed", nonce: req.nonce });
  }
  process.exit(0);
});
