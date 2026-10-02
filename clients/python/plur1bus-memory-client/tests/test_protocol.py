import json
import os
import time
import unittest

from tests import RPC_SCHEMA_DIR

from plur1bus_memory_client import MAX_LINE, RpcError, decode_line, encode_request, parse_rpc_version, read_response, result_of


class ScriptedStream:
    """A Stream that replays lines and records what was sent."""

    def __init__(self, lines: list[bytes]) -> None:
        self.lines = list(lines)
        self.sent: list[bytes] = []

    def send(self, data: bytes, deadline: float) -> None:
        self.sent.append(data)

    def recv_line(self, deadline: float) -> bytes:
        if not self.lines:
            raise RpcError("E_TRANSPORT", "eof", {"reason": "eof"})
        return self.lines.pop(0)

    def peer_pid(self) -> int | None:
        return None

    def close(self) -> None:
        pass


def _line(obj: dict) -> bytes:
    return json.dumps(obj).encode("utf-8")


class ProtocolTest(unittest.TestCase):
    def test_a_line_over_4_mib_is_refused_before_sending(self) -> None:
        with self.assertRaises(RpcError) as cm:
            encode_request(1, "memory.capture", {"messages": [{"role": "user", "content": "x" * MAX_LINE}]})
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertEqual(cm.exception.reason, "line-too-long")
        self.assertNotIn("xxxx", str(cm.exception), "the error never carries request text")

    def test_a_line_just_under_the_limit_is_encoded(self) -> None:
        overhead = len(encode_request(7, "m", {"q": ""})) - 1
        line = encode_request(7, "m", {"q": "y" * (MAX_LINE - overhead)})
        self.assertEqual(len(line), MAX_LINE + 1)
        self.assertTrue(line.endswith(b"\n"))
        self.assertEqual(json.loads(line)["params"]["q"][:3], "yyy")

    def test_requests_are_utf8_ndjson(self) -> None:
        line = encode_request(3, "memory.recall", {"query": "Jürgen İ"})
        self.assertEqual(line.count(b"\n"), 1)
        self.assertIn("Jürgen İ".encode("utf-8"), line)
        self.assertEqual(json.loads(line), {"jsonrpc": "2.0", "id": 3, "method": "memory.recall", "params": {"query": "Jürgen İ"}})

    def test_error_response_maps_error_data_error_to_code(self) -> None:
        with open(os.path.join(RPC_SCHEMA_DIR, "fixtures", "errors", "E_AGENT_UNKNOWN.json"), "rb") as f:
            msg = decode_line(f.read())
        with self.assertRaises(RpcError) as cm:
            result_of(msg)
        self.assertEqual(cm.exception.code, "E_AGENT_UNKNOWN")
        self.assertEqual(cm.exception.reason, "not-registered")
        self.assertEqual(cm.exception.data["rpcCode"], -32000)

    def test_every_error_fixture_maps_to_its_code(self) -> None:
        d = os.path.join(RPC_SCHEMA_DIR, "fixtures", "errors")
        for name in sorted(os.listdir(d)):
            with self.subTest(name=name), open(os.path.join(d, name), "rb") as f:
                with self.assertRaises(RpcError) as cm:
                    result_of(decode_line(f.read()))
                self.assertEqual(cm.exception.code, name[:-5])

    def test_an_error_without_data_falls_back_to_the_numeric_code(self) -> None:
        with self.assertRaises(RpcError) as cm:
            result_of({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad"}})
        self.assertEqual(cm.exception.code, "E_INVALID_PARAMS")

    def test_ids_are_matched_and_notifications_skipped(self) -> None:
        stream = ScriptedStream(
            [
                _line({"jsonrpc": "2.0", "method": "core.state", "params": {"state": "ready"}}),
                _line({"jsonrpc": "2.0", "id": 4, "result": {"late": True}}),
                _line({"jsonrpc": "2.0", "id": 5, "result": {"ok": True}}),
                _line({"jsonrpc": "2.0", "id": 6, "result": {"next": True}}),
            ]
        )
        self.assertEqual(read_response(stream, 5, time.monotonic() + 1), {"ok": True})
        self.assertEqual(len(stream.lines), 1, "reading stops at the matching response")

    def test_an_error_with_a_null_id_is_raised(self) -> None:
        stream = ScriptedStream([_line({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})])
        with self.assertRaises(RpcError) as cm:
            read_response(stream, 1, time.monotonic() + 1)
        self.assertEqual(cm.exception.code, "E_PROTOCOL")

    def test_invalid_lines_are_protocol_errors(self) -> None:
        for raw in (b"{not json", b"[1,2]", b"\xff\xfe"):
            with self.subTest(raw=raw), self.assertRaises(RpcError) as cm:
                decode_line(raw)
            self.assertEqual(cm.exception.code, "E_PROTOCOL")

    def test_rpc_versions_parse(self) -> None:
        self.assertEqual(parse_rpc_version("1.4.0"), (1, 4, 0))
        for bad in (None, "1.4", "v1.4.0", "1.x.0", 140):
            with self.subTest(bad=bad), self.assertRaises(RpcError) as cm:
                parse_rpc_version(bad)
            self.assertEqual(cm.exception.code, "E_RPC_VERSION")


if __name__ == "__main__":
    unittest.main()
