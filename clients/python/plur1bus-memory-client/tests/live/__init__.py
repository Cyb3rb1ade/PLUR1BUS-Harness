"""Live suites (HM2 Task 6): the client against a real core started from this checkout.

Needs ``PLUR1BUS_BIN`` (a built ``plur1bus``) and ``PLUR1BUS_CORE_JS`` (``packages/core/dist/core.js``); without
them every live test is skipped with the reason printed. The core runs with the flat-embedder seam
(``PLUR1BUS_ALLOW_TEST_INTERNALS=1``, ``PLUR1BUS_TEST_INTERNALS=flat-embedder``), so no model is downloaded.
With ``PLUR1BUS_LIVE_REQUIRED=1`` (CI, after the build) a missing requirement fails instead of skipping.
"""
