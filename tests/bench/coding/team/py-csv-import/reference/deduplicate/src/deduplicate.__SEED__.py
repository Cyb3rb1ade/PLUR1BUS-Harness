# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    import re

    scores = {}
    if not raw:
        return ""
    for token in raw.split(";"):
        match = re.fullmatch(r"([A-Za-z0-9_]+):(-?\d+)", token)
        if not match:
            return "error"
        name, score = match.group(1), int(match.group(2))
        scores[name] = max(scores.get(name, score), score)
    return ";".join(f"{name}:{score}" for name, score in sorted(scores.items()))


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
