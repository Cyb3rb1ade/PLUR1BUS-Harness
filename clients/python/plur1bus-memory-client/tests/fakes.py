"""A fake core: NDJSON JSON-RPC on ``<home>/run/core.sock``, in a thread or in a child process.

It writes ``run/core.token`` (a random test-only value) and ``run/core.pid``, answers ``core.auth``
with a hello, and every other method from ``packages/rpc-schema/fixtures/methods/<method>.json``
unless a handler overrides it. It records each request's method (and params, except the auth
token) in ``calls`` and, for the child process, in ``<home>/fake-core.log``. Stdlib only, so it
also runs as a script: ``python fakes.py <home> <token> [rpc]``.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
from collections.abc import Callable
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_HERE))))
METHOD_FIXTURES = os.path.join(_REPO, "packages", "rpc-schema", "fixtures", "methods")


class FakeError:
    """Answer with a JSON-RPC error whose ``data.error`` is ``code``."""

    def __init__(self, code: str, reason: str = "fake", message: str = "fake error") -> None:
        self.code, self.reason, self.message = code, reason, message


class Raw:
    """Answer with these bytes as the line (for protocol-error tests)."""

    def __init__(self, line: bytes) -> None:
        self.line = line


DROP = object()  # close the connection without answering
SILENT = object()  # never answer this request (the connection stays open)

Handler = Callable[[dict], Any]


def fixture_result(method: str) -> Any:
    path = os.path.join(METHOD_FIXTURES, method + ".json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)["result"]


def default_capabilities() -> dict:
    stable = {"stability": "stable", "since": "1.0.0"}
    return {
        "methods": {m: dict(stable) for m in ("core.auth", "core.status", "memory.recall", "memory.capture")},
        "notifications": {},
        "extensionPoints": {},
        "features": [],
    }


class FakeCore:
    def __init__(
        self,
        home: str,
        *,
        token: str | None = None,
        pid: int | None = None,
        rpc: str = "1.5.0",
        capabilities: dict | None = None,
        handlers: dict[str, Any] | None = None,
        log_path: str | None = None,
        write_pid: bool = True,
    ) -> None:
        self.home = home
        self.run = os.path.join(home, "run")
        self.sock_path = os.path.join(self.run, "core.sock")
        self.token = token or secrets.token_hex(32)
        self.pid = os.getpid() if pid is None else pid
        self.rpc = rpc
        self.capabilities = capabilities if capabilities is not None else default_capabilities()
        self.handlers: dict[str, Any] = dict(handlers or {})
        self.log_path = log_path
        self.write_pid = write_pid
        self.calls: list[tuple[str, dict]] = []
        self.connections = 0
        self._listener: socket.socket | None = None
        self._conns: list[socket.socket] = []
        self._threads: list[threading.Thread] = []
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------------------------------

    def start(self) -> FakeCore:
        os.makedirs(self.run, mode=0o700, exist_ok=True)
        os.chmod(self.run, 0o700)
        _write(os.path.join(self.run, "core.token"), self.token + "\n")
        if self.write_pid:
            _write(os.path.join(self.run, "core.pid"), f"{self.pid} inst-fake\n")
        if os.path.exists(self.sock_path):
            os.unlink(self.sock_path)
        self._stop.clear()
        lst = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        lst.bind(self.sock_path)
        lst.listen(16)
        lst.settimeout(0.05)
        self._listener = lst
        t = threading.Thread(target=self._accept_loop, name="fake-core-accept", daemon=True)
        t.start()
        self._threads.append(t)
        return self

    def stop(self) -> None:
        self._stop.set()
        lst, self._listener = self._listener, None
        if lst is not None:
            lst.close()
        with self._lock:
            conns, self._conns = self._conns, []
        for c in conns:
            try:
                c.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            c.close()
        for t in self._threads:
            t.join(timeout=2)
        self._threads = []
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass

    def restart(self, *, token: str | None = None, pid: int | None = None) -> None:
        self.stop()
        self.token = token or secrets.token_hex(32)
        if pid is not None:
            self.pid = pid
        self.start()

    def __enter__(self) -> FakeCore:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def methods(self) -> list[str]:
        with self._lock:
            return [m for m, _ in self.calls]

    # -- serving -----------------------------------------------------------------------------------

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            lst = self._listener
            if lst is None:
                return
            try:
                conn, _ = lst.accept()
            except (socket.timeout, BlockingIOError):
                continue
            except OSError:
                return
            conn.settimeout(None)
            with self._lock:
                self._conns.append(conn)
                self.connections += 1
            t = threading.Thread(target=self._serve, args=(conn,), name="fake-core-conn", daemon=True)
            t.start()
            self._threads.append(t)

    def _record(self, method: str, params: dict) -> None:
        shown = {} if method == "core.auth" else params
        with self._lock:
            self.calls.append((method, shown))
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"method": method}) + "\n")

    def _serve(self, conn: socket.socket) -> None:
        authed = False
        f = conn.makefile("rb")
        try:
            for raw in f:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                method, params, req_id = msg.get("method"), msg.get("params") or {}, msg.get("id")
                self._record(method, params)
                if method == "core.auth":
                    outcome = self.handlers.get("core.auth", self._auth)
                elif not authed:
                    outcome = FakeError("E_UNAUTHORIZED", "not-authenticated")
                else:
                    outcome = self.handlers.get(method, _fixture_handler(method))
                if callable(outcome):
                    outcome = outcome(params)
                if outcome is DROP:
                    return
                if outcome is SILENT:
                    continue
                if isinstance(outcome, Raw):
                    conn.sendall(outcome.line + b"\n")
                    continue
                if isinstance(outcome, FakeError):
                    reply = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32000, "message": outcome.message, "data": {"error": outcome.code, "reason": outcome.reason}},
                    }
                else:
                    reply = {"jsonrpc": "2.0", "id": req_id, "result": outcome}
                    if method == "core.auth":
                        authed = True
                conn.sendall(json.dumps(reply).encode("utf-8") + b"\n")
        except OSError:
            pass
        finally:
            try:
                f.close()
                conn.close()
            except OSError:
                pass

    def _auth(self, params: dict) -> Any:
        if params.get("token") != self.token:
            return FakeError("E_UNAUTHORIZED", "bad-token", "unauthorized")
        return {"contract": "1.4.1", "rpc": self.rpc, "instanceId": "inst-fake", "pid": self.pid, "capabilities": self.capabilities}


def _fixture_handler(method: str) -> Handler:
    def handle(_params: dict) -> Any:
        try:
            return fixture_result(method)
        except FileNotFoundError:
            return FakeError("E_NOT_AVAILABLE", "no-fixture")

    return handle


def _write(path: str, text: str) -> None:
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="ascii") as f:
        f.write(text)
    os.replace(tmp, path)


class FakeCoreProcess:
    """The fake core in a child process, so a restart really changes the server pid."""

    def __init__(self, home: str, *, token: str | None = None, rpc: str = "1.5.0") -> None:
        self.home = home
        self.token = token or secrets.token_hex(32)
        self.rpc = rpc
        self.log_path = os.path.join(home, "fake-core.log")
        self.proc: subprocess.Popen | None = None

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc else None

    def start(self) -> FakeCoreProcess:
        self.proc = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), self.home, self.token, self.rpc],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        line = self.proc.stdout.readline() if self.proc.stdout else ""
        if line.strip() != "ready":
            self.stop()
            raise RuntimeError("fake core process did not start")
        return self

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        if proc.stdin:
            proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        if proc.stdout:
            proc.stdout.close()

    def restart(self, *, token: str | None = None) -> None:
        self.stop()
        self.token = token or secrets.token_hex(32)
        self.start()

    def methods(self) -> list[str]:
        try:
            with open(self.log_path, encoding="utf-8") as f:
                return [json.loads(line)["method"] for line in f if line.strip()]
        except FileNotFoundError:
            return []


def _main(argv: list[str]) -> int:
    home, token = argv[0], argv[1]
    rpc = argv[2] if len(argv) > 2 else "1.5.0"
    core = FakeCore(home, token=token, rpc=rpc, log_path=os.path.join(home, "fake-core.log")).start()
    print("ready", flush=True)
    try:
        sys.stdin.read()  # until the parent closes stdin
    finally:
        core.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))


__all__ = ["DROP", "SILENT", "Raw", "FakeCore", "FakeCoreProcess", "FakeError", "fixture_result", "default_capabilities"]
