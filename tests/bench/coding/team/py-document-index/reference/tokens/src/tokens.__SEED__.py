# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_solve(raw: str) -> str:
    words = []
    word = ""
    for char in raw:
        if char.isalnum():
            word += char.lower()
        elif word:
            words.append(word)
            word = ""
    if word:
        words.append(word)
    return " ".join(words)


def solve__SEED__(raw: str) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_solve(value)
    return result
