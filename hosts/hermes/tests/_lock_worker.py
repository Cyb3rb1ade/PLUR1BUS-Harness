"""Worker for the multi-process lock stress test (test_binding.py): ``python _lock_worker.py <lock> <log> <iters> <die_at>``.
Every critical section appends ``E <pid>`` ... ``X <pid>`` to the log; a worker that dies while holding appends
``D <pid>`` and ``os._exit``s without releasing."""

import os
import sys
import time

import importlib.util  # noqa: E402

# _filelock is stdlib-only; load it by path (importing the plur1bus package would need the Hermes stubs).
_spec = importlib.util.spec_from_file_location(
    "p1_filelock", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plur1bus", "_filelock.py")
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["p1_filelock"] = _mod  # dataclass-free, but contextmanager/typing want a registered module
_spec.loader.exec_module(_mod)
ExclusiveLockFile, LockLost = _mod.ExclusiveLockFile, _mod.LockLost

lock_path, log_path, iters, die_at = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
pid = os.getpid()


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
            if i == die_at:
                log("D")
                os._exit(0)
            time.sleep(0.004)
            try:
                held.verify()
            except LockLost:
                log("L")  # displaced mid-section: this holder writes nothing (the test allows an overlap only then)
            log("X")
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "winerror", None)
        if code is None:
            code = getattr(e, "errno", None)
        log("T", f" {type(e).__name__} {code}")
