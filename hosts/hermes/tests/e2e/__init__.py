"""End-to-end pieces of HM2 Task 6.

* ``test_provider_live.py``: the provider (under the stub ABC) against a real flat-embedder core; needs
  ``PLUR1BUS_BIN`` and ``PLUR1BUS_CORE_JS``, skipped with a printed reason otherwise.
* ``assert_disposable.py``, ``stub_model_server.py``, ``drive_turn.py``: scripts the ``real-hermes`` job of
  ``.github/workflows/hermes-host.yml`` runs against a real Hermes on a disposable runner. They import nothing
  from the test package (stdlib, plus the provider's own ``binding`` module for ``drive_turn.py``).
"""

import importlib.util
import os
import sys

from tests import CLIENT_DIR

E2E_DIR = os.path.dirname(os.path.abspath(__file__))
STACK_FILE = os.path.join(CLIENT_DIR, "tests", "live", "stack.py")


def load_stack():
    """The client's live-stack helper (one implementation for both live suites), loaded by path because both
    test trees are named ``tests``."""
    name = "plur1bus_live_stack"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, STACK_FILE)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


if E2E_DIR not in sys.path:
    sys.path.insert(0, E2E_DIR)
