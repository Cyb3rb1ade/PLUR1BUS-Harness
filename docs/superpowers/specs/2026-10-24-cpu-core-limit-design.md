# CPU core limit for PLUR1BUS processes (`supervisor.maxCores`)

Owner request, 2026-10-24: there should be no fixed limit by default. Instead, the settings (CLI and web UI) detect how
many CPU cores the host has and let the owner choose, with a slider, how many of them PLUR1BUS processes may use at
most. Thread counts are not limited; the owner confirmed that the setting is about cores only.

## Why the fixed limit goes

The sandbox launcher `plur1bus-sandbox-limits` set `RLIMIT_NPROC` to a fixed value (64 in `packages/core`, 32 in the
sandbox test). On Linux that limit does not count the processes of one sandbox. It counts every thread of the user, on
the whole system. bubblewrap must create a new task to set up its namespaces, so it fails as soon as the user already
runs that many threads anywhere (`bwrap: Creating new namespace failed: Resource temporarily unavailable`). Reproduced
as a non-root user: limit 32 works with no other tasks and fails with 42; limit 64 fails with 73. A desktop session runs
hundreds of threads, so a sandboxed `exec.run` could not start there at all, and the cloud test session failed the
same way. No fixed value can work, so the launcher stops setting it. CPU time (`RLIMIT_CPU`), address space
(`RLIMIT_AS`, not on macOS) and core dumps (`RLIMIT_CORE=0`) stay limited per process.

## Goals

- No process-count limit by default, in the sandbox or anywhere else.
- One setting, `supervisor.maxCores`: the largest number of CPU cores every PLUR1BUS process may run on. Default `0`,
  meaning every core. It applies at once (`x-restart: live`), without a restart.
- The host's core count is detected by the supervisor and shown in the CLI (`plur1bus daemon status`) and in the web
  UI, where the setting is a slider from 1 to the detected count. The right end means every core.
- The status says honestly when a limit cannot be enforced.

## Non-goals and anti-goals

- No limit on threads or processes. Idle threads cost almost nothing, and limiting them breaks programs.
- No per-sandbox process cap in this change. A real one needs a cgroup v2 `pids.max`, which only works where a cgroup
  is delegated to the user. That is a separate follow-up.
- Anti-goal: a setting that silently does nothing. Where the OS cannot bind processes to cores, `daemon.status` reports
  `unsupported` and the web UI says so next to the slider.

## Approaches considered

1. **CPU affinity for every PLUR1BUS process, applied by the supervisor (chosen).** The supervisor starts every
   long-running PLUR1BUS process (core, API, modules) and the core starts the tool processes, so binding the supervisor's
   process tree covers all of them. Affinity is inherited by every new thread and child process. It works without
   privileges on Linux (`sched_setaffinity`) and Windows (`SetProcessAffinityMask`), and also inside containers, where
   the kernel intersects it with the container's cpuset.
2. **A cgroup CPU quota (`cpu.max`).** Precise, but needs a delegated cgroup (systemd user slice or root), is
   Linux-only and does not exist in the default install. Rejected.
3. **Only the sandboxed tool processes, in the launcher.** Simple, but misses the core itself, where the memory engine's
   embedding and reranking models use most of the CPU. Rejected.
4. **Smaller thread pools (libuv, ONNX).** A soft hint, not a cap, and the engine has no such setting. Rejected.

## Decisions

- **Key and values.** `supervisor.maxCores`, integer 0 to 1024, default 0, `x-restart: live`, `x-tier: advanced` like
  every `supervisor.*` key, writable by owner and admin like the other config keys. A value at or above the detected
  count means every core, so a configuration copied to a smaller host keeps working.
- **Detection.** At start the supervisor records the CPUs its own affinity allows (the cores the OS, a container or the
  service unit gave it) and `available_parallelism()`, which also honours a cgroup CPU quota. That count is
  `cpu.detected`. Nothing in PLUR1BUS starts a supervisor, so the start affinity is never one PLUR1BUS narrowed itself.
- **Binding.** A limit `k` below the detected count binds to the first `k` CPUs of the start set. Linux binds every
  thread of the supervisor's whole process tree, found through `/proc`, plus the tree of an adopted core, which is no
  longer its descendant. Windows binds the supervisor and each running child; processes those children started
  earlier keep their old binding until they restart. macOS has no interface to bind a process to cores: the limit is
  stored and reported as `unsupported`. Going back to no limit restores the start set.
- **When.** Once at start, before any child is spawned; again on every change of the running configuration (a
  `config.set` or a hand edit); and after a core is adopted.
- **Status.** `daemon.status` gains an optional `cpu` object: `detected`, `maxCores`, `effective` (cores every process
  may use now) and `state` (`unlimited`, `limited`, `unsupported`, `failed`) with a `reason` for the last two. It is
  additive on an experimental method, so the RPC version stays 1.6.0 (ADR-016 §2).
- **CLI.** `plur1bus config set supervisor.maxCores <n>` sets it; `plur1bus daemon status` prints a `cpu:` line and
  passes `cpu` through in `--json`.
- **Web UI.** Settings → General, Supervisor group: the field is a slider from 1 to `cpu.detected` when the supervisor
  reports it, with the right end stored as 0. The section reads `daemon.status` for this, which the API now passes
  through for owner and admin sessions (the supervisor already restricts it to those roles). Without a detected count
  the field stays the plain number input with the schema bounds.
