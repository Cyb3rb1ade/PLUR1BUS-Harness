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
    return "unimplemented"

def format_money(raw: str) -> str:
    return "unimplemented"
