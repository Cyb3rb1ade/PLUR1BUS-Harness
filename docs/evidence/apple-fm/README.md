# Apple Foundation Models evidence

For **AF0**, the authoritative full protocol, latency, CLI-RSS and socket-edge evidence is
[2026-11-01-probe-final.md](./2026-11-01-probe-final.md)
([JSON](./2026-11-01-probe-final.json)). The review corrected derived conclusions while preserving
that run's wire events, CLI output, server logs, timings and original observation ids.

The additional [review follow-up](./2026-11-01-probe-review.md)
([JSON](./2026-11-01-probe-review.json)) establishes the native streaming-overflow shape and measures
post-start stdin-pipe EOF and direct-parent death over ten seconds each. Its collector source is
`6572e0da2e3b4977897126355a8401833895c019`, with a clean tree and source-file SHA-256 values recorded
before receipt creation. Full protocol, latency, RSS and socket-edge probes were not repeated.

The [original stopped report](./2026-11-01-probe.md)
([JSON](./2026-11-01-probe.json)) remains byte-identical. Its exit-code interpretation was superseded
by the Controller: availability comes from the `system` row, regardless of `fm models` exit status.
The [continued-run report](./2026-11-01-probe-continued.md)
([JSON](./2026-11-01-probe-continued.json)) records the intermediate collector-readiness defect.
The superseded `probe-full.*` files were removed. [AF0 verification](./2026-11-01-validation.md)
records the focused checks and remaining measurement limits.

Key findings: at least **5056 server prompt tokens** were accepted, refuting a 4096-token shared
hardware window; **4096 remains conservative catalog/guard policy**. At 8193 standalone CLI tokens,
non-streaming overflow is HTTP 500 JSON; streaming overflow is HTTP 200 SSE with a role chunk, then
the same transcript-size error and no `[DONE]`. Parent death and post-start stdin EOF both left the
server reachable at three samples over ten seconds. Behavior after those intervals remains unmeasured.

Reproduce the focused run on an authorized macOS arm64 host with a new output filename:

```bash
export PATH="$HOME/.node24/bin:$PATH"
export TMPDIR=/private/tmp
PLUR1BUS_APPLE_FM_LIVE=1 node scripts/spikes/apple-fm-probe.mjs \
  --out docs/evidence/apple-fm/NEW-follow-up.json --scope follow-up \
  --prior-receipt 2026-11-01-probe-final.json
```

Both output siblings are reserved with `wx`; existing evidence is never overwritten. Live execution
refuses CI. Repeated HUP/INT/TERM trigger owned group teardown and automatic PID/group ESRCH checks.
SIGKILL of the collector cannot be intercepted and can leave detached groups and its temporary tree.

[Offline D4 verification](./2026-11-02-d4-validation.md) covers the readiness race and future receipt
collection/rendering corrections, including 50 process-suite runs under CPU load. It does not replace
or remeasure any native receipt above.
