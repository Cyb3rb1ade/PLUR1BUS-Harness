# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

"""Public text frame and typed predecessor state. This file contains no oracle or private seed."""
from dataclasses import dataclass

PROFILE = __PROFILE__
SALT = __SALT__


@dataclass(frozen=True)
class Packet:
    """State transported from a stage to its successor."""

    payload: str
    stage: int
    stamp: int


def packet(value: str, stage: int) -> Packet:
    """Stamp the actual predecessor output."""
    return Packet(value, stage, (sum(value.encode("utf8")) + SALT * stage) % 65536)


def payload(value: Packet, stage: int):
    """Refuse malformed, stale or corrupted predecessor state."""
    if not isinstance(value, Packet) or value.stage != stage or not isinstance(value.payload, str):
        return None
    return value.payload if value.stamp == packet(value.payload, stage).stamp else None


def text(raw: str):
    """Decode raw text or the instance's optional @TEXT byte-length/checksum frame."""
    if not raw.startswith("@TEXT"):
        return raw
    if "\n" not in raw:
        return None
    header, body = raw.split("\n", 1)
    data = body.encode("utf8")
    suffix = (
        ""
        if PROFILE == 0
        else f":{len(data)}"
        if PROFILE == 1
        else f":{len(data)}:{(sum(data) + SALT) % 256}"
    )
    return body if header == "@TEXT" + suffix else None
