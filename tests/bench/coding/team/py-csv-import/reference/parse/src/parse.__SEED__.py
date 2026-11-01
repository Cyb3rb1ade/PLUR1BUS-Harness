# SPDX-License-Identifier: MIT
def solve(raw: str) -> str:
    import csv
    import io
    import re
    result = []
    try:
        for row in csv.reader(io.StringIO(raw), strict=True):
            if not row:
                continue
            if len(row) != 2 or not re.fullmatch(r'[A-Za-z0-9_]+', row[0]) or not re.fullmatch(r'-?\d+', row[1]):
                return 'error'
            result.append(f'{row[0]}:{int(row[1])}')
    except csv.Error:
        return 'error'
    return ';'.join(result)
