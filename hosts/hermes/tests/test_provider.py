import ast
import builtins
import importlib.machinery
import importlib.util
import io
import json
import logging
import os
import shutil
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from tests import CLIENT_SRC, PROVIDER_DIR
from tests.fake_client import SILENT, FakeError, Sandbox, capabilities, requires_core, wait_until

import plur1bus
from plur1bus import Plur1busMemoryProvider, register
from plur1bus._client import pmc
from plur1bus.binding import BINDING_FILE
from plur1bus.mapping import READ_ONLY_PROMPT_BLOCK, SYSTEM_PROMPT_BLOCK, TOOL_METHODS, TRUNCATED_MARKER, WRITE_TOOLS

RECALL_TEXT = "- The roadmap review is on Thursday."


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def text(self) -> str:
        out = []
        for r in self.records:
            out.append(r.getMessage())
            if r.exc_info:
                out.append(logging.Formatter().formatException(r.exc_info))
        return "\n".join(out)


def _capture_logs(tc: unittest.TestCase) -> _Records:
    h = _Records()
    root = logging.getLogger()
    old = root.level
    root.addHandler(h)
    root.setLevel(logging.DEBUG)
    tc.addCleanup(root.removeHandler, h)
    tc.addCleanup(root.setLevel, old)
    return h


def _warnings(h: _Records) -> list[str]:
    return [r.getMessage() for r in h.records if r.name == "plur1bus" and r.levelno >= logging.WARNING]


@requires_core
class ProviderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sb = Sandbox(self)

    # -- availability -----------------------------------------------------------------------------

    def test_is_available_checks_files_only_and_never_opens_the_pipe(self) -> None:
        calls = []

        def factory(home: str) -> None:
            calls.append(home)
            raise AssertionError("is_available must not build a client")

        p = self.sb.provider(client_factory=factory)
        self.assertFalse(p.is_available(), "no binding")
        self.assertIn("hermes plur1bus bind", p.unavailable_reason())
        self.sb.bind()
        self.assertFalse(p.is_available(), "binding but no run/core.token")
        self.assertIn("not running", p.unavailable_reason())
        core = self.sb.start_core()
        self.assertTrue(p.is_available())
        self.assertEqual(p.unavailable_reason(), "")
        self.assertEqual(calls, [])
        self.assertEqual(core.connections, 0, "nothing connected to the core")
        with open(os.path.join(self.sb.hermes_home, BINDING_FILE), "w") as f:
            f.write("{not json")
        self.assertFalse(p.is_available())
        self.assertIn("invalid", p.unavailable_reason())

    def test_name_config_schema_and_register(self) -> None:
        p = self.sb.provider()
        self.assertEqual(p.name, "plur1bus")
        self.assertEqual(p.get_config_schema(), [])
        self.assertIsNone(p.save_config({"x": 1}, self.sb.hermes_home))
        got = []

        class Ctx:
            def register_memory_provider(self, provider: object) -> None:
                got.append(provider)

        register(Ctx())
        self.assertEqual(len(got), 1)
        self.assertIsInstance(got[0], Plur1busMemoryProvider)

    # -- initialize and recall --------------------------------------------------------------------

    def test_initialize_uses_the_binding_agent_and_maps_the_caller(self) -> None:
        self.sb.bind("hermes-work")
        core = self.sb.start_core(capabilities=capabilities("agent.open"))
        p = self.sb.provider()
        p.initialize("sess-1", **self.sb.init_kwargs(platform="telegram", user_id="42", chat_id="c-9", gateway_session_key="gw-1"))
        self.assertEqual(p.prefetch("when is the roadmap review", session_id="sess-1"), RECALL_TEXT)
        opened = [prm for m, prm in core.calls if m == "agent.open"]
        self.assertEqual(opened, [{"agentId": "hermes-work"}])
        recall = [prm for m, prm in core.calls if m == "memory.recall"][-1]
        self.assertEqual(recall["caller"], {"channel": "cli", "accountId": "hermes:telegram", "userId": "42"})
        self.assertEqual(recall["agentId"], "hermes-work")
        self.assertEqual(recall["sessionKey"], "gw-1")
        self.assertEqual(recall["budget"], {"hardMs": 600})
        self.assertTrue(recall["joined"])

        q = self.sb.provider()
        q.initialize("sess-2", **self.sb.init_kwargs())
        q.prefetch("anything about the roadmap?")
        recall = [prm for m, prm in core.calls if m == "memory.recall"][-1]
        self.assertEqual(recall["caller"], {"channel": "cli", "accountId": "hermes:cli", "userId": "local"})
        self.assertEqual(recall["sessionKey"], "sess-2")
        self.assertEqual(q.system_prompt_block(), READ_ONLY_PROMPT_BLOCK, "write tools are off by default")
        self.assertEqual(q.system_prompt_block(), q.system_prompt_block(), "fixed text (HM2-R14)")

    def test_prefetch_returns_the_joined_text_within_the_deadline(self) -> None:
        self.sb.bind(recall_hard_ms=300)
        self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        t0 = time.monotonic()
        self.assertEqual(p.prefetch("when is the roadmap review"), RECALL_TEXT)
        self.assertLess(time.monotonic() - t0, 0.7)

    def test_prefetch_returns_empty_and_warns_once_when_the_core_is_down(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind()
        self.sb.start_core()
        self.sb.stop_core()  # token and pid stay behind, nobody serves
        seen = []
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(warning_callback=seen.append))
        for _ in range(2):
            t0 = time.monotonic()
            self.assertEqual(p.prefetch("what did we decide about the release"), "")
            self.assertLess(time.monotonic() - t0, 1.0)
        recall_warnings = [w for w in _warnings(logs) if "recall" in w]
        self.assertEqual(len(recall_warnings), 1, _warnings(logs))
        self.assertEqual(len([s for s in seen if "recall" in s]), 1)
        # A new session warns again, once.
        p.on_session_switch("s2")
        p.prefetch("and now?")
        p.prefetch("and now again?")
        self.assertEqual(len([w for w in _warnings(logs) if "recall" in w]), 2)

    def test_recall_total_time_is_bounded_when_the_core_is_silent(self) -> None:
        self.sb.bind(recall_hard_ms=200)
        self.sb.start_core(handlers={"memory.recall": SILENT})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        t0 = time.monotonic()
        self.assertEqual(p.prefetch("a question that never gets an answer"), "")
        self.assertLess(time.monotonic() - t0, 0.9, "hardMs 200 + 400 ms transport deadline")

    def test_initialize_and_session_end_budgets_hold_when_the_core_is_silent(self) -> None:
        self.sb.bind()
        core = self.sb.start_core(capabilities=capabilities(all_optional=True), handlers={"core.auth": SILENT})
        p = self.sb.provider()
        t0 = time.monotonic()
        p.initialize("s", **self.sb.init_kwargs())
        self.assertLess(time.monotonic() - t0, 1.3, "initialize budget 1 s (F14)")
        # Auth works now, but checkpoint and close hang: on_session_end still returns within 2 s.
        del core.handlers["core.auth"]
        core.handlers.update({"memory.checkpoint": SILENT, "agent.close": SILENT})
        p._rclient.connect(deadline_s=2.0)
        t0 = time.monotonic()
        p.on_session_end([])
        self.assertLess(time.monotonic() - t0, 2.4, "on_session_end budget 2 s (F14)")

    def test_trivial_prompt_skips_recall(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        for q in ("ok", "thanks!", "/help", "", "   "):
            self.assertEqual(p.prefetch(q), "")
        self.assertNotIn("memory.recall", core.methods())

    def test_agent_unknown_degrades_with_the_bind_hint(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind("hermes-ghost")
        self.sb.start_core(
            capabilities=capabilities("agent.open"),
            handlers={
                "agent.open": FakeError("E_AGENT_UNKNOWN", "unknown-agent"),
                "memory.recall": FakeError("E_AGENT_UNKNOWN", "unknown-agent"),
                "memory.capture": FakeError("E_AGENT_UNKNOWN", "unknown-agent"),
            },
        )
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(p.prefetch("what do you know about me"), "")
        p.sync_turn("remember that I like tea", "noted")
        p.on_session_end([])
        hints = [w for w in _warnings(logs) if "hermes plur1bus bind" in w]
        self.assertEqual(len(hints), 1, _warnings(logs))
        self.assertIn("hermes-ghost", hints[0])
        self.assertEqual(p.journal.counts()["queued"], 0, "E_AGENT_UNKNOWN is permanent for the queue (audit M3)")
        self.assertEqual(len(p.journal.dead_letters()), 1)
        self.assertTrue(wait_until(lambda: p.journal.last_error() == "E_AGENT_UNKNOWN", 3), "the worker persists the last error")

    def test_no_binding_leaves_the_provider_inert_with_one_warning(self) -> None:
        logs = _capture_logs(self)
        calls = []
        p = self.sb.provider(client_factory=lambda h: calls.append(h))
        p.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(p.prefetch("hello there, what is new"), "")
        p.sync_turn("a", "b")
        self.assertEqual(p.get_tool_schemas(), [])
        self.assertEqual(p.system_prompt_block(), "")
        self.assertEqual(p.on_pre_compress([]), "")
        p.on_session_end([])
        self.assertEqual(calls, [])
        self.assertEqual(len([w for w in _warnings(logs) if "no binding" in w]), 1)

    # -- capture ----------------------------------------------------------------------------------

    def test_sync_turn_is_non_blocking_and_uses_spawn_context_thread(self) -> None:
        self.sb.bind()

        def slow_capture(params: dict) -> dict:
            time.sleep(2.0)
            return {"id": "cap-slow", "acceptedAt": 1, "stored": 0, "skipped": 0}

        self.sb.start_core(handlers={"memory.capture": slow_capture})
        spawned = []
        real = plur1bus.spawn_context_thread

        def recording(target, *, name, daemon=True, args=(), kwargs=None):  # noqa: ANN001
            spawned.append(name)
            return real(target, name=name, daemon=daemon, args=args, kwargs=kwargs)

        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(plur1bus, "spawn_context_thread", recording):
            t0 = time.monotonic()
            p.sync_turn("the launch moved to May", "Got it, May.", session_id="s")
            self.assertLess(time.monotonic() - t0, 0.3)
        self.assertEqual(spawned, ["plur1bus-capture"])
        self.assertTrue(wait_until(lambda: len(self.sb.captures()) == 1, 3))
        cap = self.sb.captures()[0]
        self.assertEqual(cap["messages"], [{"role": "user", "content": "the launch moved to May"}, {"role": "assistant", "content": "Got it, May."}])
        self.assertIs(cap["wait"], False)
        self.assertEqual(cap["agentId"], "hermes-test")

    def test_sync_turn_is_skipped_for_cron_and_subagent(self) -> None:
        self.sb.bind()
        self.sb.start_core()
        for ctx in ("cron", "subagent", "flush", "some-future-context"):
            p = self.sb.provider()
            p.initialize("s", **self.sb.init_kwargs(agent_context=ctx))
            p.sync_turn("scheduled report text", "done")
            p.on_session_end([])
        self.sb.bind(capture=False)
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("do not store this", "ok")
        p.on_session_end([])
        time.sleep(0.1)
        self.assertEqual(self.sb.captures(), [])

    def test_failed_capture_is_journaled_and_replayed_on_the_next_success(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("turn A question", "turn A answer")
        p.sync_turn("turn B question", "turn B answer")
        p._wait_idle(5)
        self.assertEqual(p.journal.counts()["queued"], 2)
        core.start()
        p.sync_turn("turn C question", "turn C answer")
        p._wait_idle(5)
        users = [c["messages"][0]["content"] for c in self.sb.captures()]
        self.assertEqual(users, ["turn A question", "turn B question", "turn C question"], "order preserved")
        self.assertEqual(p.journal.counts()["queued"], 0)

    def test_each_turn_gets_a_run_id_that_its_journal_replay_repeats(self) -> None:
        """Ledger carry (T6 review, C2): the runId is minted per turn in sync_turn, journaled with the entry and
        sent unchanged on the replay, so the engine collapses a replay (duplicate-turn) but keeps a repeated turn."""
        self.sb.bind()
        core = self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("the same words", "the same answer")
        p.sync_turn("the same words", "the same answer")
        p._wait_idle(5)
        self.assertEqual(p.journal.counts()["queued"], 2)
        journaled = [json.loads(line)["runId"] for line in p.journal._read_lines()]
        self.assertEqual(len(set(journaled)), 2, "two identical turns, two run ids")
        self.assertTrue(all(isinstance(r, str) and r for r in journaled))
        core.start()
        self.assertEqual(p.prefetch("when is the roadmap review"), RECALL_TEXT)
        self.assertTrue(wait_until(lambda: p.journal.counts()["queued"] == 0, 3))
        self.assertEqual([c.get("runId") for c in self.sb.captures()], journaled, "the replay sends the journaled ids")
        p.sync_turn("a live turn", "answer")
        p._wait_idle(5)
        live = self.sb.captures()[-1]
        self.assertRegex(live.get("runId", ""), r"^[0-9a-f]{32}$")
        self.assertNotIn(live["runId"], journaled)

    def test_journal_is_replayed_after_a_successful_recall(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("while the core was down", "noted")
        p._wait_idle(5)
        self.assertEqual(p.journal.counts()["queued"], 1)
        core.start()
        self.assertEqual(p.prefetch("when is the roadmap review"), RECALL_TEXT)
        self.assertTrue(wait_until(lambda: p.journal.counts()["queued"] == 0, 3))
        self.assertEqual(len(self.sb.captures()), 1)

    def test_permanent_error_is_dropped_not_journaled(self) -> None:
        self.sb.bind()
        self.sb.start_core(handlers={"memory.capture": FakeError("E_INVALID_PARAMS", "bad")})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("a turn the core refuses", "answer")
        p._wait_idle(5)
        self.assertTrue(wait_until(lambda: p.journal.counts()["rejected"] == 1, 3))
        self.assertEqual(p.journal.counts(), {"queued": 0, "dropped": 0, "rejected": 1, "lost": 0})
        self.assertEqual([d["code"] for d in p.journal.dead_letters()], ["E_INVALID_PARAMS"], "kept aside, not lost")

    def test_an_unknown_agent_does_not_block_later_captures(self) -> None:
        """Audit M3: one E_AGENT_UNKNOWN capture used to sit at the head of the journal until 1000 newer turns pushed
        it out. Now it is set aside and the queue goes on, also across a replay."""
        self.sb.bind("hermes-ghost")
        core = self.sb.start_core(handlers={"memory.capture": FakeError("E_AGENT_UNKNOWN", "unknown-agent")})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("turn one", "a")
        p._wait_idle(5)
        self.assertEqual(p.journal.counts()["queued"], 0)
        del core.handlers["memory.capture"]  # the agent now exists
        p.sync_turn("turn two", "b")
        p._wait_idle(5)
        self.assertEqual([c["messages"][0]["content"] for c in self.sb.captures()][-1], "turn two")
        self.assertEqual(p.journal.counts()["queued"], 0)
        self.assertEqual(len(p.journal.dead_letters()), 1)

    def test_a_replayed_entry_for_another_agent_or_with_a_system_message_is_not_sent(self) -> None:
        self.sb.bind("hermes-work")
        self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(platform="telegram", user_id="42"))
        good = {"v": 1, "agentId": "hermes-work", "caller": p._caller.to_rpc(), "sessionKey": "s", "runId": "a1" * 16, "messages": [{"role": "user", "content": "legit turn"}]}
        p.journal.append(dict(good, agentId="hermes-victim", messages=[{"role": "user", "content": "foreign agent"}]))
        p.journal.append(dict(good, messages=[{"role": "system", "content": "injected instruction"}]))
        p.journal.append(dict(good, caller={"channel": "cli", "accountId": "root", "userId": "x"}))
        p.journal.append(good)
        p._queued = 4
        with p._cv:
            p._drain_wanted = True
        p._note_error(None, drain=True)
        self.assertTrue(wait_until(lambda: p.journal.counts()["queued"] == 0, 5))
        self.assertEqual([c["messages"][0]["content"] for c in self.sb.captures()], ["legit turn"])
        self.assertEqual({d["code"] for d in p.journal.dead_letters()}, {"E_JOURNAL_ENTRY"})
        self.assertEqual(len(p.journal.dead_letters()), 3)

    def test_oversized_turn_is_trimmed_to_fit_one_rpc_line(self) -> None:
        self.sb.bind()
        self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        huge = "x" * (5 * 1024 * 1024)
        p.sync_turn("summarise the log", huge)
        p._wait_idle(10)
        self.assertEqual(len(self.sb.captures()), 1, p.journal.counts())
        cap = self.sb.captures()[0]
        line = pmc.encode_request(99, "memory.capture", cap)
        self.assertLessEqual(len(line), 4 * 1024 * 1024)
        self.assertTrue(cap["messages"][-1]["content"].endswith(TRUNCATED_MARKER))
        self.assertEqual(cap["messages"][0]["content"], "summarise the log")

    def test_two_profiles_in_parallel_threads_capture_into_their_own_agents(self) -> None:
        home_a = os.path.join(self.sb.root, "ha")
        home_b = os.path.join(self.sb.root, "hb")
        os.makedirs(home_a)
        os.makedirs(home_b)
        self.sb.bind("hermes-default", hermes_home=home_a)
        self.sb.bind("hermes-work", hermes_home=home_b)
        self.sb.start_core()
        pa, pb = self.sb.provider(home_a), self.sb.provider(home_b)
        pa.initialize("sa", **self.sb.init_kwargs(home_a))
        pb.initialize("sb", **self.sb.init_kwargs(home_b))
        barrier = threading.Barrier(2)

        def run(p: Plur1busMemoryProvider, tag: str) -> None:
            barrier.wait()
            for i in range(10):
                p.sync_turn(f"{tag} question {i}", f"{tag} answer {i}")
                p.prefetch(f"{tag} what about item {i}")
            p._wait_idle(10)

        threads = [threading.Thread(target=run, args=(pa, "A")), threading.Thread(target=run, args=(pb, "B"))]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        caps = self.sb.captures()
        self.assertEqual(len(caps), 20)
        for c in caps:
            tag = c["messages"][0]["content"][0]
            self.assertEqual(c["agentId"], {"A": "hermes-default", "B": "hermes-work"}[tag])
        for tag in "AB":
            order = [c["messages"][0]["content"] for c in caps if c["messages"][0]["content"][0] == tag]
            self.assertEqual(order, [f"{tag} question {i}" for i in range(10)])

    # -- checkpoints and session end --------------------------------------------------------------

    def test_on_pre_compress_checkpoints_only_when_advertised(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(p.on_pre_compress([{"role": "user", "content": "x"}]), "")
        self.assertNotIn("memory.checkpoint", core.methods())
        core.capabilities = capabilities("memory.checkpoint")
        q = self.sb.provider()
        q.initialize("s", **self.sb.init_kwargs())
        q.sync_turn("before compaction", "ok")
        self.assertEqual(q.on_pre_compress([]), "")
        cps = [prm for m, prm in core.calls if m == "memory.checkpoint"]
        self.assertEqual([c["reason"] for c in cps], ["compaction"])
        methods = core.methods()
        self.assertLess(methods.index("memory.capture"), methods.index("memory.checkpoint"), "pending capture first")

    def test_on_session_end_flushes_checkpoints_and_closes(self) -> None:
        self.sb.bind()
        core = self.sb.start_core(capabilities=capabilities(all_optional=True))
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("last turn", "bye")
        p.on_session_end([])
        methods = [m for m in core.methods() if m in ("memory.capture", "memory.checkpoint", "agent.close")]
        self.assertEqual(methods, ["memory.capture", "memory.checkpoint", "agent.close"])
        cp = [prm for m, prm in core.calls if m == "memory.checkpoint"][0]
        self.assertEqual(cp["reason"], "session-end")
        self.assertEqual(cp["agentId"], "hermes-test")
        p.shutdown()
        self.assertIsNone(p._rclient._stream)

    # -- tools ------------------------------------------------------------------------------------

    def test_tools_are_offered_only_for_advertised_methods(self) -> None:
        self.sb.bind(memory_write_tools=True)
        core = self.sb.start_core()
        p = self.sb.provider()
        before = sorted(s["name"] for s in p.get_tool_schemas())
        self.assertEqual(before, sorted(TOOL_METHODS), "all tools for Hermes' routing table before initialize")
        p.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(p.get_tool_schemas(), [], "stable methods only: no D21 tool")
        self.assertEqual(json.loads(p.handle_tool_call("plur1bus_memory_list", {})), {"error": "E_NOT_AVAILABLE"})
        core.capabilities = capabilities("memory.list", "memory.forget")
        q = self.sb.provider()
        q.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(sorted(s["name"] for s in q.get_tool_schemas()), ["plur1bus_memory_forget", "plur1bus_memory_list"])
        self.assertEqual(json.loads(q.handle_tool_call("plur1bus_memory_share", {"id": "m-1", "target": "user"})), {"error": "E_NOT_AVAILABLE"})
        self.assertEqual(json.loads(q.handle_tool_call("no_such_tool", {})), {"error": "E_NOT_AVAILABLE"})
        listed = json.loads(q.handle_tool_call("plur1bus_memory_list", {"topic": "roadmap"}))
        self.assertEqual(listed["items"][0]["id"], "m-1")
        for s in q.get_tool_schemas():
            self.assertEqual(set(s), {"name", "description", "parameters"})

    def test_write_tools_are_off_unless_the_binding_enables_them(self) -> None:
        """Audit M2: the model cannot forget, rewrite or share on its own by default."""
        self.sb.bind("hermes-work")
        core = self.sb.start_core(capabilities=capabilities(all_optional=True))
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(platform="telegram", user_id="42"))
        offered = {s["name"] for s in p.get_tool_schemas()}
        self.assertEqual(offered, {"plur1bus_memory_list", "plur1bus_memory_show"})
        self.assertFalse(offered & WRITE_TOOLS)
        for tool, args in (
            ("plur1bus_memory_forget", {"id": "m-1"}),
            ("plur1bus_memory_correct", {"id": "m-1", "text": "x"}),
            ("plur1bus_memory_share", {"id": "m-1", "target": "workspace"}),
        ):
            self.assertEqual(json.loads(p.handle_tool_call(tool, args)), {"error": "E_DISABLED"}, tool)
        self.assertFalse([m for m, _ in core.calls if m in ("memory.forget", "memory.correct", "memory.share")], "nothing reached the core")
        self.assertIn("items", json.loads(p.handle_tool_call("plur1bus_memory_list", {})))
        # The routing table before initialize still names every tool; the call is what is refused.
        self.assertEqual(sorted(s["name"] for s in self.sb.provider().get_tool_schemas()), sorted(TOOL_METHODS))

    def test_a_platform_without_an_id_leaves_memory_off(self) -> None:
        """Audit M1: no sender id, no shared `local` identity: inert, one warning, no recall, no capture."""
        logs = _capture_logs(self)
        self.sb.bind()
        core = self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(platform="email"))
        self.assertEqual(p.system_prompt_block(), "")
        self.assertEqual(p.prefetch("when is the roadmap review"), "")
        p.sync_turn("a question from an unknown sender", "answer")
        self.assertEqual(p.get_tool_schemas(), [])
        self.assertEqual([m for m, _ in core.calls if m.startswith("memory.")], [])
        self.assertEqual(len([w for w in _warnings(logs) if "no user or chat id" in w]), 1)

    def test_claimed_platforms_use_the_claimed_namespace(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(platform="webhook", user_id="admin"))
        p.prefetch("when is the roadmap review")
        recall = [prm for m, prm in core.calls if m == "memory.recall"][-1]
        self.assertEqual(recall["caller"]["accountId"], "hermes:webhook:claimed")
        self.assertTrue(recall["caller"]["userId"].startswith("claimed-"))

    def test_forget_tool_calls_memory_forget_with_the_bound_agent(self) -> None:
        self.sb.bind("hermes-work", memory_write_tools=True)
        core = self.sb.start_core(capabilities=capabilities(all_optional=True))
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(platform="telegram", user_id="42"))
        out = json.loads(p.handle_tool_call("plur1bus_memory_forget", {"id": "m-1"}))
        self.assertEqual(out, {"id": "m-1", "archived": True, "tombstoneId": "t-1", "alreadyForgotten": False})
        params = [prm for m, prm in core.calls if m == "memory.forget"][0]
        self.assertEqual(params, {"caller": {"channel": "cli", "accountId": "hermes:telegram", "userId": "42"}, "agentId": "hermes-work", "id": "m-1"})
        self.assertEqual(json.loads(p.handle_tool_call("plur1bus_memory_forget", {})), {"error": "E_INVALID_PARAMS"})
        core.handlers["memory.forget"] = FakeError("E_NOT_FOUND", "no-memory")
        self.assertEqual(json.loads(p.handle_tool_call("plur1bus_memory_forget", {"id": "m-9"})), {"error": "E_NOT_FOUND"})
        out = json.loads(p.handle_tool_call("plur1bus_memory_correct", {"id": "m-1", "text": "The review is on Friday."}))
        self.assertIn("id", out)
        out = json.loads(p.handle_tool_call("plur1bus_memory_share", {"id": "m-1", "target": "workspace"}))
        self.assertIsInstance(out, dict)
        self.assertEqual(json.loads(p.handle_tool_call("plur1bus_memory_share", {"id": "m-1", "target": "everyone"})), {"error": "E_INVALID_PARAMS"})

    # -- secrets and text (F6) --------------------------------------------------------------------

    def test_nothing_logs_the_token_or_message_text(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind()
        core = self.sb.start_core(capabilities=capabilities(all_optional=True))
        token = core.token
        secret_text = "my locker code is 9-4-1-7 zebra"
        seen: list[str] = []
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs(warning_callback=seen.append))
        p.prefetch(secret_text)
        p.sync_turn(secret_text, "noted " + secret_text)
        p._wait_idle(5)
        self.sb.stop_core()
        p.prefetch(secret_text + " again")
        p.sync_turn(secret_text + " (offline)", "noted")
        p._wait_idle(5)
        core.handlers["memory.capture"] = FakeError("E_INVALID_PARAMS", "bad")
        core.start()
        p.sync_turn(secret_text + " (refused)", "noted")
        p._wait_idle(5)
        p.on_session_end([])
        from plur1bus.cli import selftest_doc, status_doc

        outputs = json.dumps([status_doc(self.sb.hermes_home), selftest_doc(self.sb.hermes_home)])
        everything = logs.text() + "\n".join(seen) + outputs
        self.assertTrue(logs.records, "the scenario produced log records")
        self.assertNotIn(token, everything)
        self.assertNotIn("9-4-1-7", everything)
        # No file the provider wrote holds the token; state.json holds no text either.
        jpath = p.journal.path
        for name in os.listdir(os.path.dirname(jpath)):
            with open(os.path.join(os.path.dirname(jpath), name), "rb") as f:
                self.assertNotIn(token.encode(), f.read())
        if os.path.exists(jpath) and os.name == "posix":
            self.assertEqual(os.stat(jpath).st_mode & 0o777, 0o600)
        state = os.path.join(os.path.dirname(jpath), "state.json")
        with open(state, encoding="utf-8") as f:
            self.assertNotIn("9-4-1-7", f.read())

    def test_journal_holds_text_only_in_a_0600_file(self) -> None:
        self.sb.bind()
        self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("offline secret 5-5-5", "ok")
        p._wait_idle(5)
        with open(p.journal.path, encoding="utf-8") as f:
            self.assertIn("offline secret 5-5-5", f.read())
        if os.name == "posix":
            self.assertEqual(os.stat(p.journal.path).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(os.path.dirname(p.journal.path)).st_mode & 0o777, 0o700)

    # -- F30: never reads .env or config.yaml -------------------------------------------------------

    def test_provider_never_reads_env_or_config_yaml(self) -> None:
        sentinel = "SENTINEL-7f3a-do-not-read"
        for name in (".env", "config.yaml"):
            with open(os.path.join(self.sb.hermes_home, name), "w") as f:
                f.write(f"KEY={sentinel}\nmemory:\n  provider: {sentinel}\n")
        self.sb.bind()
        self.sb.start_core(capabilities=capabilities(all_optional=True))
        opened: list[str] = []
        real_open, real_os_open = builtins.open, os.open

        def spy_open(file, *a, **kw):  # noqa: ANN001
            opened.append(os.fspath(file) if not isinstance(file, int) else "")
            return real_open(file, *a, **kw)

        def spy_os_open(path, *a, **kw):  # noqa: ANN001
            opened.append(os.fspath(path))
            return real_os_open(path, *a, **kw)

        logs = _capture_logs(self)
        buf = io.StringIO()
        with mock.patch("builtins.open", spy_open), mock.patch("os.open", spy_os_open), redirect_stdout(buf):
            p = self.sb.provider()
            p.is_available()
            p.unavailable_reason()
            p.initialize("s", **self.sb.init_kwargs())
            p.prefetch("tell me about the roadmap")
            p.sync_turn("q", "a")
            p.handle_tool_call("plur1bus_memory_list", {})
            p.on_pre_compress([])
            p.on_session_end([])
            p.shutdown()
            from plur1bus import cli

            for action in ("status", "selftest"):
                ns = type("NS", (), {"plur1bus_action": action, "json": True, "plur1bus_hermes_home": self.sb.hermes_home})()
                cli.plur1bus_command(ns)
        bad = [f for f in opened if os.path.basename(f) in (".env", "config.yaml")]
        self.assertEqual(bad, [])
        self.assertNotIn(sentinel, buf.getvalue() + logs.text())

    def test_source_names_neither_env_nor_config_yaml(self) -> None:
        for name in sorted(os.listdir(PROVIDER_DIR)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(PROVIDER_DIR, name), encoding="utf-8") as f:
                tree = ast.parse(f.read())
            docstrings = set()
            for node in ast.walk(tree):
                if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)):
                    ds = ast.get_docstring(node, clean=False)
                    if ds is not None:
                        docstrings.add(ds)
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value not in docstrings:
                    self.assertNotIn(".env", node.value, name)
                    self.assertNotIn("config.yaml", node.value, name)
                if isinstance(node, ast.ImportFrom) and node.level > 0:
                    continue  # sibling modules
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                    for m in mods:
                        top = m.split(".")[0]
                        self.assertIn(
                            top,
                            {"", "agent", "plur1bus_memory_client", "__future__", *sys.stdlib_module_names},
                            f"{name} imports {m}: runtime imports are the stdlib, the client and agent.memory_provider",
                        )


@requires_core
class RobustnessTest(unittest.TestCase):
    """T5 review: no journal I/O on hook paths, shutdown journals undelivered turns, one ordered worker."""

    def setUp(self) -> None:
        self.sb = Sandbox(self)

    def _hold_journal_lock(self):  # noqa: ANN202
        """Take the journal's OS lock on a separate descriptor, as another process would."""
        from plur1bus import _filelock

        d = os.path.join(self.sb.hermes_home, "plur1bus")
        os.makedirs(d, exist_ok=True)
        fd = os.open(os.path.join(d, ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        self.assertTrue(_filelock._try_lock(fd))

        held = [True]

        def release() -> None:
            if held[0]:
                held[0] = False
                _filelock._unlock(fd)
                os.close(fd)

        self.addCleanup(release)
        return release

    def _users(self, entries: list) -> list:
        return [e["messages"][0]["content"] for e in entries]

    def _journal_entries(self, p: Plur1busMemoryProvider) -> list:
        return [json.loads(line) for line in p.journal._read_lines()]

    def test_prefetch_stays_within_budget_when_the_journal_is_locked(self) -> None:
        from plur1bus.journal import CaptureJournal

        self.sb.bind(recall_hard_ms=300)
        core = self.sb.start_core()
        CaptureJournal.for_home(self.sb.hermes_home).append(
            {"v": 1, "agentId": "hermes-test", "caller": {"channel": "cli", "accountId": "hermes:cli", "userId": "local"}, "messages": [{"role": "user", "content": "left over"}]}
        )
        release = self._hold_journal_lock()
        p = self.sb.provider()
        t0 = time.monotonic()
        p.initialize("s", **self.sb.init_kwargs())
        self.assertLess(time.monotonic() - t0, 1.3)
        for _ in range(3):
            t0 = time.monotonic()
            self.assertEqual(p.prefetch("when is the roadmap review"), RECALL_TEXT)
            self.assertLess(time.monotonic() - t0, 0.7 + 0.3, "hardMs 300 + 400 ms, plus slack")
        t0 = time.monotonic()
        p.sync_turn("a turn while the journal is locked", "ok")
        self.assertLess(time.monotonic() - t0, 0.2)
        self.sb.stop_core()
        for _ in range(2):
            t0 = time.monotonic()
            self.assertEqual(p.prefetch("and while the core is down"), "")
            self.assertLess(time.monotonic() - t0, 1.0)
        core.start()
        release()
        p.prefetch("the next successful recall wakes the replay")
        self.assertTrue(wait_until(lambda: "left over" in self._users(self.sb.captures()), 15), "replayed once the lock is free")

    def test_slow_state_writes_do_not_delay_prefetch(self) -> None:
        from plur1bus import journal as journal_mod

        self.sb.bind(recall_hard_ms=300)
        self.sb.start_core(handlers={"memory.recall": FakeError("E_INTERNAL", "boom")})
        real = journal_mod.atomic_write_text

        def slow(*a, **kw):  # noqa: ANN002, ANN003
            time.sleep(1.5)
            return real(*a, **kw)

        p = self.sb.provider()
        with mock.patch.object(journal_mod, "atomic_write_text", slow):
            p.initialize("s", **self.sb.init_kwargs())
            for i in range(3):
                if i == 1:
                    del self.sb.core.handlers["memory.recall"]
                t0 = time.monotonic()
                p.prefetch("error state flips each time")
                self.assertLess(time.monotonic() - t0, 1.0)
            self.assertTrue(wait_until(lambda: p.journal.last_error() is None, 8))

    def test_shutdown_journals_captures_that_are_still_running(self) -> None:
        self.sb.bind()
        self.sb.start_core(handlers={"memory.capture": SILENT})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(plur1bus, "CAPTURE_DEADLINE_S", 30.0):
            p.sync_turn("turn one, in flight at exit", "a1")
            p.sync_turn("turn two, still queued", "a2")
            self.assertTrue(wait_until(lambda: len(self.sb.captures()) == 1, 3))
            t0 = time.monotonic()
            p.shutdown()
            self.assertLess(time.monotonic() - t0, 2.3, "shutdown budget 2 s")
        self.assertTrue(wait_until(lambda: len(self._journal_entries(p)) == 2, 3))
        self.assertEqual(self._users(self._journal_entries(p)), ["turn one, in flight at exit", "turn two, still queued"])
        self.assertEqual(p.lost, 0)

    def test_shutdown_counts_what_it_cannot_journal(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind()
        self.sb.start_core(handlers={"memory.capture": SILENT})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(plur1bus, "CAPTURE_DEADLINE_S", 30.0):
            p.sync_turn("in flight", "a1")
            p.sync_turn("queued", "a2")
            self.assertTrue(wait_until(lambda: len(self.sb.captures()) == 1, 3))
            self._hold_journal_lock()
            t0 = time.monotonic()
            p.shutdown()
            self.assertLess(time.monotonic() - t0, 2.3)
        self.assertTrue(wait_until(lambda: p.lost == 2, 12), p.lost)
        self.assertTrue(any("could not be journaled" in w for w in _warnings(logs)))
        self.assertNotIn("in flight", logs.text())

    def test_shutdown_stays_within_its_budget_when_the_journal_is_locked(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind()
        self.sb.start_core(handlers={"memory.capture": SILENT})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(plur1bus, "CAPTURE_DEADLINE_S", 30.0):
            p.sync_turn("in flight", "a1")
            p.sync_turn("queued", "a2")
            self.assertTrue(wait_until(lambda: len(self.sb.captures()) == 1, 3))
            self._hold_journal_lock()
            t0 = time.monotonic()
            p.shutdown()
            self.assertLess(time.monotonic() - t0, plur1bus.SHUTDOWN_BUDGET_S + 0.15)
        self.assertTrue(wait_until(lambda: p.lost == 2, 12), p.lost)
        self.assertTrue(any("could not be journaled" in w for w in _warnings(logs)))

    def test_a_journal_append_failure_in_the_worker_is_counted(self) -> None:
        logs = _capture_logs(self)
        self.sb.bind()
        self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(type(p.journal), "append", side_effect=OSError("disk full")):
            p.sync_turn("cannot be journaled", "ok")
            p._wait_idle(5)
        self.assertEqual(p.lost, 1)
        self.assertTrue(any("could not be journaled" in w for w in _warnings(logs)))

    def test_order_is_kept_when_a_capture_times_out(self) -> None:
        self.sb.bind()
        core = self.sb.start_core(handlers={"memory.capture": SILENT})
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        with mock.patch.object(plur1bus, "CAPTURE_DEADLINE_S", 0.3):
            for tag in "ABC":
                p.sync_turn(f"turn {tag}", "ok")
            self.assertTrue(p._wait_idle(10))
        self.assertEqual(self._users(self._journal_entries(p)), ["turn A", "turn B", "turn C"])
        del core.handlers["memory.capture"]
        p.sync_turn("turn D", "ok")
        self.assertTrue(p._wait_idle(10))
        self.assertEqual(self._users(self.sb.captures())[-4:], ["turn A", "turn B", "turn C", "turn D"])

    def test_tools_follow_the_core_once_it_is_reachable(self) -> None:
        self.sb.bind()
        core = self.sb.start_core(capabilities=capabilities("memory.list"))
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        self.assertEqual(p.get_tool_schemas(), [], "core down at initialize: no tools")
        core.start()
        self.assertEqual(p.prefetch("when is the roadmap review"), RECALL_TEXT)
        self.assertEqual([s["name"] for s in p.get_tool_schemas()], ["plur1bus_memory_list"], "offered again if Hermes re-asks")


class HermesImportTest(unittest.TestCase):
    """Ruling F13: load the provider the way Hermes does (``plugins/memory/__init__.py`` @ ``743ee72``)."""

    def _install(self, vendored: bool) -> str:
        import tempfile

        root = tempfile.mkdtemp(prefix="p1h-imp-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        dest = os.path.join(root, "hermes-home", "plugins", "plur1bus")
        shutil.copytree(PROVIDER_DIR, dest, ignore=shutil.ignore_patterns("__pycache__"), copy_function=shutil.copyfile)
        if vendored:
            vend = os.path.join(dest, "_vendor")
            os.makedirs(vend)
            open(os.path.join(vend, "__init__.py"), "w").close()
            shutil.copytree(os.path.join(CLIENT_SRC, "plur1bus_memory_client"), os.path.join(vend, "plur1bus_memory_client"), ignore=shutil.ignore_patterns("__pycache__"), copy_function=shutil.copyfile)
        return dest

    def _synthetic(self, name: str, locations: list[str]) -> None:
        spec = importlib.machinery.ModuleSpec(name, None, is_package=True)
        spec.submodule_search_locations = locations
        sys.modules[name] = importlib.util.module_from_spec(spec)
        self.addCleanup(sys.modules.pop, name, None)

    def _load_package(self, dest: str, tag: str) -> object:
        ns = f"_hermes_user_memory_{tag}"
        self._synthetic(ns, [])
        name = f"{ns}.plur1bus__source_{tag}"
        spec = importlib.util.spec_from_file_location(name, os.path.join(dest, "__init__.py"), submodule_search_locations=[dest])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        self.addCleanup(lambda: [sys.modules.pop(k) for k in list(sys.modules) if k.startswith(name)])
        spec.loader.exec_module(mod)
        return mod

    def test_directory_provider_imports_under_a_synthetic_package_name(self) -> None:
        dest = self._install(vendored=False)
        with open(os.path.join(dest, "__init__.py"), encoding="utf-8") as f:
            self.assertIn("MemoryProvider", f.read(8192), "Hermes' discovery heuristic")
        mod = self._load_package(dest, "dev")
        provider = mod.Plur1busMemoryProvider()
        self.assertEqual(provider.name, "plur1bus")
        self.assertFalse(mod._client.VENDORED)
        # Installed layout: the Hermes home is the parent of plugins/.
        self.assertEqual(mod.binding.resolve_hermes_home(module_file=os.path.join(dest, "__init__.py")), os.path.dirname(os.path.dirname(dest)))

    def test_vendored_client_is_used_when_present(self) -> None:
        dest = self._install(vendored=True)
        mod = self._load_package(dest, "vend")
        self.assertTrue(mod._client.VENDORED)
        self.assertTrue(mod._client.pmc.__name__.endswith("._vendor.plur1bus_memory_client"), mod._client.pmc.__name__)
        self.assertTrue(mod._client.pmc.__file__.startswith(dest))

    def test_cli_imports_without_running_the_provider_module(self) -> None:
        dest = self._install(vendored=True)
        ns = "_hermes_user_memory_cli"
        self._synthetic(ns, [])
        pkg = f"{ns}.plur1bus__source_cli"
        self._synthetic(pkg, [dest])
        name = pkg + ".cli"
        spec = importlib.util.spec_from_file_location(name, os.path.join(dest, "cli.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        self.addCleanup(lambda: [sys.modules.pop(k) for k in list(sys.modules) if k.startswith(pkg)])
        with mock.patch.dict(sys.modules, {"agent": None, "agent.memory_provider": None}):
            spec.loader.exec_module(mod)
        self.assertTrue(callable(mod.register_cli))
        self.assertTrue(callable(mod.plur1bus_command))
        self.assertNotIn(pkg + ".__init__", sys.modules)


if __name__ == "__main__":
    unittest.main()
