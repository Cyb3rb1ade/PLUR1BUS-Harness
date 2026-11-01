# SPDX-License-Identifier: MIT
def decode(raw: str) -> str:
    import re
    match = re.fullmatch(r'(-?)(\d+)\.(\d{2})@(\d+)', raw)
    if not match or int(match.group(4)) > 10000:
        return 'error'
    cents = int(match.group(2)) * 100 + int(match.group(3))
    if match.group(1):
        cents = -cents
    return f'{cents}@{int(match.group(4))}'

def tax(raw: str) -> str:
    import re
    match = re.fullmatch(r'(-?\d+)@(\d+)', raw)
    if not match or int(match.group(2)) > 10000:
        return 'error'
    cents, rate = int(match.group(1)), int(match.group(2))
    numerator = abs(cents) * (10000 + rate)
    rounded = (numerator + 5000) // 10000
    return str(-rounded if cents < 0 else rounded)

def format_money(raw: str) -> str:
    return "unimplemented"
