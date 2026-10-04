"""Test sandbox: temp Hermes and PLUR1BUS homes, a binding, and the client suite's stub core.

Not a fake client (ruling F14): the provider runs the real ``MemoryClient`` against the client suite's
stub cores, which answer from ``packages/rpc-schema/fixtures/methods``: ``tests/fakes.py``'s
``FakeCore`` (NDJSON JSON-RPC on ``<home>/run/core.sock``) on POSIX, and on Windows
``tests/fakes_win.py``'s ``FakePipeCore`` (a real overlapped ``CreateNamedPipeW`` server) behind
``WinCore``, which gives it the same test surface (capabilities, handlers, restart).
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import time
import unittest
from typing import Any

from tests import CLIENT_DIR
from plur1bus_memory_client import RPC_VERSION

_spec = importlib.util.spec_from_file_location("p1b_client_fakes", os.path.join(CLIENT_DIR, "tests", "fakes.py"))
fakes = importlib.util.module_from_spec(_spec)
sys.modules["p1b_client_fakes"] = fakes
_spec.loader.exec_module(fakes)

FakeCore = fakes.FakeCore
FakeError = fakes.FakeError
SILENT = fakes.SILENT
DROP = fakes.DROP
default_capabilities = fakes.default_capabilities

POSIX_SOCKETS = sys.platform != "win32" and hasattr(__import__("socket"), "AF_UNIX")
fakes_win: Any = None
if sys.platform == "win32":
    # fakes_win imports ``tests.fakes`` (the client suite's package name); point that at the copy loaded
    # above, since ``tests`` here is the provider suite.
    sys.modules.setdefault("tests.fakes", fakes)
    _wspec = importlib.util.spec_from_file_location("p1b_client_fakes_win", os.path.join(CLIENT_DIR, "tests", "fakes_win.py"))
    fakes_win = importlib.util.module_from_spec(_wspec)
    sys.modules["p1b_client_fakes_win"] = fakes_win
    _wspec.loader.exec_module(fakes_win)
HAS_STUB_CORE = POSIX_SOCKETS or fakes_win is not None
requires_core = unittest.skipUnless(HAS_STUB_CORE, "needs a stub core (Unix socket or Windows named pipe)")
requires_posix = requires_core  # kept for older call sites


class _Handlers(dict):
    """What ``Responder`` consults: the adapter's handlers first, then its own ``core.auth``."""

    def __init__(self, adapter: WinCore) -> None:
        super().__init__()
        self._a = adapter

    def get(self, key: object, default: object = None) -> object:
        if key in self._a.handlers:
            return self._a.handlers[key]
        if key == "core.auth":
            return self._a._auth
        return default


class WinCore:
    """``FakePipeCore`` with ``FakeCore``'s surface: ``capabilities``, ``handlers``, ``calls``,
    ``methods()``, ``token``, ``connections``, ``start()``/``stop()`` (restartable)."""

    def __init__(self, home: str, *, capabilities: dict | None = None, handlers: dict | None = None, **kw: Any) -> None:
        self.capabilities = capabilities if capabilities is not None else default_capabilities()
        self.handlers: dict = dict(handlers or {})
        self._core = fakes_win.FakePipeCore(home, **kw)
        self._core.responder.handlers = _Handlers(self)
        self.token = self._core.token

    def _auth(self, params: dict) -> Any:
        if params.get("token") != self.token:
            return FakeError("E_UNAUTHORIZED", "bad-token", "unauthorized")
        return {"contract": "1.4.1", "rpc": RPC_VERSION, "instanceId": "inst-fake", "pid": os.getpid(), "capabilities": self.capabilities}

    @property
    def calls(self) -> list:
        return self._core.calls

    @property
    def connections(self) -> int:
        return self._core.connections

    def methods(self) -> list[str]:
        return self._core.methods()

    def start(self) -> WinCore:
        self._core._ready.clear()
        self._core.error = None
        self._core.start()
        return self

    def stop(self) -> None:
        self._core.stop()


def new_core(home: str, **kw: Any) -> Any:
    if sys.platform == "win32":
        return WinCore(home, **kw)
    return FakeCore(home, **kw)

OPTIONAL_METHODS = (
    "agent.open",
    "agent.close",
    "agent.status",
    "memory.checkpoint",
    "memory.list",
    "memory.show",
    "memory.forget",
    "memory.correct",
    "memory.share",
)


def capabilities(*extra: str, all_optional: bool = False) -> dict:
    caps = default_capabilities()
    for m in OPTIONAL_METHODS if all_optional else extra:
        caps["methods"][m] = {"stability": "experimental", "since": "1.3.0"}
    return caps


class Sandbox:
    """``root/p`` is the PLUR1BUS home (short, for AF_UNIX), ``root/h`` the Hermes home."""

    def __init__(self, tc: unittest.TestCase, *, hermes_name: str = "h") -> None:
        from plur1bus.binding import Binding, write_binding

        self._Binding, self._write_binding = Binding, write_binding
        self.tc = tc
        self.root = tempfile.mkdtemp(prefix="p1h-")
        tc.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.p1home = os.path.join(self.root, "p")
        os.makedirs(self.p1home, mode=0o700)
        self.hermes_home = os.path.join(self.root, hermes_name)
        os.makedirs(self.hermes_home, mode=0o700)
        self.core: Any = None
        self.providers: list[Any] = []

    def bind(self, agent_id: str = "hermes-test", hermes_home: str | None = None, **kw: Any) -> Any:
        b = self._Binding(home=self.p1home, agent_id=agent_id, **kw)
        self._write_binding(hermes_home or self.hermes_home, b)
        return b

    def start_core(self, **kw: Any) -> Any:
        self.core = new_core(self.p1home, **kw).start()
        self.tc.addCleanup(self.core.stop)
        return self.core

    def stop_core(self) -> None:
        """Stop serving but leave run/core.token and run/core.pid behind (a crashed or stopped core)."""
        self.core.stop()

    def provider(self, hermes_home: str | None = None, **kw: Any) -> Any:
        from plur1bus import Plur1busMemoryProvider

        p = Plur1busMemoryProvider(hermes_home=hermes_home or self.hermes_home, **kw)
        self.providers.append(p)
        self.tc.addCleanup(p.shutdown)
        return p

    def init_kwargs(self, hermes_home: str | None = None, **kw: Any) -> dict:
        base = {"hermes_home": hermes_home or self.hermes_home, "platform": "cli", "agent_context": "primary", "agent_identity": "default"}
        base.update(kw)
        return base

    def captures(self) -> list[dict]:
        return [p for m, p in list(self.core.calls) if m == "memory.capture"]


def wait_until(pred: Any, timeout: float = 5.0, step: float = 0.01) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(step)
    return bool(pred())
