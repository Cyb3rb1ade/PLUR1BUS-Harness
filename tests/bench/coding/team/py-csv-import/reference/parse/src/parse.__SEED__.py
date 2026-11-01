# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    import csv
    import io
    import re

    result = []
    try:
        for row in csv.reader(io.StringIO(raw), strict=True):
            if not row:
                continue
            if (
                len(row) != 2
                or not re.fullmatch(r"[A-Za-z0-9_]+", row[0])
                or not re.fullmatch(r"-?\d+", row[1])
            ):
                return "error"
            result.append(f"{row[0]}:{int(row[1])}")
    except csv.Error:
        return "error"
    return ";".join(result)


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
