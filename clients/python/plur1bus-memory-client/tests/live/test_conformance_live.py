"""Live RPC conformance (HM2-R3, Task 6): every client method once against a real core built from this checkout;
every request the client sends and every response line it reads validate against
``packages/rpc-schema/schema/rpc.schema.json``, every result against its method's result schema. Experimental
methods are called only when ``core.auth`` advertises them (HM2-R5). Needs ``PLUR1BUS_BIN``, ``PLUR1BUS_CORE_JS``
and ``jsonschema``; skipped with a printed reason otherwise. Tests key on error codes, never on message text.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

from tests import RPC_SCHEMA_DIR
from tests.live.stack import RECALL_HARD_MS, LiveStack, requirements

from plur1bus_memory_client import Caller, MemoryClient, RpcError
from plur1bus_memory_client.client import _default_factory

try:
    import jsonschema
except ImportError:  # pragma: no cover - reported as a skip
    jsonschema = None

AGENT = "hermes-default"
CALLER = Caller("hermes:cli", "local")
FACT = "Please remember that the harbour tour for the Lindqvist visit starts at nine from pier four."
SCHEMA_PATH = os.path.join(RPC_SCHEMA_DIR, "schema", "rpc.schema.json")


def _messages(text: str) -> list[dict]:
    return [{"role": "user", "content": text}, {"role": "assistant", "content": "Noted."}]


class _RecordingStream:
    """Delegates to the real transport and records every request sent and every line read."""

    def __init__(self, inner, rec: Recorder) -> None:
        self._inner, self._rec = inner, rec

    def send(self, data: bytes, deadline: float) -> None:
        self._rec.sent.append(json.loads(data))
        self._inner.send(data, deadline)

    def recv_line(self, deadline: float) -> bytes:
        line = self._inner.recv_line(deadline)
        self._rec.received.append(json.loads(line))
        return line

    def __getattr__(self, name: str):  # peer_pid, close, is_stale (when the transport has it)
        return getattr(self._inner, name)


class Recorder:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.received: list[dict] = []
        self._inner = _default_factory(sys.platform)

    def factory(self, address: str, *, connect_timeout: float):
        return _RecordingStream(self._inner(address, connect_timeout=connect_timeout), self)


@unittest.skipIf(
    jsonschema is None and os.environ.get("PLUR1BUS_LIVE_REQUIRED") != "1",
    "jsonschema not installed (pip install --require-hashes -r requirements-dev.txt)",
)
class ConformanceLiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        requirements()
        if jsonschema is None:
            raise AssertionError("PLUR1BUS_LIVE_REQUIRED=1 but jsonschema is not installed")
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            cls.schema = json.load(f)
        cls.stack = LiveStack(agents=(AGENT,)).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.stack.close()

    def setUp(self) -> None:
        self.rec = Recorder()
        self.client = MemoryClient(self.stack.home, transport_factory=self.rec.factory, call_timeout=10.0)
        self.addCleanup(self.client.close)

    # -- schema helpers ---------------------------------------------------------------------------

    def assert_valid(self, pointer: str, instance: object) -> None:
        root = {"$schema": self.schema["$schema"], "$defs": self.schema["$defs"], "$ref": pointer}
        errors = sorted(jsonschema.Draft202012Validator(root).iter_errors(instance), key=lambda e: list(e.path))
        # Paths and messages only: a core.auth request carries the token and must never reach a report.
        self.assertEqual([f"{list(e.path)}: {e.validator}" for e in errors], [], pointer)

    def assert_wire_conforms(self) -> None:
        """Every request (``Request`` + its method's params; core.auth params are not echoed) and every response
        line (``Response``) of this test, and every result against its method's result schema."""
        by_id = {}
        for req in self.rec.sent:
            with self.subTest(request=req["method"]):
                if req["method"] == "core.auth":
                    self.assertEqual(sorted(req["params"]), ["token"])
                else:
                    self.assert_valid("#/$defs/Request", req)
                    self.assert_valid(f"#/$defs/methods/{req['method']}/params", req["params"])
                by_id[req["id"]] = req["method"]
        for msg in self.rec.received:
            method = by_id.get(msg.get("id"), "?")
            with self.subTest(response=method):
                self.assert_valid("#/$defs/Response", msg)
                if "result" in msg:
                    self.assert_valid(f"#/$defs/methods/{method}/result", msg["result"])
        self.assertTrue(self.rec.received, "the core answered")

    # -- tests ------------------------------------------------------------------------------------

    def test_every_client_method_round_trips_and_validates_against_the_schema(self) -> None:
        c = self.client
        hello = c.connect()
        caps = hello.get("capabilities", {}).get("methods", {})
        self.assertIn("memory.recall", caps)
        self.assertIn("memory.capture", caps)
        called = {"core.auth"}

        self.assertIsInstance(c.status(), dict)
        called.add("core.status")
        cap = c.capture(CALLER, AGENT, _messages(FACT), session_key="conf-1", wait=True, deadline_s=30.0)
        self.assertGreaterEqual(cap.get("stored", 0), 1, cap)
        called.add("memory.capture")
        # wait=false returns the handle only
        handle = c.capture(CALLER, AGENT, _messages("Please remember that the archive room key is blue."), wait=False)
        self.assertIn("id", handle)
        rec = c.recall(CALLER, AGENT, "when does the harbour tour start", session_key="conf-2", hard_ms=RECALL_HARD_MS)
        self.assertIn("harbour tour", rec["joined"]["text"])
        called.add("memory.recall")

        if c.supports("agent.open"):
            c.agent_open(AGENT)
            called.add("agent.open")
        if c.supports("agent.status"):
            c.agent_status(AGENT)
            called.add("agent.status")
        ids: list[str] = []
        if c.supports("memory.list"):
            listed = c.memory_list(CALLER, AGENT, limit=20)
            ids = [i["id"] for i in listed.get("items", [])]
            self.assertTrue(ids, listed)
            c.memory_list(CALLER, AGENT, topic="harbour", limit=5)
            called.add("memory.list")
        if ids and c.supports("memory.show"):
            shown = c.memory_show(CALLER, AGENT, ids[0])
            self.assertEqual(shown["card"]["id"], ids[0])
            called.add("memory.show")
        corrected_id = ids[0] if ids else None
        if ids and c.supports("memory.correct"):
            corrected = c.memory_correct(CALLER, AGENT, ids[0], "The harbour tour for the Lindqvist visit starts at ten.")
            corrected_id = corrected.get("id", corrected_id)
            called.add("memory.correct")
        if corrected_id and c.supports("memory.share"):
            try:
                c.memory_share(CALLER, AGENT, corrected_id, "user")
            except RpcError as e:
                # An elevated Windows runner: the verified-path owner check refuses (engine ADR 0001, E4-R12).
                if sys.platform != "win32" or e.code not in ("E_STORAGE", "E_NOT_AVAILABLE"):
                    raise
            called.add("memory.share")
        if len(ids) > 1 and c.supports("memory.forget"):
            c.memory_forget(CALLER, AGENT, ids[-1])
            called.add("memory.forget")
        if c.supports("memory.checkpoint"):
            c.checkpoint(CALLER, AGENT, "manual")
            called.add("memory.checkpoint")
        if c.supports("agent.close"):
            c.agent_close(AGENT)
            called.add("agent.close")

        self.assert_wire_conforms()
        sent = {r["method"] for r in self.rec.sent}
        self.assertEqual(sent, called)
        # The stable turn path is always there (HM2-R5); report what the core advertised.
        print(f"live conformance: called {sorted(called)}", file=sys.stderr)

    def test_capture_then_recall_finds_the_memory(self) -> None:
        fact = "Please remember that the Okonkwo workshop moved to the east hall on level two."
        cap = self.client.capture(CALLER, AGENT, _messages(fact), session_key="cr-1", wait=True, deadline_s=30.0)
        self.assertGreaterEqual(cap.get("stored", 0), 1, cap)
        rec = self.client.recall(CALLER, AGENT, "where is the Okonkwo workshop", session_key="cr-2", hard_ms=RECALL_HARD_MS)
        self.assertIsNone(rec.get("degraded"), rec.get("degraded"))
        self.assertIn("east hall", rec["joined"]["text"])
        self.assert_wire_conforms()

    def test_core_restart_mid_session_recovers(self) -> None:
        """Review Focus 1: the supervisor restart rewrites run/core.token and run/core.pid; the next call re-reads
        both (S11 check included) and succeeds without a new client."""
        c = self.client
        c.recall(CALLER, AGENT, "anything about the harbour", session_key="rs-1", hard_ms=RECALL_HARD_MS)
        before = self.stack.token()
        instance = c.hello["instanceId"]
        self.stack.restart()
        self.assertNotEqual(self.stack.token(), before, "the restart wrote a new token")
        rec = c.recall(CALLER, AGENT, "anything about the harbour", session_key="rs-2", hard_ms=RECALL_HARD_MS)
        self.assertIsInstance(rec, dict)
        self.assertNotEqual(c.hello["instanceId"], instance, "the client re-authenticated against the new core")
        self.assert_wire_conforms()

    def test_unregistered_agent_is_E_AGENT_UNKNOWN(self) -> None:
        for call in (
            lambda: self.client.recall(CALLER, "hermes-never-bound", "where is the key", hard_ms=RECALL_HARD_MS),
            lambda: self.client.capture(CALLER, "hermes-never-bound", _messages("Please remember the key."), wait=True),
        ):
            with self.subTest(), self.assertRaises(RpcError) as cm:
                call()
            self.assertEqual(cm.exception.code, "E_AGENT_UNKNOWN")
        self.assert_wire_conforms()


if __name__ == "__main__":
    unittest.main()
