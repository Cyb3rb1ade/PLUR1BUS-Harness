"""Tests for the Hermes provider. Run from the repository root:

    python3 -m unittest discover -s hosts/hermes/tests -t hosts/hermes

``hosts/hermes/tests/stubs`` provides ``agent.memory_provider`` (Hermes itself is never imported) and
the client comes from its source tree (the vendored copy exists only in the release build, HM2-R4).
Every test uses temp homes and a stub core on a Unix socket; nothing touches a real home, Hermes, a
service manager or a sidecar.
"""

import os
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
HERMES_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(os.path.dirname(HERMES_DIR))
STUBS_DIR = os.path.join(TESTS_DIR, "stubs")
CLIENT_DIR = os.path.join(REPO_ROOT, "clients", "python", "plur1bus-memory-client")
CLIENT_SRC = os.path.join(CLIENT_DIR, "src")
FIXTURES_DIR = os.path.join(TESTS_DIR, "fixtures")
PROVIDER_DIR = os.path.join(HERMES_DIR, "plur1bus")

for _p in (CLIENT_SRC, STUBS_DIR, HERMES_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)
