"""Tests for plur1bus-memory-client. Run from the repository root:

    python3 -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client

The package is imported from ``src/`` (no install needed); the conformance tests need the dev
requirements (``requirements-dev.txt``) and are skipped with a reason without them.
"""

import os
import sys

CLIENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(CLIENT_DIR)))
SRC_DIR = os.path.join(CLIENT_DIR, "src")
FIXTURES_DIR = os.path.join(CLIENT_DIR, "tests", "fixtures")
RPC_SCHEMA_DIR = os.path.join(REPO_ROOT, "packages", "rpc-schema")

if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)
