"""Offline conformance (HM2-R3): every request the client builds and every fixture it consumes validates
against packages/rpc-schema/schema/rpc.schema.json. Needs ``jsonschema`` (requirements-dev.txt)."""

import hashlib
import json
import os
import shutil
import tempfile
import unittest

from tests import RPC_SCHEMA_DIR

from plur1bus_memory_client import METHODS, RPC_VERSION, SCHEMA_SHA256, Caller, MemoryClient, RpcError

try:
    import jsonschema
except ImportError:  # pragma: no cover - reported as a skip
    jsonschema = None

SCHEMA_PATH = os.path.join(RPC_SCHEMA_DIR, "schema", "rpc.schema.json")
FIXTURES = os.path.join(RPC_SCHEMA_DIR, "fixtures", "methods")
CALLER = Caller("hermes:telegram", "42")
TOKEN = "0" * 64  # test-only

# Every method a public MemoryClient method sends.
CLIENT_METHODS = [
    "core.auth",
    "core.status",
    "memory.recall",
    "memory.capture",
    "memory.checkpoint",
    "agent.open",
    "agent.close",
    "agent.status",
    "memory.list",
    "memory.show",
    "memory.forget",
    "memory.correct",
    "memory.share",
]


def _schema() -> dict:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


def _fixture(method: str) -> dict:
    with open(os.path.join(FIXTURES, method + ".json"), encoding="utf-8") as f:
        return json.load(f)


class RecordingStream:
    """Answers each request with its method's fixture result (core.auth: a hello at the schema's rpc)."""

    def __init__(self, sent: list[dict]) -> None:
        self.sent = sent
        self.pending: list[bytes] = []

    def send(self, data: bytes, deadline: float) -> None:
        req = json.loads(data)
        self.sent.append(req)
        if req["method"] == "core.auth":
            result = dict(_fixture("core.auth")["result"], rpc=RPC_VERSION)
            result["capabilities"] = {"methods": {m: {"stability": "stable", "since": "1.0.0"} for m in CLIENT_METHODS}}
        else:
            result = _fixture(req["method"])["result"]
        self.pending.append(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}).encode())

    def recv_line(self, deadline: float) -> bytes:
        return self.pending.pop(0)

    def peer_pid(self) -> int | None:
        return None

    def close(self) -> None:
        pass


@unittest.skipIf(jsonschema is None, "jsonschema not installed (pip install --require-hashes -r requirements-dev.txt)")
class ConformanceOfflineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = _schema()

    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        os.makedirs(os.path.join(self.home, "run"), mode=0o700)
        os.chmod(os.path.join(self.home, "run"), 0o700)
        with open(os.path.join(self.home, "run", "core.token"), "w") as f:
            f.write(TOKEN)
        self.sent: list[dict] = []
        self.client = MemoryClient(
            self.home, transport_factory=lambda address, *, connect_timeout: RecordingStream(self.sent)
        )
        self.addCleanup(self.client.close)

    def validator(self, pointer: str):
        root = {"$schema": self.schema["$schema"], "$defs": self.schema["$defs"], "$ref": pointer}
        return jsonschema.Draft202012Validator(root)

    def assert_valid(self, pointer: str, instance: object) -> None:
        errors = sorted(self.validator(pointer).iter_errors(instance), key=lambda e: list(e.path))
        self.assertEqual([f"{list(e.path)}: {e.message}" for e in errors], [], pointer)

    def call_everything(self) -> dict[str, object]:
        c = self.client
        return {
            "core.status": c.status(),
            "memory.recall": c.recall(CALLER, "hermes-default", "when is the review", session_key="s1", hard_ms=600),
            "memory.capture": c.capture(
                CALLER,
                "hermes-default",
                [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
                session_key="s1",
                run_id="r1",
            ),
            "memory.capture(wait)": c.capture(CALLER, "hermes-default", [{"role": "user", "content": "x"}], wait=True),
            "memory.checkpoint": c.checkpoint(CALLER, "hermes-default", "compaction"),
            "agent.open": c.agent_open("hermes-default"),
            "agent.close": c.agent_close("hermes-default"),
            "agent.status": c.agent_status("hermes-default"),
            "memory.list": c.memory_list(CALLER, "hermes-default", topic="review", limit=5),
            "memory.list(bare)": c.memory_list(CALLER, "hermes-default"),
            "memory.show": c.memory_show(CALLER, "hermes-default", "m1"),
            "memory.forget": c.memory_forget(CALLER, "hermes-default", "m1"),
            "memory.correct": c.memory_correct(CALLER, "hermes-default", "m1", "corrected"),
            "memory.share": c.memory_share(CALLER, "hermes-default", "m1", "workspace", allow_sensitive=True),
        }

    def test_every_request_the_client_builds_validates_against_the_schema(self) -> None:
        self.call_everything()
        seen = set()
        for req in self.sent:
            with self.subTest(method=req["method"]):
                self.assert_valid("#/$defs/Request", req)
                self.assert_valid(f"#/$defs/methods/{req['method']}/params", req["params"])
                seen.add(req["method"])
        self.assertEqual(seen, set(CLIENT_METHODS))

    def test_every_fixture_result_validates_and_parses(self) -> None:
        results = self.call_everything()
        for method in CLIENT_METHODS:
            fx = _fixture(method)
            with self.subTest(method=method):
                self.assert_valid(f"#/$defs/methods/{method}/params", fx["params"])
                self.assert_valid(f"#/$defs/methods/{method}/result", fx["result"])
                if method != "core.auth":
                    self.assertEqual(results[method], fx["result"], "the client returns the result unchanged")
        self.assertEqual(self.client.hello["instanceId"], _fixture("core.auth")["result"]["instanceId"])

    def test_error_fixtures_validate_as_responses(self) -> None:
        d = os.path.join(RPC_SCHEMA_DIR, "fixtures", "errors")
        for name in sorted(os.listdir(d)):
            with self.subTest(name=name), open(os.path.join(d, name), encoding="utf-8") as f:
                self.assert_valid("#/$defs/Response", json.load(f))

    def test_client_methods_exist_with_expected_stability(self) -> None:
        for method in CLIENT_METHODS:
            with self.subTest(method=method):
                self.assertIn(method, METHODS)
                self.assertEqual(METHODS[method][0], "core")
        self.assertEqual(METHODS["memory.recall"][1], "stable")
        self.assertEqual(METHODS["memory.capture"][1], "stable")
        self.assertEqual(METHODS["core.auth"][1], "stable")
        self.assertEqual(METHODS["core.status"][1], "stable")

    def test_the_recorded_auth_request_carries_the_token_only_in_the_request(self) -> None:
        self.client.connect()
        self.assertEqual(self.sent[0], {"jsonrpc": "2.0", "id": 1, "method": "core.auth", "params": {"token": TOKEN}})
        self.assertNotIn(TOKEN, json.dumps(self.client.hello))

    def test_a_request_over_the_line_limit_is_never_sent(self) -> None:
        self.client.connect()
        before = len(self.sent)
        big = [{"role": "user", "content": "z" * (4 * 1024 * 1024)}]
        with self.assertRaises(RpcError) as cm:
            self.client.capture(CALLER, "hermes-default", big)
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertEqual(len(self.sent), before)


class MemoryListParamsTest(unittest.TestCase):
    """The core takes exactly one of topic and since (E_INVALID_PARAMS topic-xor-since, found by the live run)."""

    def test_memory_list_sends_exactly_one_of_topic_and_since(self) -> None:
        home = tempfile.mkdtemp(prefix="p1b-")
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        os.makedirs(os.path.join(home, "run"), mode=0o700)
        os.chmod(os.path.join(home, "run"), 0o700)
        with open(os.path.join(home, "run", "core.token"), "w") as f:
            f.write(TOKEN)
        sent: list[dict] = []
        client = MemoryClient(home, transport_factory=lambda address, *, connect_timeout: RecordingStream(sent))
        self.addCleanup(client.close)
        client.memory_list(CALLER, "hermes-default")
        client.memory_list(CALLER, "hermes-default", topic="review")
        client.memory_list(CALLER, "hermes-default", since=1700000000000, limit=3)
        lists = [r["params"] for r in sent if r["method"] == "memory.list"]
        self.assertEqual([("topic" in p, p.get("since")) for p in lists], [(False, 0), (True, None), (False, 1700000000000)])
        with self.assertRaises(ValueError):
            client.memory_list(CALLER, "hermes-default", topic="review", since=5)
        self.assertEqual(len([r for r in sent if r["method"] == "memory.list"]), 3, "nothing sent for topic plus since")


class GeneratedSchemaTest(unittest.TestCase):
    """Needs no dev dependency, so the stale-_schema.py guard runs on every interpreter."""

    def test_generated_schema_module_is_fresh(self) -> None:
        with open(SCHEMA_PATH, "rb") as f:
            raw = f.read().replace(b"\r\n", b"\n")
        self.assertEqual(SCHEMA_SHA256, hashlib.sha256(raw).hexdigest(), "run `pnpm gen`")
        schema = json.loads(raw)
        self.assertEqual(RPC_VERSION, schema["x-rpc-version"])
        expected = {
            name: (d["x-server"], d["x-stability"], d["x-since"]) for name, d in schema["$defs"]["methods"].items()
        }
        self.assertEqual(METHODS, expected)


if __name__ == "__main__":
    unittest.main()
