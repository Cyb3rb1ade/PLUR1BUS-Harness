"""NDJSON JSON-RPC 2.0 framing of the core RPC (docs/rpc.md): one JSON value per line, at most 4 MiB.

No I/O here except :func:`read_response`, which reads lines from a transport ``Stream``
(``send(data, deadline)``, ``recv_line(deadline)``, ``peer_pid()``, ``close()``), and :func:`read_line`,
the line framing both transports share over their own chunk reader.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any, Protocol

__all__ = [
    "MAX_LINE",
    "CLIENT_ERROR_CODES",
    "TRANSPORT_CODES",
    "RpcError",
    "Stream",
    "encode_request",
    "decode_line",
    "result_of",
    "read_response",
    "parse_rpc_version",
    "remaining",
    "take_line",
    "read_line",
]

#: Maximum bytes in one NDJSON line, newline not counted (crates/plur1bus-rpc/src/client.rs ``MAX_LINE``).
MAX_LINE: int = 4 * 1024 * 1024

#: Codes the client raises itself; every other code comes from ``error.data.error`` of a response.
CLIENT_ERROR_CODES = frozenset(
    {"E_TRANSPORT", "E_TIMEOUT", "E_SERVER_IDENTITY", "E_PROTOCOL", "E_RPC_VERSION", "E_CORE_UNAVAILABLE"}
)
#: The failures that say nothing about the request itself (the core was not reached or did not answer).
TRANSPORT_CODES = frozenset({"E_TRANSPORT", "E_TIMEOUT", "E_CORE_UNAVAILABLE", "E_SERVER_IDENTITY"})

# JSON-RPC numeric codes without an ``error.data.error`` (a server bug or a pre-dispatch refusal).
_NUMERIC = {-32700: "E_PROTOCOL", -32600: "E_PROTOCOL", -32601: "E_NOT_AVAILABLE", -32602: "E_INVALID_PARAMS"}


class RpcError(Exception):
    """A failed call. ``code`` is an ``E_*`` string; ``data`` the response's ``error.data`` (or client detail).

    Messages never carry the core token or request text.
    """

    def __init__(self, code: str, message: str = "", data: dict | None = None) -> None:
        self.code = code
        self.message = message or code
        self.data = dict(data or {})
        super().__init__(f"{code}: {self.message}")

    @property
    def reason(self) -> str | None:
        r = self.data.get("reason")
        return r if isinstance(r, str) else None

    def __repr__(self) -> str:
        return f"RpcError({self.code!r}, {self.message!r})"


class Stream(Protocol):
    """The transport contract (``transport_posix.open_stream``, ``transport_win.open_stream``).

    ``deadline`` values are ``time.monotonic()`` instants.
    """

    def send(self, data: bytes, deadline: float) -> None: ...

    def recv_line(self, deadline: float) -> bytes: ...

    def peer_pid(self) -> int | None: ...

    def close(self) -> None: ...


def remaining(deadline: float) -> float:
    """Seconds left until the monotonic ``deadline``; ``RpcError("E_TIMEOUT")`` once it has passed."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise RpcError("E_TIMEOUT", "the call deadline passed", {"reason": "deadline"})
    return left


def _line_too_long() -> RpcError:
    return RpcError("E_PROTOCOL", "response line exceeds the limit", {"reason": "line-too-long"})


def take_line(buf: bytearray) -> bytes | None:
    """Remove and return the first complete line of ``buf`` (without ``LF``/``CRLF``), or ``None`` when no
    ``LF`` has arrived yet. Both oversize cases are ``RpcError("E_PROTOCOL", reason "line-too-long")``: a
    complete line over ``MAX_LINE``, and an unterminated buffer already past ``MAX_LINE`` (so a reader stops
    at ``MAX_LINE`` plus one chunk). Shared by every transport."""
    nl = buf.find(b"\n")
    if nl >= 0:
        line = bytes(buf[:nl])
        del buf[: nl + 1]
        if len(line) > MAX_LINE:
            raise _line_too_long()
        return line.rstrip(b"\r")
    if len(buf) > MAX_LINE:
        raise _line_too_long()
    return None


def read_line(buf: bytearray, read_chunk: Callable[[], bytes]) -> bytes:
    """The next line from ``buf``, refilled by ``read_chunk()`` (at least one byte, or ``b""`` at the end
    of the stream, which is ``RpcError("E_TRANSPORT", reason "eof")``). ``read_chunk`` enforces the
    deadline itself. Bytes after the returned line stay in ``buf``."""
    while True:
        line = take_line(buf)
        if line is not None:
            return line
        chunk = read_chunk()
        if not chunk:
            raise RpcError("E_TRANSPORT", "the core closed the connection", {"reason": "eof"})
        buf += chunk


def encode_request(req_id: int, method: str, params: dict) -> bytes:
    """One request line (UTF-8, LF-terminated). Raises ``RpcError("E_PROTOCOL")`` over ``MAX_LINE``."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(body) > MAX_LINE:
        raise RpcError(
            "E_PROTOCOL",
            f"request line of {len(body)} bytes exceeds the {MAX_LINE}-byte limit",
            {"reason": "line-too-long", "bytes": len(body)},
        )
    return body + b"\n"


def decode_line(line: bytes) -> dict:
    """Parse one received line (without or with its newline). Raises ``RpcError("E_PROTOCOL")``."""
    if len(line.rstrip(b"\r\n")) > MAX_LINE:
        raise RpcError("E_PROTOCOL", "response line exceeds the limit", {"reason": "line-too-long"})
    try:
        value = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise RpcError("E_PROTOCOL", f"invalid JSON line: {type(e).__name__}", {"reason": "invalid-json"}) from None
    if not isinstance(value, dict):
        raise RpcError("E_PROTOCOL", "a line is not a JSON object", {"reason": "not-an-object"})
    return value


def result_of(msg: dict) -> Any:
    """The ``result`` of a response, or its error raised as ``RpcError`` with ``code = error.data.error``."""
    err = msg.get("error")
    if err is not None:
        if not isinstance(err, dict):
            raise RpcError("E_PROTOCOL", "malformed error object", {"reason": "bad-error"})
        data = err.get("data") if isinstance(err.get("data"), dict) else {}
        code = data.get("error")
        if not isinstance(code, str) or not code.startswith("E_"):
            code = _NUMERIC.get(err.get("code"), "E_INTERNAL")
        message = err.get("message") if isinstance(err.get("message"), str) else code
        return_data = dict(data)
        if isinstance(err.get("code"), int):
            return_data.setdefault("rpcCode", err["code"])
        raise RpcError(code, message, return_data)
    if "result" not in msg:
        raise RpcError("E_PROTOCOL", "response has neither result nor error", {"reason": "no-result"})
    return msg["result"]


def read_response(stream: Stream, req_id: int, deadline: float) -> Any:
    """Read lines until the response to ``req_id``; notifications (no ``id``) and other ids are skipped."""
    while True:
        msg = decode_line(stream.recv_line(deadline))
        if "id" not in msg:
            continue  # a notification
        if msg.get("id") is None and "error" in msg:
            return result_of(msg)  # the server could not read the request; raises
        if msg.get("id") != req_id:
            continue  # a late answer to an abandoned call
        return result_of(msg)


def parse_rpc_version(value: object) -> tuple[int, int, int]:
    """``"1.4.0"`` -> ``(1, 4, 0)``; ``RpcError("E_RPC_VERSION")`` when it is not ``MAJOR.MINOR.PATCH``."""
    if isinstance(value, str):
        parts = value.split(".")
        if len(parts) == 3 and all(p.isdigit() and p.isascii() for p in parts):
            return int(parts[0]), int(parts[1]), int(parts[2])
    raise RpcError("E_RPC_VERSION", "the core reports no usable rpc version", {"reason": "rpc-unparsable"})
