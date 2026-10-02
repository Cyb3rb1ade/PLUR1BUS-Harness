"""``hermes plur1bus status|selftest|bind`` (spec A.6, ruling F12).

Hermes imports only this file for ``hermes plur1bus ...`` (as ``<provider package>.cli``, without running
``__init__.py``), calls ``register_cli(subparser)`` and dispatches to ``plur1bus_command(args)``; the
command exists only while ``memory.provider`` is ``plur1bus`` (``docs/hermes/hermes-host-facts.md`` section (e)).
Nothing here imports Hermes.

JSON documents (``--json``, one line on stdout):

* ``plur1bus.hermes-status/1``: ``{schema, hermesHome, binding, bindingError, core, journal, lastError}``;
  exit 0.
* ``plur1bus.hermes-selftest/1``: ``{schema, ok, checks: [{id, ok, detail?}]}``; read-only (connect,
  ``core.status``, ``agent.status`` when advertised, one ``memory.recall``); exit 0 when ``ok``, else 1.
* ``plur1bus.hermes-bind/1``: ``{schema, ok, hermesHome, home, agentId, created, error?}``; exit 0/1.

Output carries codes, counts and paths, never message text or the core token.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from typing import Any

from ._client import pmc
from .binding import (
    Binding,
    BindingConflict,
    BindingInvalid,
    agent_id_for,
    check_binding,
    read_binding,
    register_binding,
    resolve_hermes_home,
    write_binding,
)
from .journal import CaptureJournal
from .mapping import caller_for

__all__ = [
    "BIND_SCHEMA",
    "SELFTEST_QUERY",
    "SELFTEST_SCHEMA",
    "STATUS_SCHEMA",
    "bind",
    "plur1bus_command",
    "register_cli",
    "selftest_doc",
    "status_doc",
]

STATUS_SCHEMA = "plur1bus.hermes-status/1"
SELFTEST_SCHEMA = "plur1bus.hermes-selftest/1"
BIND_SCHEMA = "plur1bus.hermes-bind/1"
SELFTEST_QUERY = "plur1bus selftest"
CALL_DEADLINE_S = 3.0
BIND_TIMEOUT_S = 60.0
INSTALLED_BY_BIND = "hermes-plur1bus-bind"

ClientFactory = Callable[[str], Any]


def _factory(home: str) -> Any:
    return pmc.MemoryClient(home)


def _code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else type(exc).__name__


def _binding_json(b: Binding | None) -> dict | None:
    if b is None:
        return None
    return {
        "home": b.home,
        "agentId": b.agent_id,
        "bin": b.bin,
        "capture": b.capture,
        "recallHardMs": b.recall_hard_ms,
        "version": b.version,
        "installedBy": b.installed_by,
    }


def _load(hermes_home: str) -> tuple[Binding | None, str | None]:
    try:
        b = read_binding(hermes_home)
    except BindingInvalid as e:
        return None, f"invalid: {e.reason}"
    return b, (None if b is not None else "missing")


# -- status ---------------------------------------------------------------------------------------


def status_doc(hermes_home: str, client_factory: ClientFactory | None = None) -> dict:
    b, binding_error = _load(hermes_home)
    journal = CaptureJournal.for_home(hermes_home)
    counts = journal.counts()
    core: dict = {"reachable": False, "rpc": None, "contract": None, "instanceId": None, "error": None}
    if b is None:
        core["error"] = "E_NO_BINDING"
    else:
        client = (client_factory or _factory)(b.home)
        try:
            hello = client.connect(deadline_s=CALL_DEADLINE_S)
            st = client.status(deadline_s=CALL_DEADLINE_S)
            core.update(
                reachable=True,
                rpc=st.get("rpc") or hello.get("rpc"),
                contract=st.get("contract") or hello.get("contract"),
                instanceId=st.get("instanceId") or hello.get("instanceId"),
            )
        except Exception as e:  # noqa: BLE001 - reported as a code
            core["error"] = _code(e)
        finally:
            client.close(deadline_s=1.0)
    return {
        "schema": STATUS_SCHEMA,
        "hermesHome": hermes_home,
        "binding": _binding_json(b),
        "bindingError": binding_error,
        "core": core,
        "journal": {"path": journal.path, **counts},
        "lastError": journal.last_error(),
    }


def _status_text(doc: dict) -> str:
    b = doc["binding"]
    core = doc["core"]
    j = doc["journal"]
    lines = [f"Hermes home: {doc['hermesHome']}"]
    if b is None:
        lines.append(f"Binding:     {doc['bindingError']} (run `hermes plur1bus bind`)")
    else:
        lines.append(f"Binding:     agent {b['agentId']} in {b['home']}")
    if core["reachable"]:
        lines.append(f"Core:        reachable (rpc {core['rpc']}, contract {core['contract']}, instance {core['instanceId']})")
    else:
        lines.append(f"Core:        unreachable ({core['error']})")
    lines.append(
        f"Journal:     {j['queued']} queued, {j['dropped']} dropped, {j['rejected']} rejected, {j['lost']} lost"
        f" ({j['path']})"
    )
    lines.append(f"Last error:  {doc['lastError'] or 'none'}")
    return "\n".join(lines)


# -- selftest -------------------------------------------------------------------------------------


def selftest_doc(hermes_home: str, client_factory: ClientFactory | None = None) -> dict:
    """Read-only: connect, ``core.status``, ``agent.status`` (when advertised), one ``memory.recall``."""
    checks: list[dict] = []

    def add(check_id: str, ok: bool, detail: str | None = None) -> None:
        item: dict = {"id": check_id, "ok": ok}
        if detail is not None:
            item["detail"] = detail
        checks.append(item)

    b, binding_error = _load(hermes_home)
    if b is None:
        add("binding", False, f"{binding_error}; run `hermes plur1bus bind`")
        for check_id in ("connect", "core.status", "agent.status", "memory.recall"):
            add(check_id, False, "not run")
        return {"schema": SELFTEST_SCHEMA, "ok": False, "checks": checks}
    add("binding", True, f"agent {b.agent_id}")
    client = (client_factory or _factory)(b.home)
    try:
        try:
            hello = client.connect(deadline_s=CALL_DEADLINE_S)
            add("connect", True, f"rpc {hello.get('rpc')}")
        except Exception as e:  # noqa: BLE001
            add("connect", False, _code(e))
            for check_id in ("core.status", "agent.status", "memory.recall"):
                add(check_id, False, "not run")
            return {"schema": SELFTEST_SCHEMA, "ok": False, "checks": checks}
        try:
            st = client.status(deadline_s=CALL_DEADLINE_S)
            state = (st.get("process") or {}).get("state") if isinstance(st, dict) else None
            add("core.status", True, f"process {state}" if state else None)
        except Exception as e:  # noqa: BLE001
            add("core.status", False, _code(e))
        if client.supports("agent.status"):
            try:
                client.agent_status(b.agent_id, deadline_s=CALL_DEADLINE_S)
                add("agent.status", True)
            except Exception as e:  # noqa: BLE001
                code = _code(e)
                add("agent.status", False, code + ("; run `hermes plur1bus bind`" if code == "E_AGENT_UNKNOWN" else ""))
        else:
            add("agent.status", True, "skipped: not advertised")
        try:
            result = client.recall(
                caller_for("cli", None, None),
                b.agent_id,
                SELFTEST_QUERY,
                hard_ms=b.recall_hard_ms,
                deadline_s=max(CALL_DEADLINE_S, b.recall_hard_ms / 1000.0 + 0.4),
            )
            blocks = result.get("blocks") if isinstance(result, dict) else None
            add("memory.recall", True, f"{len(blocks) if isinstance(blocks, list) else 0} block(s)")
        except Exception as e:  # noqa: BLE001
            code = _code(e)
            add("memory.recall", False, code + ("; run `hermes plur1bus bind`" if code == "E_AGENT_UNKNOWN" else ""))
    finally:
        client.close(deadline_s=1.0)
    return {"schema": SELFTEST_SCHEMA, "ok": all(c["ok"] for c in checks), "checks": checks}


def _selftest_text(doc: dict) -> str:
    lines = [f"{'ok  ' if c['ok'] else 'FAIL'} {c['id']}" + (f"  ({c['detail']})" if c.get("detail") else "") for c in doc["checks"]]
    lines.append("selftest passed" if doc["ok"] else "selftest failed")
    return "\n".join(lines)


# -- bind -----------------------------------------------------------------------------------------


def _default_plur1bus_home() -> str:
    return pmc.default_home(os.environ, sys.platform, os.path.expanduser("~"))


def bind(
    hermes_home: str,
    *,
    home: str | None = None,
    bin: str | None = None,  # noqa: A002
    version: str | None = None,
    installed_by: str | None = None,
    runner: Callable[..., Any] = subprocess.run,
) -> dict:
    """Derive the agent id, ``<bin> --home <home> --json agent create <id>`` (already exists is fine),
    ``register_binding``, ``write_binding``. Returns a ``plur1bus.hermes-bind/1`` document."""
    doc: dict = {"schema": BIND_SCHEMA, "ok": False, "hermesHome": hermes_home, "home": None, "agentId": None, "created": False}
    try:
        existing = read_binding(hermes_home)
    except BindingInvalid:
        existing = None  # rewritten below
    home = home or (existing.home if existing else None) or _default_plur1bus_home()
    home = os.path.abspath(home)
    exe = bin or (existing.bin if existing else None) or shutil.which("plur1bus")
    agent_id = agent_id_for(hermes_home)
    doc.update(home=home, agentId=agent_id)
    if not exe:
        doc["error"] = {"code": "E_NO_BINARY", "message": "plur1bus was not found on PATH; pass --bin"}
        return doc
    try:
        check_binding(home, agent_id, hermes_home)
    except BindingConflict as e:
        doc["error"] = {"code": "E_BINDING_CONFLICT", "message": str(e), "otherHome": e.other_home}
        return doc
    except BindingInvalid as e:
        doc["error"] = {"code": "E_REGISTRY_INVALID", "message": str(e)}
        return doc
    argv = [exe, "--home", home, "--json", "agent", "create", agent_id]
    try:
        proc = runner(argv, capture_output=True, text=True, timeout=BIND_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        doc["error"] = {"code": "E_AGENT_CREATE", "message": f"could not run plur1bus ({type(e).__name__})"}
        return doc
    try:
        out = json.loads((proc.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        out = {}
    if proc.returncode == 0 and out.get("schema") == "agent.create/1":
        doc["created"] = True
    elif out.get("schema") == "error/1" and (
        out.get("reason") == "agent-exists" or "already exists" in str(out.get("message", ""))
    ):
        # `plur1bus agent create` answers an existing agent with E_INVALID_PARAMS, reason "agent-exists"; the
        # message match is the fallback for binaries released before the reason existed.
        doc["created"] = False
    else:
        code = out.get("error") if isinstance(out.get("error"), str) else "E_AGENT_CREATE"
        doc["error"] = {"code": code, "message": str(out.get("message") or f"plur1bus exited {proc.returncode}")}
        return doc
    try:
        register_binding(home, agent_id, hermes_home)
        base = existing or Binding(home=home, agent_id=agent_id)
        write_binding(
            hermes_home,
            base.with_(
                home=home,
                agent_id=agent_id,
                bin=exe,
                version=version or base.version,
                installed_by=installed_by or base.installed_by or INSTALLED_BY_BIND,
            ),
        )
    except BindingConflict as e:
        doc["error"] = {"code": "E_BINDING_CONFLICT", "message": str(e), "otherHome": e.other_home}
        return doc
    except BindingInvalid as e:
        doc["error"] = {"code": "E_REGISTRY_INVALID", "message": str(e)}
        return doc
    except OSError as e:
        doc["error"] = {"code": "E_BINDING_WRITE", "message": f"could not write the binding or registry ({type(e).__name__})"}
        return doc
    doc["ok"] = True
    return doc


def _bind_text(doc: dict) -> str:
    if doc["ok"]:
        verb = "created and bound" if doc["created"] else "bound (agent already existed)"
        return f"agent {doc['agentId']} {verb} for {doc['hermesHome']}"
    return f"bind failed: {doc['error']['message']} ({doc['error']['code']})"


# -- argparse -------------------------------------------------------------------------------------


def register_cli(subparser: argparse.ArgumentParser) -> None:
    """Build ``hermes plur1bus ...`` on the parser Hermes hands over."""
    subs = subparser.add_subparsers(dest="plur1bus_action")
    for name, help_text in (
        ("status", "Show the binding, the core and the capture journal"),
        ("selftest", "Check the core connection and one recall (read-only)"),
        ("bind", "Create this Hermes home's agent in PLUR1BUS and write the binding"),
    ):
        p = subs.add_parser(name, help=help_text)
        p.add_argument("--json", action="store_true", help="print one JSON document")
        p.add_argument("--hermes-home", dest="plur1bus_hermes_home", default=None, help=argparse.SUPPRESS)
        if name == "bind":
            p.add_argument("--home", dest="plur1bus_home", default=None, help="the PLUR1BUS home (default: as plur1bus resolves it)")
            p.add_argument("--bin", dest="plur1bus_bin", default=None, help="the plur1bus binary (default: from PATH)")
    subparser.set_defaults(func=plur1bus_command)


def plur1bus_command(args: argparse.Namespace, *, client_factory: ClientFactory | None = None, runner: Callable[..., Any] | None = None) -> int:
    action = getattr(args, "plur1bus_action", None) or "status"
    hermes_home = resolve_hermes_home(getattr(args, "plur1bus_hermes_home", None), module_file=__file__)
    as_json = bool(getattr(args, "json", False))
    if action == "status":
        doc = status_doc(hermes_home, client_factory)
        text, rc = _status_text, 0
    elif action == "selftest":
        doc = selftest_doc(hermes_home, client_factory)
        text, rc = _selftest_text, (0 if doc["ok"] else 1)
    elif action == "bind":
        kw: dict = {"home": getattr(args, "plur1bus_home", None), "bin": getattr(args, "plur1bus_bin", None)}
        if runner is not None:
            kw["runner"] = runner
        doc = bind(hermes_home, **kw)
        text, rc = _bind_text, (0 if doc["ok"] else 1)
    else:  # pragma: no cover - argparse restricts the choices
        return 2
    print(json.dumps(doc, ensure_ascii=False) if as_json else text(doc))
    return rc
