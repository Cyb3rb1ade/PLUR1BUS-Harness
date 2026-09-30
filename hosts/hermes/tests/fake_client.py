"""Test sandbox: temp Hermes and PLUR1BUS homes, a binding, and the client suite's stub core.

Not a fake client (ruling F14): the provider runs the real ``MemoryClient`` against
``clients/python/plur1bus-memory-client/tests/fakes.py``'s ``FakeCore``, an NDJSON JSON-RPC server on
``<home>/run/core.sock`` that answers from ``packages/rpc-schema/fixtures/methods``.
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
requires_posix = unittest.skipUnless(POSIX_SOCKETS, "stub core needs a Unix socket")

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
        self.core = FakeCore(self.p1home, **kw).start()
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
