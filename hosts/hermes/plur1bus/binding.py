"""The binding of one Hermes home to one PLUR1BUS agent (HM2-R8 as amended by HM2-R8a, ruling F11).

* ``$HERMES_HOME/plur1bus.json`` (``plur1bus.hermes-binding/1``, mode 0600) names the PLUR1BUS home,
  the ``plur1bus`` binary, the agent id and two tunables. The installer or ``hermes plur1bus bind``
  writes it; the provider only reads it.
* ``<plur1bus home>/hosts/hermes-bindings.json`` (``plur1bus.hermes-bindings/1``) records which Hermes
  home each ``hermes-*`` agent belongs to, so a second home that folds to the same agent id is refused.
* Agent ids are keyed on ``realpath(HERMES_HOME)``: the platform default root is ``hermes-default``,
  ``<default root>/profiles/<p>`` is ``hermes-<fold(p)>``, every other home is
  ``hermes-home-<first 8 hex of sha256(realpath)>`` (Hermes reports ``default`` for every home outside
  ``~/.hermes``, so a profile-name rule would collide).

The same rules are implemented in JavaScript by the installer; both are checked against
``hosts/hermes/tests/fixtures/binding-vectors.json`` and ``hermes-home-vectors.json``.
Stdlib only; never reads ``.env`` or ``config.yaml``.
"""

from __future__ import annotations

import errno
import hashlib
import json
import ntpath
import os
import posixpath
import re
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass, field, replace

from ._filelock import ExclusiveLockFile

__all__ = [
    "AGENT_ID_MAX",
    "AGENT_ID_RE",
    "BINDING_FILE",
    "BINDING_SCHEMA",
    "Binding",
    "BindingConflict",
    "BindingInvalid",
    "DEFAULT_RECALL_HARD_MS",
    "REGISTRY_FILE",
    "REGISTRY_SCHEMA",
    "agent_id_for",
    "atomic_write_text",
    "binding_path",
    "check_binding",
    "classify_home",
    "default_hermes_root",
    "fold_profile",
    "home_hash8",
    "read_binding",
    "read_registry",
    "register_binding",
    "registry_add",
    "resolve_hermes_home",
    "write_binding",
]

BINDING_SCHEMA = "plur1bus.hermes-binding/1"
BINDING_FILE = "plur1bus.json"
REGISTRY_SCHEMA = "plur1bus.hermes-bindings/1"
REGISTRY_FILE = os.path.join("hosts", "hermes-bindings.json")
DEFAULT_RECALL_HARD_MS = 600
RECALL_HARD_MS_RANGE = (50, 10000)
AGENT_ID_MAX = 64
AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_PREFIX = "hermes-"
_FOLD_KEEP = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_-")


class BindingInvalid(ValueError):
    """The binding file exists but is not a valid ``plur1bus.hermes-binding/1`` document."""

    def __init__(self, path: str, reason: str) -> None:
        self.path, self.reason = path, reason
        super().__init__(f"{path}: {reason}")


class BindingConflict(Exception):
    """``agent_id`` is already bound to another Hermes home."""

    def __init__(self, agent_id: str, other_home: str, home: str | None = None) -> None:
        self.agent_id, self.other_home, self.home = agent_id, other_home, home
        tail = f" (this home: {home})" if home else ""
        super().__init__(f"agent {agent_id} is already bound to the Hermes home {other_home}{tail}")


@dataclass(frozen=True)
class Binding:
    home: str
    agent_id: str
    bin: str | None = None
    recall_hard_ms: int = DEFAULT_RECALL_HARD_MS
    capture: bool = True
    version: str | None = None
    installed_by: str | None = None
    schema: str = field(default=BINDING_SCHEMA)

    def to_json(self) -> dict:
        return {
            "schema": self.schema,
            "version": self.version,
            "installedBy": self.installed_by,
            "home": self.home,
            "bin": self.bin,
            "agentId": self.agent_id,
            "recallHardMs": self.recall_hard_ms,
            "capture": self.capture,
        }

    @staticmethod
    def from_json(doc: object, path: str = BINDING_FILE) -> Binding:
        if not isinstance(doc, dict):
            raise BindingInvalid(path, "not a JSON object")
        if doc.get("schema") != BINDING_SCHEMA:
            raise BindingInvalid(path, f"schema is not {BINDING_SCHEMA}")
        home = doc.get("home")
        if not isinstance(home, str) or not (posixpath.isabs(home) or ntpath.isabs(home)):
            raise BindingInvalid(path, "home must be an absolute path")
        agent_id = doc.get("agentId")
        if not isinstance(agent_id, str) or not AGENT_ID_RE.match(agent_id):
            raise BindingInvalid(path, "agentId is not a valid agent id")
        b = doc.get("bin")
        if b is not None and (not isinstance(b, str) or not b):
            raise BindingInvalid(path, "bin must be a path or null")
        hard = doc.get("recallHardMs", DEFAULT_RECALL_HARD_MS)
        lo, hi = RECALL_HARD_MS_RANGE
        if isinstance(hard, bool) or not isinstance(hard, int) or not lo <= hard <= hi:
            raise BindingInvalid(path, f"recallHardMs must be an integer in {lo}..{hi}")
        capture = doc.get("capture", True)
        if not isinstance(capture, bool):
            raise BindingInvalid(path, "capture must be a boolean")
        version = doc.get("version")
        installed_by = doc.get("installedBy")
        for key, v in (("version", version), ("installedBy", installed_by)):
            if v is not None and not isinstance(v, str):
                raise BindingInvalid(path, f"{key} must be a string or null")
        return Binding(home, agent_id, b, hard, capture, version, installed_by)

    def with_(self, **changes: object) -> Binding:
        return replace(self, **changes)  # type: ignore[arg-type]


# -- paths and ids --------------------------------------------------------------------------------


def binding_path(hermes_home: str) -> str:
    return os.path.join(hermes_home, BINDING_FILE)


def default_hermes_root(env: Mapping[str, str] | None = None, platform: str = sys.platform, homedir: str | None = None) -> str:
    """Hermes' default root: ``~/.hermes``; on Windows ``%LOCALAPPDATA%\\hermes``, else
    ``%USERPROFILE%\\AppData\\Local\\hermes`` (``packages/core/src/import/sources/hermes.ts``
    ``defaultHermesHome``)."""
    env = os.environ if env is None else env
    if platform == "win32":
        user = (env.get("USERPROFILE") or "").strip() or homedir or os.path.expanduser("~")
        local = (env.get("LOCALAPPDATA") or "").strip()
        return ntpath.join(local or ntpath.join(user, "AppData", "Local"), "hermes")
    home = (env.get("HOME") or "").strip() or homedir or os.path.expanduser("~")
    return posixpath.join(home, ".hermes")


def fold_profile(profile: str) -> str:
    """``hermes-`` + the profile with ASCII letters lower-cased and every other code point outside
    ``[a-z0-9_-]`` replaced by ``-``, cut to 64 characters in total."""
    out = []
    for ch in profile:
        c = ch.lower() if "A" <= ch <= "Z" else ch
        out.append(c if c in _FOLD_KEEP else "-")
    return (_PREFIX + "".join(out))[:AGENT_ID_MAX]


def home_hash8(real_home: str) -> str:
    return hashlib.sha256(real_home.encode("utf-8")).hexdigest()[:8]


def _real(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


def _same_path(a: str, b: str, platform: str) -> bool:
    if platform == "win32":
        return ntpath.normcase(a).casefold() == ntpath.normcase(b).casefold()
    return a == b


def _pathmod(platform: str):  # noqa: ANN202
    return ntpath if platform == "win32" else posixpath


def classify_home(real_home: str, real_root: str, platform: str = sys.platform) -> str:
    """The agent id for an already resolved Hermes home and default root (pure; the shared vectors test
    this). Windows compares case-insensitively; the hash is over the exact ``real_home`` string."""
    pm = _pathmod(platform)
    if _same_path(real_home, real_root, platform):
        return fold_profile("default")
    parent, name = pm.split(real_home)
    parent_name = pm.basename(parent)
    is_profiles = parent_name.lower() == "profiles" if platform == "win32" else parent_name == "profiles"
    if name and is_profiles and _same_path(pm.dirname(parent), real_root, platform):
        return fold_profile(name)
    return _PREFIX + "home-" + home_hash8(real_home)


def agent_id_for(
    hermes_home: str,
    profile: str | None = None,
    *,
    default_root: str | None = None,
    env: Mapping[str, str] | None = None,
    platform: str = sys.platform,
) -> str:
    """The agent id for ``hermes_home`` (HM2-R8a). ``profile`` is Hermes' ``agent_identity``; it is
    informational only: the path decides, because Hermes names every home outside ``~/.hermes``
    ``default``."""
    del profile  # the realpath is the key (HM2-R8a); agent_identity would collide across homes
    root = default_root if default_root is not None else default_hermes_root(env, platform)
    return classify_home(_real(hermes_home), _real(root), platform)


def resolve_hermes_home(
    explicit: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
    platform: str = sys.platform,
    module_file: str | None = None,
) -> str:
    """The Hermes home to use outside ``initialize`` (``is_available``, ``hermes plur1bus ...``):
    ``explicit``, else the home whose ``plugins/`` holds this provider, else ``HERMES_HOME``, else the
    platform default root."""
    if explicit:
        return os.path.abspath(explicit)
    pkg = os.path.dirname(os.path.abspath(module_file or __file__))
    plugins = os.path.dirname(pkg)
    if os.path.basename(plugins) == "plugins":
        return os.path.dirname(plugins)
    env = os.environ if env is None else env
    configured = (env.get("HERMES_HOME") or "").strip()
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    return default_hermes_root(env, platform)


# -- files ----------------------------------------------------------------------------------------


def atomic_write_text(path: str, text: str, *, mode: int = 0o600, retry_s: float = 10.0) -> None:
    """``<name>.tmp-<pid>`` -> fsync -> rename; Windows sharing violations retried with backoff."""
    directory = os.path.dirname(path) or "."
    tmp = f"{path}.tmp-{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if os.name == "posix":
            os.chmod(tmp, mode)
        deadline = time.monotonic() + retry_s
        delay = 0.02
        while True:
            try:
                os.replace(tmp, path)
                break
            except PermissionError as e:
                transient = getattr(e, "winerror", None) in (5, 32, 33) or e.errno in (errno.EACCES, errno.EPERM, errno.EBUSY)
                if not transient or time.monotonic() >= deadline:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 0.5)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if os.name == "posix":
        try:
            dfd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass


def read_binding(hermes_home: str) -> Binding | None:
    """The binding of ``hermes_home``; None without a file. Raises ``BindingInvalid`` for a bad file."""
    path = binding_path(hermes_home)
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read(256 * 1024)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise BindingInvalid(path, f"unreadable ({type(e).__name__})") from None
    try:
        doc = json.loads(text)
    except ValueError:
        raise BindingInvalid(path, "not valid JSON") from None
    return Binding.from_json(doc, path)


def write_binding(hermes_home: str, b: Binding) -> None:
    """Write ``$HERMES_HOME/plur1bus.json`` atomically with mode 0600."""
    Binding.from_json(b.to_json(), binding_path(hermes_home))  # refuse to write what we would not read
    atomic_write_text(binding_path(hermes_home), json.dumps(b.to_json(), indent=2) + "\n")


def _registry_path(plur1bus_home: str) -> str:
    return os.path.join(plur1bus_home, REGISTRY_FILE)


def read_registry(plur1bus_home: str) -> dict[str, str]:
    """``{agentId: hermesHome}`` from ``<plur1bus home>/hosts/hermes-bindings.json`` ({} without one)."""
    path = _registry_path(plur1bus_home)
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise BindingInvalid(path, "unreadable or not valid JSON") from None
    if not isinstance(doc, dict) or doc.get("schema") != REGISTRY_SCHEMA or not isinstance(doc.get("bindings"), dict):
        raise BindingInvalid(path, f"not a {REGISTRY_SCHEMA} document")
    out: dict[str, str] = {}
    for k, v in doc["bindings"].items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def registry_add(bindings: Mapping[str, str], agent_id: str, real_home: str, platform: str = sys.platform) -> dict[str, str]:
    """``bindings`` plus ``agent_id -> real_home`` (pure). The same pair again is unchanged; an id held
    by another home raises ``BindingConflict`` naming both."""
    other = bindings.get(agent_id)
    if other is not None and not _same_path(other, real_home, platform):
        raise BindingConflict(agent_id, other, real_home)
    out = dict(bindings)
    out.setdefault(agent_id, real_home)
    return out


def check_binding(plur1bus_home: str, agent_id: str, hermes_home: str, *, platform: str = sys.platform) -> bool:
    """True when ``agent_id`` is already registered for ``hermes_home``, False when it is free; raises
    ``BindingConflict`` naming both homes when another home holds it. Writes nothing."""
    bindings = read_registry(plur1bus_home)
    registry_add(bindings, agent_id, _real(hermes_home), platform)
    return agent_id in bindings


REGISTRY_LOCK_TIMEOUT_S = 10.0
REGISTRY_LOCK_FILE = ".hermes-bindings.lock"  # shared with the installer (binding.mjs REGISTRY_LOCK_FILE)


def register_binding(plur1bus_home: str, agent_id: str, hermes_home: str, *, platform: str = sys.platform) -> None:
    """Record ``agent_id -> realpath(hermes_home)``. Re-registering the same pair is a no-op; an id
    already bound to another home raises ``BindingConflict`` naming both homes. The read-modify-write
    runs under the shared registry lock so concurrent binds cannot lose an entry; ``LockTimeout`` (an
    ``OSError``) after 10 s.

    Lock protocol (shared with the plugin installer, ``binding.mjs`` ``withRegistryLock``; see
    ``ExclusiveLockFile``): ``hosts/.hermes-bindings.lock`` is created with O_EXCL holding
    ``<pid> <hostname> <ms> <nonce>``, broken (rename aside, re-check identity) when older than 60 s or its pid
    on this host is dead, released by rename + nonce check, and verified (``LockLost``) right before the write.
    It is not an flock: the Node installer cannot take one, so both sides must use the file's existence."""
    path = _registry_path(plur1bus_home)
    lock = ExclusiveLockFile(os.path.join(os.path.dirname(path), REGISTRY_LOCK_FILE))
    with lock.hold(REGISTRY_LOCK_TIMEOUT_S) as held:
        bindings = read_registry(plur1bus_home)
        updated = registry_add(bindings, agent_id, _real(hermes_home), platform)
        if updated == bindings:
            return
        held.verify()  # LockLost (nothing written) when the lock was judged stale and taken over meanwhile
        doc = {"schema": REGISTRY_SCHEMA, "bindings": dict(sorted(updated.items()))}
        atomic_write_text(path, json.dumps(doc, indent=2) + "\n")
