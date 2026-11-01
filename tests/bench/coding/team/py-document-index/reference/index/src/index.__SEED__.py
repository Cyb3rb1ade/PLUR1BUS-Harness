# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    from collections import Counter

    counts = Counter(raw.split())
    return ";".join(f"{word}:{counts[word]}" for word in sorted(counts))


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
