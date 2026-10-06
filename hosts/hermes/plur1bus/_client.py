"""Where the provider gets ``plur1bus_memory_client`` from (HM2-R4, ruling F13).

Inside Hermes the provider directory is imported as a package with a synthetic name
(``_hermes_user_memory.plur1bus__source_<digest>``, ``plugins/memory/__init__.py`` @ ``743ee72``), so
sibling modules are reached by relative imports only. The release tarball (Task 7) vendors the client
under ``_vendor/plur1bus_memory_client``; when that directory exists it is the only copy used. Without
it (the source tree, tests) the top-level ``plur1bus_memory_client`` is used, and as a last resort the
client's source directory next to this one in the harness checkout.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
VENDORED = os.path.isfile(os.path.join(_HERE, "_vendor", "plur1bus_memory_client", "__init__.py"))

if VENDORED:
    from ._vendor import plur1bus_memory_client as pmc  # noqa: F401
else:
    try:
        import plur1bus_memory_client as pmc  # noqa: F401
    except ImportError:
        _SRC = os.path.join(os.path.dirname(os.path.dirname(_HERE)), "..", "clients", "python", "plur1bus-memory-client", "src")
        _SRC = os.path.normpath(_SRC)
        if not os.path.isdir(os.path.join(_SRC, "plur1bus_memory_client")):
            raise
        # Appended, never prepended: nothing earlier on sys.path may be shadowed by a harness checkout, and the
        # import above already failed, so no earlier entry holds this package.
        sys.path.append(_SRC)
        import plur1bus_memory_client as pmc  # noqa: F401

__all__ = ["pmc", "VENDORED"]
