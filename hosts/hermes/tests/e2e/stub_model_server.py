"""A local OpenAI-compatible stub model for the real-Hermes turn (HM2 Task 6; Hermes facts (i)).

Loopback only, no key checked, a fixed completion. Answers ``GET /v1/models`` (and ``/v1/models/<id>``),
``POST /v1/chat/completions`` streaming (SSE chunks, a ``finish_reason: "stop"`` chunk, ``data: [DONE]``)
and non-streaming (the session-title call). Every chat request body is appended as one JSON line to the
request log, so ``drive_turn.py`` can check what Hermes sent (the recalled memory in the second turn).
Nothing else is logged: Hermes' ``Authorization`` header is ignored.

    python stub_model_server.py --port-file F --log L [--port 0]

Stdlib only; imports nothing from the test package.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "stub-model"
REPLY = "stub reply: ok"


def make_handler(log_path: str | None):  # noqa: ANN201
    lock = threading.Lock()

    def record(req: object) -> None:
        if not log_path:
            return
        line = json.dumps(req, ensure_ascii=False) + "\n"
        with lock, open(log_path, "a", encoding="utf-8") as f:
            f.write(line)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: object) -> None:  # quiet
            pass

        def _json(self, code: int, obj: object) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0].rstrip("/")
            model = {"id": MODEL, "object": "model", "owned_by": "stub", "context_length": 131072}
            if path.endswith("/models"):
                return self._json(200, {"object": "list", "data": [model]})
            if path.endswith("/models/" + MODEL):
                return self._json(200, model)
            return self._json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:  # noqa: N802
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n > 0 else b""
            try:
                req = json.loads(raw or b"{}")
            except ValueError:
                req = {"unparsed": raw.decode("utf-8", "replace")}
            if not self.path.split("?", 1)[0].rstrip("/").endswith("/chat/completions"):
                return self._json(404, {"error": {"message": "only chat/completions"}})
            record({"at": time.time(), "path": self.path, "request": req})
            now = int(time.time())
            model = (req.get("model") if isinstance(req, dict) else None) or MODEL
            if isinstance(req, dict) and req.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                base = {"id": "chatcmpl-stub", "object": "chat.completion.chunk", "created": now, "model": model}

                def event(obj: object) -> None:
                    self.wfile.write(b"data: " + json.dumps(obj).encode("utf-8") + b"\n\n")
                    self.wfile.flush()

                event(dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": REPLY}, "finish_reason": None}]))
                event(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}], usage={"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
                return None
            return self._json(200, {
                "id": "chatcmpl-stub", "object": "chat.completion", "created": now, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            })

    return Handler


class LoopbackServer(ThreadingHTTPServer):
    """``ThreadingHTTPServer`` without the reverse lookup in ``HTTPServer.server_bind``.

    ``HTTPServer.server_bind`` sets ``server_name = socket.getfqdn(host)``, a reverse DNS lookup of 127.0.0.1.
    On the macos-15 runner that lookup outlasted the job's 10 s wait for the port file (CI round 1: "stub.port:
    No such file or directory"). The stub never uses ``server_name``, so it is set to the bound address.
    """

    daemon_threads = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


def serve(port: int = 0, log_path: str | None = None) -> LoopbackServer:
    """A started-in-a-thread server on 127.0.0.1 (tests); ``server_address[1]`` is the port."""
    srv = LoopbackServer(("127.0.0.1", port), make_handler(log_path))
    threading.Thread(target=srv.serve_forever, name="stub-model", daemon=True).start()
    return srv


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--port-file", required=True, help="written (atomically) with the bound port once listening")
    ap.add_argument("--log", default=None, help="append every chat request body here (one JSON line each)")
    args = ap.parse_args(argv)
    srv = LoopbackServer(("127.0.0.1", args.port), make_handler(args.log))
    tmp = args.port_file + ".tmp"
    with open(tmp, "w", encoding="ascii") as f:
        f.write(str(srv.server_address[1]))
    os.replace(tmp, args.port_file)
    print(f"stub model on http://127.0.0.1:{srv.server_address[1]}/v1", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
