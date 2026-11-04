# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    import re

    result = []
    if not raw:
        return ""
    for token in raw.split(";"):
        match = re.fullmatch(r"([A-Za-z0-9_]+)/(\d+)/(\d+)", token)
        if not match:
            return "error"
        result.append(f"{match.group(1)}:{int(match.group(2)) * int(match.group(3))}")
    return ";".join(result)


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
