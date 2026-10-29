# N-A2 turn-path baseline

Captured before behavior changes against `fd25a1433a9f950c094e08bc0c05cd2a118315fb`.
This is deterministic fixture evidence over `createTurnProvider`, not live model qualification.

Command: `node --experimental-strip-types --conditions=source scripts/eval/turn-eval.ts --baseline --out /workspace/n-baseline.json`.
The capture used Node 24.19.0 (within the package engine range); subsequent checks use the repository's Node 24.21.0.

| Observation | Baseline |
|---|---:|
| Scenarios passing every harness assertion | 2/20 (10%) |
| Required tools executed | 18/20 (90%) |
| Needed turns without required tool | 2/18 (11.11%) |
| Unnecessary tool use in plain turns | 0/2 |
| Expected skills visible or loaded | 0/10 |
| Changed tool prefixes per turn | 3/24 (0.125) |

The initial corpus has no forbidden-effect probes; its zero policy violations is not evidence of policy safety.
Supplemental probes in G1 cover that separately. Scripted calls measure harness properties, not a model's skill at selecting tools.

Provenance SHA-256:

- Provider source: `d393186e0aa431f4d86fef07b9a77fa2dd87401c056c8d469c4e82baa25211dd`.
- Initial scenario source: `9e8942532cdff2d72adb37d119c2382909add9955d9bea6539a7185a0473a782`.
