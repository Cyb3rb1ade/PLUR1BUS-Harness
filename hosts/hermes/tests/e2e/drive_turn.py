"""Drive a real Hermes through the plur1bus provider (HM2 Task 6, job ``real-hermes``).

Subcommands, run in this order by ``.github/workflows/hermes-host.yml`` (every path is under the disposable
root; ``assert_disposable.py`` runs first):

``configure``  writes ``$HERMES_HOME/config.yaml`` with exactly the model block of Hermes facts (i) (a
               ``custom`` provider at the stub's loopback URL, model ``stub-model``); an existing file is
               kept as ``config.yaml.orig``.
``activate``   sets ``memory.provider`` with a minimal line edit (HM2-R24: never ``hermes config set`` on
               0.21.4, which strips ``config.yaml``) after checking the provider directory exists (HM2-R17a),
               then verifies with ``hermes config get memory.provider --json`` (facts (b)).
``recall-budget``  sets the binding's ``recallHardMs`` (shared CI runners are not reference hardware).
``turns``      turn 1 says a synthetic fact; waits until ``plur1bus memory list --agent <bound agent>`` holds
               it (the sidecar received the capture); turn 2 asks about it; asserts the second turn's request
               to the stub model carries the recalled fact. Prints one JSON summary; exit 0 = both hold.

The agent is whatever ``hermes plur1bus bind`` wrote to ``$HERMES_HOME/plur1bus.json``: a ``HERMES_HOME``
outside ``~/.hermes`` binds ``hermes-home-<hash8>`` (HM2-R8a), not ``hermes-default``.

Stdlib only; imports nothing from the test package or the provider (it runs outside Hermes' venv).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

FACT_PROMPT = "Please remember that the Lindqvist harbour tour starts at nine from pier four."
QUESTION = "Where does the Lindqvist harbour tour start from?"
KEYWORD = "pier four"
REPLY = "stub reply: ok"
TURN_TIMEOUT_S = 300.0
CAPTURE_TIMEOUT_S = 120.0

MODEL_YAML = """model:
  provider: custom
  base_url: {base_url}
  default: stub-model
"""

_MEMORY_RE = re.compile(r"^memory:[ \t]*(#.*)?$")
_TOP_RE = re.compile(r"^[^\s#]")


class Failure(Exception):
    pass


# -- config.yaml ----------------------------------------------------------------------------------


def set_memory_provider(text: str, value: str) -> str:
    """``memory.provider: <value>`` by a line edit that leaves every other line as it is (HM2-R24).

    A block-style top-level ``memory:`` gets its ``provider:`` child replaced or inserted (at the block's child
    indentation); no ``memory:`` appends a block. A flow-style or scalar ``memory:`` is refused (no YAML parser)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]*", value):
        raise Failure(f"refusing an unquoted provider value {value!r}")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        bare = line.rstrip("\r\n")
        if bare.startswith("memory:") and not _MEMORY_RE.match(bare):
            raise Failure("config.yaml has a flow-style or scalar memory: value; refusing to line-edit it")
        if not _MEMORY_RE.match(bare):
            continue
        indent = None
        j = i + 1
        while j < len(lines):
            cur = lines[j].rstrip("\r\n")
            if cur.strip() == "" or cur.lstrip().startswith("#"):
                j += 1
                continue
            if _TOP_RE.match(cur):
                break
            ind = cur[: len(cur) - len(cur.lstrip())]
            if indent is None:
                indent = ind
            if ind == indent:
                m = re.match(r"^(\s+)provider:(\s*)([^#]*?)(\s*#.*)?$", cur)
                if m:
                    lines[j] = f"{m.group(1)}provider: {value}{m.group(4) or ''}{nl}"
                    return "".join(lines)
            j += 1
        lines.insert(i + 1, f"{indent or '  '}provider: {value}{nl}")
        return "".join(lines)
    if text and not text.endswith(("\n", "\r")):
        text += nl
    return f"{text}memory:{nl}  provider: {value}{nl}"


def _atomic_write(path: str, text: str) -> None:
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# -- processes ------------------------------------------------------------------------------------


def hermes_argv(hermes: str, args: list[str]) -> list[str]:
    """A ``.cmd`` launcher runs through ``cmd.exe /d /s /c`` (Hermes facts (j))."""
    if os.name == "nt" and hermes.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/d", "/s", "/c", hermes, *args]
    return [hermes, *args]


def run(argv: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)


def _tail(s: str, n: int = 3000) -> str:
    return s[-n:]


def hermes_config_get(hermes: str, key: str) -> str:
    p = run(hermes_argv(hermes, ["config", "get", key, "--json"]), 120)
    if p.returncode != 0:
        raise Failure(f"hermes config get {key} --json: exit {p.returncode}\n{_tail(p.stdout)}\n{_tail(p.stderr)}")
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as e:
        raise Failure(f"hermes config get {key} --json printed no JSON: {_tail(p.stdout)}") from e


def memory_texts(bin_: str, home: str, agent: str) -> list[str]:
    p = run([bin_, "--json", "--home", home, "memory", "list", "--agent", agent], 60)
    if p.returncode != 0:
        raise Failure(f"plur1bus memory list --agent {agent}: exit {p.returncode}\n{_tail(p.stdout)}\n{_tail(p.stderr)}")
    items = json.loads(p.stdout).get("items") or []
    return [str(it.get("text") or it.get("summary") or "") for it in items]


def stub_requests(log: str) -> list[dict]:
    if not os.path.exists(log):
        return []
    out = []
    with open(log, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
    return out


_RECORD_RE = re.compile(r"<memory-record\b[^>]*>(.*?)</memory-record>", re.S)


def recalled_in(request: dict) -> bool:
    """The fact arrived through the provider's prefetch: inside a ``<memory-record ...>`` fence of the recall text
    (``memory.recall`` joined text, observed in the user message), not merely anywhere in the request."""
    for m in request.get("messages") or []:
        content = m.get("content") if isinstance(m, dict) else None
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        if any(KEYWORD in body for body in _RECORD_RE.findall(text)):
            return True
    return False


def chat(hermes: str, text: str) -> dict:
    t0 = time.monotonic()
    p = run(hermes_argv(hermes, ["chat", "-q", text, "-Q"]), TURN_TIMEOUT_S)
    took = round(time.monotonic() - t0, 1)
    # The session_id line goes to stderr on 0.21.4 (observed here) and to stdout per facts (i): accept either.
    if p.returncode != 0 or REPLY not in p.stdout or "session_id:" not in p.stdout + p.stderr:
        raise Failure(f"hermes chat -q: exit {p.returncode} after {took} s (want exit 0, {REPLY!r} and a session_id line)\n"
                      f"--- stdout\n{_tail(p.stdout)}\n--- stderr\n{_tail(p.stderr)}")
    return {"exit": p.returncode, "seconds": took}


# -- subcommands ----------------------------------------------------------------------------------


def cmd_configure(a: argparse.Namespace) -> dict:
    path = os.path.join(a.hermes_home, "config.yaml")
    os.makedirs(a.hermes_home, exist_ok=True)
    if os.path.exists(path) and not os.path.exists(path + ".orig"):
        os.replace(path, path + ".orig")
    _atomic_write(path, MODEL_YAML.format(base_url=a.base_url))
    return {"configured": path, "baseUrl": a.base_url}


def cmd_activate(a: argparse.Namespace) -> dict:
    plugin = os.path.join(a.hermes_home, "plugins", a.provider)
    if not os.path.isfile(os.path.join(plugin, "__init__.py")) or not os.path.isfile(os.path.join(plugin, "plugin.yaml")):
        raise Failure(f"{plugin} is not an installed provider directory; it must exist before memory.provider names it (HM2-R17a)")
    path = os.path.join(a.hermes_home, "config.yaml")
    with open(path, encoding="utf-8", newline="") as f:
        before = f.read()
    with open(path + ".plur1bus-bak", "w", encoding="utf-8", newline="") as f:
        f.write(before)
    _atomic_write(path, set_memory_provider(before, a.provider))
    got = hermes_config_get(a.hermes, "memory.provider") if a.hermes else None
    if a.hermes and got != a.provider:
        raise Failure(f"hermes config get memory.provider says {got!r} after the edit, want {a.provider!r}")
    return {"memory.provider": got if a.hermes else a.provider}


def cmd_recall_budget(a: argparse.Namespace) -> dict:
    path = os.path.join(a.hermes_home, "plur1bus.json")
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    doc["recallHardMs"] = int(a.hard_ms)
    _atomic_write(path, json.dumps(doc, indent=2) + "\n")
    if os.name == "posix":
        os.chmod(path, 0o600)
    return {"recallHardMs": doc["recallHardMs"]}


def cmd_turns(a: argparse.Namespace) -> dict:
    with open(os.path.join(a.hermes_home, "plur1bus.json"), encoding="utf-8") as f:
        agent = json.load(f)["agentId"]
    summary: dict = {"agent": agent}
    if any(KEYWORD in t for t in memory_texts(a.plur1bus_bin, a.plur1bus_home, agent)):
        raise Failure(f"the store already holds {KEYWORD!r} before turn 1; not a fresh sidecar")
    summary["turn1"] = chat(a.hermes, FACT_PROMPT)
    end = time.monotonic() + CAPTURE_TIMEOUT_S
    texts: list[str] = []
    while time.monotonic() < end:
        texts = memory_texts(a.plur1bus_bin, a.plur1bus_home, agent)
        if any(KEYWORD in t for t in texts):
            break
        time.sleep(1.0)
    else:
        raise Failure(f"no memory with {KEYWORD!r} for {agent} within {CAPTURE_TIMEOUT_S} s after turn 1 (memories: {len(texts)})")
    summary["memories"] = len(texts)
    seen = len(stub_requests(a.stub_log))
    summary["turn2"] = chat(a.hermes, QUESTION)
    reqs = [r["request"] for r in stub_requests(a.stub_log)[seen:]]
    turn = [r for r in reqs if isinstance(r, dict) and r.get("stream") and QUESTION in json.dumps(r, ensure_ascii=False)]
    if not turn:
        raise Failure(f"the stub saw no streaming request carrying turn 2's question ({len(reqs)} request(s) after turn 1)")
    if not any(recalled_in(r) for r in turn):
        raise Failure(f"turn 2's request to the model carries no <memory-record> holding {KEYWORD!r}: prefetch did not reach the prompt")
    summary["recalledInTurn2"] = True
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("configure")
    c.add_argument("--hermes-home", required=True)
    c.add_argument("--base-url", required=True)
    c = sub.add_parser("activate")
    c.add_argument("--hermes-home", required=True)
    c.add_argument("--provider", default="plur1bus")
    c.add_argument("--hermes", default=None, help="verify with `hermes config get memory.provider --json`")
    c = sub.add_parser("recall-budget")
    c.add_argument("--hermes-home", required=True)
    c.add_argument("--hard-ms", type=int, required=True)
    c = sub.add_parser("turns")
    c.add_argument("--hermes", required=True)
    c.add_argument("--hermes-home", required=True)
    c.add_argument("--plur1bus-bin", required=True)
    c.add_argument("--plur1bus-home", required=True)
    c.add_argument("--stub-log", required=True)
    a = ap.parse_args(argv)
    fn = {"configure": cmd_configure, "activate": cmd_activate, "recall-budget": cmd_recall_budget, "turns": cmd_turns}[a.cmd]
    try:
        out = fn(a)
    except (Failure, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as e:
        print(f"drive_turn {a.cmd}: FAILED: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"cmd": a.cmd, "ok": True, **out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
