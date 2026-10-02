"""Home, address and run-file rules of a PLUR1BUS home.

The same rules as ``crates/plur1bus/src/paths.rs`` (``resolve_home``, ``address``) and
``packages/module-api/src/paths.ts`` (``coreAddress``), ruling H3B-R9. ``platform`` is a
``sys.platform`` value: ``"win32"`` selects the Windows rules, anything else the POSIX ones.
The shared vectors in ``tests/fixtures/{address,home}-vectors.json`` are checked by the Python,
Rust and TypeScript test suites.

The address hashes the exact home string it is given (F24): callers pass the absolute home the
core was started with, never a re-derived or re-normalised one.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping

__all__ = [
    "default_home",
    "is_absolute_home",
    "core_address",
    "core_token_path",
    "core_pid_path",
    "run_dir",
]


def _is_windows(platform: str) -> bool:
    return platform == "win32"


def _sep(platform: str) -> str:
    return "\\" if _is_windows(platform) else "/"


def _is_sep(platform: str, c: str) -> bool:
    return c in ("\\", "/") if _is_windows(platform) else c == "/"


def is_absolute_home(home: str, platform: str) -> bool:
    """True when ``home`` is absolute for ``platform`` (paths.rs ``is_absolute``)."""
    if not home:
        return False
    if _is_windows(platform):
        return home[0] in ("\\", "/") or (len(home) >= 2 and home[1] == ":")
    return home.startswith("/")


def _join_with(sep: str, base: str, parts: list[str]) -> str:
    s = base.rstrip(sep)
    for p in parts:
        s += sep + p.strip(sep)
    return s


def _split_root(platform: str, s: str) -> tuple[str, str]:
    if _is_windows(platform):
        if len(s) >= 2 and s[1] == ":":
            i = 2
            if i < len(s) and _is_sep(platform, s[i]):
                i += 1
            return s[0] + ":\\", s[i:]
        if s and _is_sep(platform, s[0]):
            i = 0
            while i < len(s) and _is_sep(platform, s[i]):
                i += 1
            return "\\", s[i:]
        return "", s
    if s.startswith("/"):
        return "/", s[1:]
    return "", s


def _normalize_absolute(platform: str, root: str, sep: str, rest: str) -> str:
    stack: list[str] = []
    seg = ""
    for c in rest + sep:
        if _is_sep(platform, c):
            if seg in ("", "."):
                pass
            elif seg == "..":
                if stack:
                    stack.pop()
            else:
                stack.append(seg)
            seg = ""
        else:
            seg += c
    joined = sep.join(stack)
    return root + joined if joined else root


def _resolve_and_normalize(platform: str, cwd: str, value: str) -> str:
    """paths.rs ``resolve_and_normalize``: Node's ``path.resolve`` for ``platform``, lexically."""
    sep = _sep(platform)
    raw = value if is_absolute_home(value, platform) else _join_with(sep, cwd, [value])
    root, rest = _split_root(platform, raw)
    if not root:
        root = sep
    return _normalize_absolute(platform, root, sep, rest)


def default_home(
    env: Mapping[str, str],
    platform: str,
    home_dir: str,
    local_app_data: str | None = None,
    *,
    cwd: str | None = None,
) -> str:
    """The PLUR1BUS home as ``plur1bus`` resolves it without ``--home`` (paths.rs ``resolve_home``).

    ``$PLUR1BUS_HOME`` (relative values resolved against ``cwd``, default the process cwd), else
    ``%LOCALAPPDATA%\\PLUR1BUS`` on Windows (``local_app_data``, then ``env["LOCALAPPDATA"]``, then
    ``<home_dir>\\AppData\\Local``), else ``<home_dir>/.plur1bus``. An empty ``$PLUR1BUS_HOME`` counts as
    unset, as in ``packages/core/src/paths.ts``.
    """
    value = env.get("PLUR1BUS_HOME")
    if value:
        if cwd is None:
            cwd = os.getcwd()
        return _resolve_and_normalize(platform, cwd, value)
    if _is_windows(platform):
        lad = local_app_data or env.get("LOCALAPPDATA") or _join_with("\\", home_dir, ["AppData", "Local"])
        return _join_with("\\", lad, ["PLUR1BUS"])
    return _join_with("/", home_dir, [".plur1bus"])


def _address(home: str, platform: str, role: str) -> str:
    if _is_windows(platform):
        digest = hashlib.sha256(home.lower().encode("utf-8")).hexdigest()[:16]
        return "\\\\.\\pipe\\plur1bus-" + digest + "-" + role
    return home.rstrip("/") + "/run/" + role + ".sock"


def core_address(home: str, platform: str) -> str:
    """``\\\\.\\pipe\\plur1bus-<sha256(home.lower())[:16]>-core`` on ``win32``, else ``<home>/run/core.sock``."""
    return _address(home, platform, "core")


def run_dir(home: str) -> str:
    """``<home>/run`` in this host's path syntax: the core's token, pid and socket live here."""
    return os.path.join(home, "run")


def core_token_path(home: str) -> str:
    """``<home>/run/core.token``: rewritten by every core start; read on every (re)connect, never logged."""
    return os.path.join(home, "run", "core.token")


def core_pid_path(home: str) -> str:
    """``<home>/run/core.pid``: ``<pid> <instanceId>`` of the running core (ruling S11)."""
    return os.path.join(home, "run", "core.pid")
