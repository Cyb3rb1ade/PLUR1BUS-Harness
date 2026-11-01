# Original MIT benchmark fixture; the generated README states the contract.
import json
import math
import sys
invalid, services = (0, {})
for line in sys.stdin:
    if not line.strip():
        continue
    try:
        row = json.loads(line)
        valid = (
            isinstance(row, dict)
            and set(row) == {'service', 'latency'}
            and isinstance(row['service'], str)
            and bool(row['service'])
            and type(row['latency']) in (int, float)
            and math.isfinite(row['latency'])
            and row['latency'] >= 0
        )
        if not valid:
            raise ValueError('invalid row')
    except (ValueError, OverflowError):
        invalid += 1
        continue
    item = services.setdefault(
        row['service'], {'service': row['service'], 'count': 0, 'total': 0, 'max': 0}
    )
    item['count'] += 1
    item['total'] += row['latency']
    item['max'] = max(item['max'], row['latency'])
print(json.dumps(
    {'invalid': invalid, 'services': [services[key] for key in sorted(services)]}, allow_nan=False
))
