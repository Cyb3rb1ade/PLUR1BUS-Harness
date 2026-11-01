# SPDX-License-Identifier: MIT
def split_url(raw: str) -> str:
    import json
    import re
    from urllib.parse import urlsplit
    try:
        value = urlsplit(raw)
        if value.scheme.lower() not in ('http', 'https') or value.username is not None or value.password is not None or not value.hostname or not re.fullmatch(r'[a-zA-Z0-9.-]+', value.hostname):
            return 'error'
        return json.dumps(dict(scheme=value.scheme.lower(), host=value.hostname.lower(), port=value.port, path=value.path or '/', query=value.query), separators=(',', ':'))
    except ValueError:
        return 'error'

def normalize_url(raw: str) -> str:
    return "unimplemented"

def assemble_url(raw: str) -> str:
    return "unimplemented"
