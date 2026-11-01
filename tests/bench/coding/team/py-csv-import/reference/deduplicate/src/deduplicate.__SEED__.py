# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import re
    scores = {}
    if not raw:
        return ''
    for token in raw.split(';'):
        match = re.fullmatch(r'([A-Za-z0-9_]+):(-?\d+)', token)
        if not match:
            return 'error'
        name, score = match.group(1), int(match.group(2))
        scores[name] = max(scores.get(name, score), score)
    return ';'.join(f'{name}:{score}' for name, score in sorted(scores.items()))
