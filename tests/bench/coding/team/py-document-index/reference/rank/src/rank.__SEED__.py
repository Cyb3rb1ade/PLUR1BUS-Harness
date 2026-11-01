# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    if not raw:
        return 'none'
    counts = {}
    for token in raw.split(';'):
        parts = token.rsplit(':', 1)
        if len(parts) != 2 or not parts[0] or not parts[1].isdigit() or int(parts[1]) < 1 or parts[0] in counts:
            return 'error'
        counts[parts[0]] = int(parts[1])
    return min(counts, key=lambda word: (-counts[word], word))
