# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text
import json


def impl_solve(raw: str) -> str:
    if raw == "none":
        return json.dumps({"term": None, "bytes": 0}, ensure_ascii=False, separators=(",", ":"))
    if not raw or not raw.isalnum() or raw != raw.lower():
        return "error"
    return json.dumps(
        {"term": raw, "bytes": len(raw.encode("utf8"))}, ensure_ascii=False, separators=(",", ":")
    )


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
