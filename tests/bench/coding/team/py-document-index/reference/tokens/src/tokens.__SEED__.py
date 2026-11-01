# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    words = []
    word = ''
    for char in raw:
        if char.isalnum():
            word += char.lower()
        elif word:
            words.append(word)
            word = ''
    if word:
        words.append(word)
    return ' '.join(words)
