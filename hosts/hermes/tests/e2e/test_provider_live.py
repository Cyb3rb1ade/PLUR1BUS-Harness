"""The provider (under the stub ABC) against a real flat-embedder core (HM2 Task 6).

Needs ``PLUR1BUS_BIN`` and ``PLUR1BUS_CORE_JS`` (see ``clients/python/plur1bus-memory-client/tests/live``);
skipped with a printed reason otherwise, failed instead with ``PLUR1BUS_LIVE_REQUIRED=1``. Every test uses
its own temp Hermes home bound to the one shared temp PLUR1BUS home; nothing touches a real Hermes, home or
service manager. Tests key on error codes and counts, never on message text.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
import unittest

from tests.e2e import load_stack

from plur1bus import Plur1busMemoryProvider
from plur1bus.binding import Binding, write_binding
from plur1bus.journal import CaptureJournal

stack_mod = load_stack()

AGENT = "hermes-default"
#: A turn's capture reaches ``memory list`` within this (flat embedder; shared CI runners are slow).
SETTLE_S = 60.0


class _Warnings(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.name == "plur1bus":
            self.messages.append(record.getMessage())


def _texts(items: list[dict]) -> list[str]:
    out = []
    for it in items:
        for key in ("text", "content", "summary"):
            v = it.get(key)
            if isinstance(v, str):
                out.append(v)
                break
        else:
            out.append(repr(it))
    return out


class ProviderLiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = stack_mod.LiveStack(agents=(AGENT,), prefix="p1b-hl-").start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.stack.close()

    def setUp(self) -> None:
        self.hermes_home = os.path.realpath(tempfile.mkdtemp(prefix="p1b-hh-"))
        self.addCleanup(shutil.rmtree, self.hermes_home, ignore_errors=True)
        write_binding(self.hermes_home, Binding(home=self.stack.home, agent_id=AGENT, recall_hard_ms=stack_mod.RECALL_HARD_MS))
        self.warnings = _Warnings()
        log = logging.getLogger("plur1bus")
        log.addHandler(self.warnings)
        self.addCleanup(log.removeHandler, self.warnings)

    def provider(self, session: str) -> Plur1busMemoryProvider:
        p = Plur1busMemoryProvider(hermes_home=self.hermes_home)
        self.addCleanup(p.shutdown)
        p.initialize(session, hermes_home=self.hermes_home, platform="cli", agent_context="primary", agent_identity="default")
        return p

    def memories_with(self, needle: str) -> list[str]:
        return [t for t in _texts(self.stack.memories(AGENT)) if needle in t]

    def wait_memory(self, needle: str) -> list[str]:
        return stack_mod.wait_until(f"a memory containing {needle!r}", lambda: self.memories_with(needle), SETTLE_S, every=0.25)

    def settle(self, session: str) -> None:
        """Captures of one agent run in order on the core: a waited capture after them returns once they are done."""
        c = self.stack_client()
        r = c.capture(
            _caller(), AGENT,
            [{"role": "user", "content": f"Please remember that settle marker {session} is set."}, {"role": "assistant", "content": "Noted."}],
            session_key=f"settle-{session}", wait=True, deadline_s=60.0,
        )
        self.assertNotIn("pending", r, "the settle capture finished within its wait")

    def stack_client(self):  # noqa: ANN201
        from plur1bus._client import pmc

        c = pmc.MemoryClient(self.stack.home, call_timeout=60.0)
        self.addCleanup(c.close)
        return c

    # -- tests --------------------------------------------------------------------------------------

    def test_sync_turn_then_prefetch_recalls_it(self) -> None:
        p = self.provider("live-sess-1")
        self.assertTrue(p.is_available(), p.unavailable_reason())
        p.sync_turn("Please remember that the Varga field trip leaves from the north gate at seven.", "Noted.", session_id="live-sess-1")
        self.wait_memory("north gate")
        got = p.prefetch("where does the Varga field trip leave from", session_id="live-sess-1")
        self.assertIn("north gate", got)
        self.assertEqual(self.warnings.messages, [])
        self.assertEqual(p.journal.counts()["queued"], 0)

    def test_daemon_stop_degrades_and_journal_replays_after_start(self) -> None:
        """Review Focus 1: a stopped core never fails a turn (prefetch "" within its deadline, one warning per
        session); the turn goes to the journal and is replayed after the core is back."""
        p = self.provider("live-sess-2")
        p.prefetch("anything about the Varga trip", session_id="live-sess-2")  # connected and authenticated
        self.stack.stop()
        try:
            deadline_s = stack_mod.RECALL_HARD_MS / 1000.0 + 0.4
            for _ in range(2):
                t0 = time.monotonic()
                self.assertEqual(p.prefetch("where is the Brandt archive key kept", session_id="live-sess-2"), "")
                self.assertLess(time.monotonic() - t0, deadline_s + 1.0, "prefetch stayed within its deadline")
            recall_warnings = [m for m in self.warnings.messages if "recall" in m]
            self.assertEqual(len(recall_warnings), 1, self.warnings.messages)
            p.sync_turn("Please remember that the Brandt archive key is kept in the grey cabinet.", "Noted.", session_id="live-sess-2")
            journal = CaptureJournal.for_home(self.hermes_home)
            stack_mod.wait_until("the turn in the journal", lambda: journal.counts()["queued"] == 1, 30.0)
        finally:
            self.stack.start_again()
        self.assertEqual(self.memories_with("grey cabinet"), [], "nothing was stored while the core was down")
        # The next successful call replays the journal (HM2-R13).
        p.prefetch("where is the Brandt archive key kept", session_id="live-sess-2")
        stack_mod.wait_until("the journal replayed", lambda: journal.counts()["queued"] == 0, 30.0)
        self.assertEqual(len(self.wait_memory("grey cabinet")), 1)
        self.assertIn("grey cabinet", p.prefetch("where is the Brandt archive key kept", session_id="live-sess-2"))

    def test_journal_replay_after_a_crash_mid_batch_stores_the_turn_once(self) -> None:
        """Ledger carry (T5 review): the journal replays at least once, so a process that dies after sending a
        batch but before rewriting the file sends that batch again. ``memory.capture`` is idempotent for a
        byte-identical turn: the engine's turn replay guard (E4 Q3, keyed on agent, runId, sessionKey and
        messages) answers ``duplicate-turn``. The stack runs with ``engine.duplicateThreshold = 1.01``, so the
        vector dedup is off and only that guard can prevent the second row."""
        p = self.provider("live-sess-3")
        journal = CaptureJournal.for_home(self.hermes_home)
        entry = {
            "v": 1, "agentId": AGENT, "caller": _caller().to_rpc(), "sessionKey": "live-sess-3",
            "messages": [{"role": "user", "content": "Please remember that the Iwu lab badge is renewed every March."}, {"role": "assistant", "content": "Noted."}],
        }
        journal.append(dict(entry))

        class Crash(BaseException):
            """Stands in for the process dying: not an Exception, so drain() neither classifies nor rewrites."""

        def send_then_die(e: dict) -> None:
            p._send_entry(e)
            raise Crash()

        with self.assertRaises(Crash):
            journal.drain(send_then_die)
        self.assertEqual(journal.counts()["queued"], 1, "the batch was sent but the file still holds it")
        self.assertEqual(journal.drain(p._send_entry), 1, "the next process replays it")
        self.assertEqual(journal.counts()["queued"], 0)
        self.settle("live-sess-3")
        self.assertEqual(len(self.wait_memory("Iwu lab badge")), 1, "the replayed turn is stored once")
        # The verdict itself, over the RPC: a third, waited delivery of the same turn is a duplicate.
        r = self.stack_client().capture(_caller(), AGENT, entry["messages"], session_key="live-sess-3", wait=True, deadline_s=60.0)
        self.assertEqual(r.get("reason"), "duplicate-turn", r)
        self.assertEqual(len(self.memories_with("Iwu lab badge")), 1)


def _caller():  # noqa: ANN202
    from plur1bus._client import pmc

    return pmc.Caller("hermes:cli", "local")


if __name__ == "__main__":
    unittest.main()
