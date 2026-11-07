# Original MIT benchmark fixture; the generated README states the contract.
from copy import deepcopy

def BENCH_FN(records):
    """Implement the generated README contract."""
    positions, result = ({}, [])
    for record in records:
        identity = record['id']
        if identity not in positions:
            positions[identity] = len(result)
            result.append(deepcopy(record))
        else:
            result[positions[identity]].update(deepcopy(record))
    return result
