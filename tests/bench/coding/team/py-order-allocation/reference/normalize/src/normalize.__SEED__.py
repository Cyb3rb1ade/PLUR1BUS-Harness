# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import re
    rows = {}
    if not raw:
        return ''
    for token in raw.split(';'):
        match = re.fullmatch(r'([A-Za-z0-9_]+)/(\d+)/(\d+)', token)
        if not match:
            return 'error'
        sku, quantity, price = match.group(1), int(match.group(2)), int(match.group(3))
        if sku in rows and rows[sku][1] != price:
            return 'error'
        rows[sku] = (rows.get(sku, (0, price))[0] + quantity, price)
    return ';'.join(f'{sku}/{quantity}/{price}' for sku, (quantity, price) in sorted(rows.items()))
