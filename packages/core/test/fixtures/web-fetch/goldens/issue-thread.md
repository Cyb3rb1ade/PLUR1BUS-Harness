# Crash when the cache directory is read-only #311

Open · opened by [wren]({{BASE}}/u/wren) on 12 June 2026 · 2 comments

## Description

Starting the daemon with `CACHE_DIR` on a read-only mount aborts with a stack trace instead of a message.

Steps to reproduce:

1. Mount an empty volume read-only at `/srv/cache`.
2. Run `daemon --cache /srv/cache`.

### Reply from [kestrel]({{BASE}}/u/kestrel)

Reproduced on 3.8.1. The crash is in the warm-up routine, which writes a probe file before checking permissions.

```
Error: EROFS: read-only file system, open '/srv/cache/.probe'
    at warmUp (cache.js:41)
```

### Reply from [wren]({{BASE}}/u/wren)

Thanks. A clear error would be enough for me; falling back to memory-only caching would be a bonus.
