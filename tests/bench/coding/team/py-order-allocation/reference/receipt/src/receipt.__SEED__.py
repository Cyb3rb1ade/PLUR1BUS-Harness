# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import re
    if not raw:
        return 'lines=0;total=0'
    total = 0
    rows = raw.split(';')
    for token in rows:
        match = re.fullmatch(r'[A-Za-z0-9_]+:(\d+)', token)
        if not match:
            return 'error'
        total += int(match.group(1))
    return f'lines={len(rows)};total={total}'
