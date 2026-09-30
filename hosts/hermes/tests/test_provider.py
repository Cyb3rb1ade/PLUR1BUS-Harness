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
from tests.fake_client import SILENT, FakeError, Sandbox, capabilities, requires_posix, wait_until

import plur1bus
from plur1bus import Plur1busMemoryProvider, register
from plur1bus._client import pmc
from plur1bus.binding import BINDING_FILE
from plur1bus.mapping import SYSTEM_PROMPT_BLOCK, TOOL_METHODS, TRUNCATED_MARKER

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


@requires_posix
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
        self.assertEqual(q.system_prompt_block(), SYSTEM_PROMPT_BLOCK)
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
        self.assertEqual(p.journal.counts()["queued"], 1, "E_AGENT_UNKNOWN is fixable by bind: journaled (F5)")
        self.assertEqual(p.journal.last_error(), "E_AGENT_UNKNOWN")

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
        for ctx in ("cron", "subagent", "flush"):
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
        p._wait_for_sync(5)
        self.assertEqual(p.journal.counts()["queued"], 2)
        core.start()
        p.sync_turn("turn C question", "turn C answer")
        p._wait_for_sync(5)
        users = [c["messages"][0]["content"] for c in self.sb.captures()]
        self.assertEqual(users, ["turn A question", "turn B question", "turn C question"], "order preserved")
        self.assertEqual(p.journal.counts()["queued"], 0)

    def test_journal_is_replayed_after_a_successful_recall(self) -> None:
        self.sb.bind()
        core = self.sb.start_core()
        self.sb.stop_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        p.sync_turn("while the core was down", "noted")
        p._wait_for_sync(5)
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
        p._wait_for_sync(5)
        self.assertEqual(p.journal.counts(), {"queued": 0, "dropped": 0, "rejected": 1})

    def test_oversized_turn_is_trimmed_to_fit_one_rpc_line(self) -> None:
        self.sb.bind()
        self.sb.start_core()
        p = self.sb.provider()
        p.initialize("s", **self.sb.init_kwargs())
        huge = "x" * (5 * 1024 * 1024)
        p.sync_turn("summarise the log", huge)
        p._wait_for_sync(10)
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
            p._wait_for_sync(10)

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
        self.sb.bind()
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

    def test_forget_tool_calls_memory_forget_with_the_bound_agent(self) -> None:
        self.sb.bind("hermes-work")
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
        p._wait_for_sync(5)
        self.sb.stop_core()
        p.prefetch(secret_text + " again")
        p.sync_turn(secret_text + " (offline)", "noted")
        p._wait_for_sync(5)
        core.handlers["memory.capture"] = FakeError("E_INVALID_PARAMS", "bad")
        core.start()
        p.sync_turn(secret_text + " (refused)", "noted")
        p._wait_for_sync(5)
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
        p._wait_for_sync(5)
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


class HermesImportTest(unittest.TestCase):
    """Ruling F13: load the provider the way Hermes does (``plugins/memory/__init__.py`` @ ``743ee72``)."""

    def _install(self, vendored: bool) -> str:
        import tempfile

        root = tempfile.mkdtemp(prefix="p1h-imp-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        dest = os.path.join(root, "hermes-home", "plugins", "plur1bus")
        shutil.copytree(PROVIDER_DIR, dest, ignore=shutil.ignore_patterns("__pycache__"))
        if vendored:
            vend = os.path.join(dest, "_vendor")
            os.makedirs(vend)
            open(os.path.join(vend, "__init__.py"), "w").close()
            shutil.copytree(os.path.join(CLIENT_SRC, "plur1bus_memory_client"), os.path.join(vend, "plur1bus_memory_client"), ignore=shutil.ignore_patterns("__pycache__"))
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
