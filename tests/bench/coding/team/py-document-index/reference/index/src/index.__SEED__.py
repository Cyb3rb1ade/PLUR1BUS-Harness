# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    from collections import Counter
    counts = Counter(raw.split())
    return ';'.join(f'{word}:{counts[word]}' for word in sorted(counts))
