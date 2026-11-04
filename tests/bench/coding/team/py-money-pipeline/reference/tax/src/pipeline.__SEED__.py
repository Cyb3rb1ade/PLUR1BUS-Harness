# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_decode(raw: str) -> str:
    import re

    match = re.fullmatch(r"(-?)(\d+)\.(\d{2})@(\d+)", raw)
    if not match or int(match.group(4)) > 10000:
        return "error"
    cents = int(match.group(2)) * 100 + int(match.group(3))
    if match.group(1):
        cents = -cents
    return f"{cents}@{int(match.group(4))}"


def impl_tax(raw: str) -> str:
    import re

    match = re.fullmatch(r"(-?\d+)@(\d+)", raw)
    if not match or int(match.group(2)) > 10000:
        return "error"
    cents, rate = int(match.group(1)), int(match.group(2))
    numerator = abs(cents) * (10000 + rate)
    rounded = (numerator + 5000) // 10000
    return str(-rounded if cents < 0 else rounded)


def impl_format_money(raw: str) -> str:
    return "unimplemented"


def decode__SEED__(raw: str) -> Packet:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_decode(value)
    return packet(result, 1)


def tax__SEED__(raw: Packet) -> Packet:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = payload(raw, 1)
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_tax(value)
    return packet(result, 2)


def format_money__SEED__(raw: Packet) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = payload(raw, 2)
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_format_money(value)
    return result
