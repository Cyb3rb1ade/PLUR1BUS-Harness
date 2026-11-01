# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import re
    result = []
    if not raw:
        return ''
    for token in raw.split(';'):
        match = re.fullmatch(r'([A-Za-z0-9_]+)/(\d+)/(\d+)', token)
        if not match:
            return 'error'
        result.append(f'{match.group(1)}:{int(match.group(2)) * int(match.group(3))}')
    return ';'.join(result)
