# Original MIT benchmark fixture; the generated README states the contract.
import json
import math
import os
from pathlib import Path
import stat
import tempfile

def BENCH_FN(path, now, ttl, compute):
    """Implement the generated README contract."""
    path = Path(path)
    try:
        current = path.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and (not stat.S_ISREG(current.st_mode)):
        raise ValueError('cache must be a regular file')
    try:
        cached = json.loads(path.read_text(encoding='utf-8'))
        saved = cached['savedAt']
        if (
            type(saved) in (int, float) and math.isfinite(saved)
            and ttl > 0 and 0 <= now - saved < ttl
        ):
            json.dumps(cached['value'], allow_nan=False)
            return cached['value']
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        pass
    value = compute()
    data = json.dumps({'savedAt': now, 'value': value}, allow_nan=False).encode('utf-8')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fchmod(
                output.fileno(), stat.S_IMODE(current.st_mode) if current is not None else 0o600
            )
            os.fsync(output.fileno())
        if path.is_symlink():
            raise ValueError('cache must not be a symlink')
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return value
