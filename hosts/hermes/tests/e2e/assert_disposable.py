"""Refuse to touch anything but a disposable Hermes (HM2 Task 6, Global Constraints).

The ``real-hermes`` job of ``.github/workflows/hermes-host.yml`` runs this before it installs a provider into a
real Hermes. Every path it is given (``HERMES_HOME`` and ``--path`` values: the install dir, the fake ``HOME``,
the PLUR1BUS home) must resolve strictly inside the disposable root: ``$RUNNER_TEMP`` when set, else the
system temp dir. The default Hermes root of the real user (``~/.hermes``, ``%LOCALAPPDATA%\\hermes``) and the
real home are refused even when they happen to lie there.

    python assert_disposable.py [--path P ...]     exit 0 = disposable, exit 2 = refused (reason on stderr)

Stdlib only; imports nothing from the test package.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections.abc import Mapping


class NotDisposable(Exception):
    pass


def _real(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(path))))


def _inside(child: str, parent: str) -> bool:
    """``child`` strictly below ``parent`` (both real and normcased)."""
    if child == parent:
        return False
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def disposable_root(env: Mapping[str, str]) -> str:
    root = (env.get("RUNNER_TEMP") or "").strip() or tempfile.gettempdir()
    return _real(root)


def real_user_paths(env: Mapping[str, str], real_home: str | None = None) -> list[str]:
    """The real user's home and default Hermes roots: never disposable. ``real_home`` is the account's home
    as the OS knows it (a fake ``HOME`` in the environment does not change it)."""
    out = []
    homes = [real_home] if real_home else []
    if os.name == "posix":
        try:
            import pwd

            homes.append(pwd.getpwuid(os.getuid()).pw_dir)
        except (ImportError, KeyError):
            pass
    for h in homes:
        if h:
            out += [_real(h), _real(os.path.join(h, ".hermes"))]
    for key in ("LOCALAPPDATA",):
        v = (env.get(key) or "").strip()
        if v:
            out.append(_real(os.path.join(v, "hermes")))
    return out


def check(paths: list[str], env: Mapping[str, str], *, real_home: str | None = None) -> str:
    """Raise ``NotDisposable`` unless every path is strictly inside the disposable root and none is (or holds)
    a real user path. Returns the root."""
    if not paths:
        raise NotDisposable("nothing to check")
    root = disposable_root(env)
    if root in (_real(os.sep), _real(os.path.expanduser("~"))) or len(root) <= 3:
        raise NotDisposable(f"the disposable root {root} is not a temp directory")
    forbidden = real_user_paths(env, real_home)
    for p in paths:
        if not p or not p.strip():
            raise NotDisposable("an empty path was given")
        rp = _real(p)
        if not _inside(rp, root):
            raise NotDisposable(f"{p} is not inside the disposable root {root}")
        for f in forbidden:
            if rp == f or _inside(f, rp):
                raise NotDisposable(f"{p} is (or contains) a real user path {f}")
    return root


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    env = os.environ if env is None else env
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--path", action="append", default=[], help="another path that must be disposable")
    args = ap.parse_args(argv)
    hermes_home = (env.get("HERMES_HOME") or "").strip()
    try:
        if not hermes_home:
            raise NotDisposable("HERMES_HOME is not set")
        paths = [hermes_home, *args.path]
        root = check(paths, env)
    except NotDisposable as e:
        print(f"assert_disposable: REFUSED: {e}", file=sys.stderr)
        return 2
    print(f"assert_disposable: ok, {len(paths)} path(s) inside {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
