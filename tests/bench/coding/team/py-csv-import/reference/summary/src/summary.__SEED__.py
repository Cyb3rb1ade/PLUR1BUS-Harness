# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import re
    if not raw:
        return 'count=0;mean=0'
    values = []
    for token in raw.split(';'):
        match = re.fullmatch(r'[A-Za-z0-9_]+:(-?\d+)', token)
        if not match:
            return 'error'
        values.append(int(match.group(1)))
    return f'count={len(values)};mean={sum(values) // len(values)}'
