"""HM4: connect to the discovered IPC endpoint with an approved, separate token; never start a daemon."""
from __future__ import annotations

import json
import os
from typing import Any

from ._client import pmc

TOKEN_FILE = "plur1bus-client.token"


def client_token_path(hermes_home: str, home: str) -> str | None:
    path = os.path.join(hermes_home, TOKEN_FILE)
    # An installed full profile always requires its own token, even when the file is missing.
    if os.path.lexists(path):
        return path
    try:
        with open(os.path.join(home, "manifest.json"), encoding="utf8") as f:
            manifest = json.load(f)
        if not isinstance(manifest, dict) or manifest.get("profile", "full") == "full":
            return path
    except FileNotFoundError:
        pass  # existing uninstalled HM2 tests and source-development homes
    except (OSError, ValueError, RecursionError):
        return path  # unreadable/invalid profile never grants the owner credential
    return None


def bound_client(hermes_home: str, home: str) -> Any:
    return pmc.MemoryClient(home, token_path=client_token_path(hermes_home, home))
