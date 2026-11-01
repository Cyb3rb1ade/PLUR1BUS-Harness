# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    import re

    if not raw:
        return "lines=0;total=0"
    total = 0
    rows = raw.split(";")
    for token in rows:
        match = re.fullmatch(r"[A-Za-z0-9_]+:(\d+)", token)
        if not match:
            return "error"
        total += int(match.group(1))
    return f"lines={len(rows)};total={total}"


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
