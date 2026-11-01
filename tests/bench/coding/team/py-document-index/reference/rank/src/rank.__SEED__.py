# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    if not raw:
        return "none"
    counts = {}
    for token in raw.split(";"):
        parts = token.rsplit(":", 1)
        if (
            len(parts) != 2
            or not parts[0]
            or not parts[1].isdigit()
            or int(parts[1]) < 1
            or parts[0] in counts
        ):
            return "error"
        counts[parts[0]] = int(parts[1])
    return min(counts, key=lambda word: (-counts[word], word))


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
