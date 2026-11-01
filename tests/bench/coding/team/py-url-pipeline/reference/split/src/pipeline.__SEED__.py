# SPDX-License-Identifier: MIT
"""Public task endpoint and authored domain implementation, without hidden checkers or expected results."""

from contracts__SEED__ import Packet, packet, payload, text


def impl_split_url(raw: str) -> str:
    import json
    import re
    from urllib.parse import urlsplit

    try:
        value = urlsplit(raw)
        if (
            value.scheme.lower() not in ("http", "https")
            or value.username is not None
            or value.password is not None
            or not value.hostname
            or not re.fullmatch(r"[a-zA-Z0-9.-]+", value.hostname)
        ):
            return "error"
        return json.dumps(
            dict(
                scheme=value.scheme.lower(),
                host=value.hostname.lower(),
                port=value.port,
                path=value.path or "/",
                query=value.query,
            ),
            separators=(",", ":"),
        )
    except ValueError:
        return "error"


def impl_normalize_url(raw: str) -> str:
    return "unimplemented"


def impl_assemble_url(raw: str) -> str:
    return "unimplemented"


def split_url__SEED__(raw: str) -> Packet:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = raw
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_split_url(value)
    return packet(result, 1)


def normalize_url__SEED__(raw: Packet) -> Packet:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = payload(raw, 1)
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_normalize_url(value)
    return packet(result, 2)


def assemble_url__SEED__(raw: Packet) -> str:
    """Validate the instance frame and actual predecessor state before domain processing."""
    value = payload(raw, 2)
    value = text(value) if value is not None else None
    result = "error" if value is None or value == "error" else impl_assemble_url(value)
    return result
