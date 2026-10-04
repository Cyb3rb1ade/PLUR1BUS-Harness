"""Worker for the multi-process lock stress test (test_binding.py): ``python _lock_worker.py <lock> <log> <iters> <die_at>``.
Every critical section appends ``E <pid>`` ... ``X <pid>`` to the log; a worker that dies while holding appends
``D <pid>`` and ``os._exit``s without releasing. Slow prep first, then a guarded publish (verify in the hook,
``os.replace``, then ``W``). ``D`` is inside the hook after verify, before the replace."""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import types

# Load _filelock and binding by path (importing the plur1bus package would need the Hermes stubs).
_PKG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plur1bus")
_pkg = types.ModuleType("plur1bus")
_pkg.__path__ = [_PKG_DIR]
_pkg.__package__ = "plur1bus"
sys.modules["plur1bus"] = _pkg


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_PKG_DIR, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_fl = _load("plur1bus._filelock", "_filelock.py")
_bd = _load("plur1bus.binding", "binding.py")
ExclusiveLockFile, LockLost = _fl.ExclusiveLockFile, _fl.LockLost
atomic_write_text = _bd.atomic_write_text

lock_path, log_path, iters, die_at = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
pid = os.getpid()
mark = lock_path + ".mark"


def log(tag: str, detail: str = "") -> None:
    fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, f"{tag} {pid}{detail}\n".encode())
    finally:
        os.close(fd)


for i in range(iters):
    try:
        with ExclusiveLockFile(lock_path).hold(30) as held:
            log("E")
            time.sleep(0.004)  # slow prep first: the last verify sits immediately before publish

            def hook(i: int = i) -> None:
                held.verify()
                if i == die_at:
                    log("D")
                    os._exit(0)  # dies holding the lock, after verify and before the replace

            try:
                atomic_write_text(mark, f"{pid} {i}\n", before_replace=hook)
            except LockLost:
                log("L")  # displaced mid-section: this holder writes nothing (the test allows an overlap only then)
                log("X")
                continue
            log("W")
            log("X")
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "winerror", None)
        if code is None:
            code = getattr(e, "errno", None)
        log("T", f" {type(e).__name__} {code}")
