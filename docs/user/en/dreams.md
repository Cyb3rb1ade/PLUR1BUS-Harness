# Dreams

Dreaming is the memory's background clean-up. At set times, and when enough new material has been captured, the harness has the memory engine go through an agent's recent captures. You see what ran, when and with which result on the Dreams tab of the Memories page (`#/memories/dreams`). The German version of this page is [../de/traeume.md](../de/traeume.md).

The harness only schedules and guards the runs and keeps a ledger. The work itself is done by the memory engine. Every run costs model tokens, which the ledger records per run. Tokens are measured, not capped.

## The three phases

Each agent has three phases. Each has its own schedule, its own on/off switch, its own status and its own log.

| Phase | Default schedule | Engine jobs it runs |
|---|---|---|
| **Light** | every 4 hours (`0 */4 * * *`) | `light-dream`, `embedding-drain` |
| **REM** | daily at 01:15 (`15 1 * * *`) | `rem-dream`, `discover-semantic-links` |
| **Deep** | daily at 04:00 (`0 4 * * *`) | `consolidate-daily`, `auto-accept-stale`, `gc-run` |

The schedule is a cron expression with five fields and an explicit time zone, which defaults to the time zone of the computer when the schedule was created. Start times are spread out a little per agent so that many agents do not start at the same moment, and at most three phases run at once.

## What starts a run

- **Importance:** every stored capture adds to a counter per phase. When the counter reaches the threshold of the phase (Light 150, REM 300, Deep 450), the phase runs, at most once per minimum gap (1, 6 and 12 hours).
- **Schedule:** the phase runs at its scheduled time. If too little has been captured since its last run (Light 1, REM 3, Deep 3 captures), the run is skipped.
- **Catch-up:** after downtime, a phase whose time was missed runs once, not once per missed time.
- **Manual:** you start a phase yourself with **Run now**. It takes every guard except the schedule.

## What stops a run

Guards can skip or end a run. Every skip is written to the ledger with its reason:

| Reason | Meaning |
|---|---|
| `idempotent` | The same material in the same window has already been processed. |
| `min_corpus` | Too little new material since the last run. |
| `already_running` | The same phase of this agent is running already. |
| `no_candidates` | Only in older entries: until recently a Deep run stopped here when no memory passed the check for candidates. Deep runs now do their upkeep regardless. |
| `no_llm_route` | The engine has no model to use for this phase. |
| `breaker_sessions`, `breaker_open` | The circuit breaker: an agent may start three model sessions per UTC day across REM and Deep. The fourth is not started, the run counts as aborted, and the breaker stays open until the next UTC midnight. |

A run whose engine job fails is recorded as failed, never as completed. A run that was cut off by a crash is marked aborted at the next start, and its material stays eligible.

## The Dreams tab

The tab opens with **Has dreaming run?**. It shows the latest run and how many phases have ever run. If none has, the tab says **Never ran**: check that the phases are enabled and have enough material, or run one now.

Below that, each agent has a section with its **Diary file** (shown as written or missing) and one card per phase:

- **Schedule** with the cron expression and time zone, and the **Next run**. A disabled phase has none.
- **Last run** with its result (**Completed**, **Skipped**, **Failed**, **Aborted** or **Open**), start time and what started it (scheduled, importance, manual or catch-up), plus the reason or the error.
- **Importance**: the counter against the threshold, and the captures since the last run.
- **Circuit breaker**: closed with the sessions used today, or open until a given time with the reason.
- **Run now** and **Enable** or **Disable**.

At the bottom, **Scheduler counters** sum up runs, skips by reason, triggers, breaker trips and crashed runs that were cleaned up.

The **Run log** lists up to 50 runs and can be filtered with **Filter by phase**. A run opens in a detail view with its **Run id**, job, trigger, reason, start, end, duration, counts, tokens in and out, and its log text. Logs are kept for 30 days and a skipped run writes none; ledger rows are kept for 365 days. An empty run log means that nothing was ever tried, because even a skipped run leaves a row.

## Run now, enable and disable

**Run now** first asks the guards in a dry run and shows whether the run would go ahead or be skipped, and why. Only then do you confirm. A confirmed run starts at once, may call the model and may change memory. The page then reports the run and links to it.

**Disable** stops the schedule and the importance trigger of one phase. **Run now** still works. **Enable** turns them on again.

Who may do what: Owner, Admin and Operator can run a phase. Only Owner and Admin can enable, disable or change a schedule. The buttons are marked unavailable for other roles. If the server refuses an action anyway, the page keeps it disabled until you reload. Reading status, schedule and log is open to every role; if a part is refused, the tab says so.

## On the command line

```sh
plur1bus dreams status --agent main
plur1bus dreams run light --agent main --dry-run
plur1bus dreams run rem --agent main
plur1bus dreams log --agent main --phase deep --limit 10
plur1bus dreams log --run <run-id>
plur1bus dreams schedule get --agent main
plur1bus dreams schedule set deep --agent main --cron "30 3 * * *" --timezone Europe/Berlin
plur1bus dreams disable light --agent main
plur1bus dreams enable light --agent main
plur1bus dreams diary --agent main
```

- `dreams status` shows the phases, last and next run, breaker, importance and counters; without `--agent` it covers all agents.
- `dreams run` takes `light`, `rem` or `deep`. `--dry-run` evaluates the guards and prints what would happen, without a ledger row and without calling the engine. An engine job name such as `gc-run` also works and runs that job.
- `dreams log` shows the phase ledger with `--phase`, or one run and its log with `--run`. Without `--phase` it shows the engine job history.
- `dreams schedule set` changes `--cron` (five fields), `--timezone` (an IANA name such as `Europe/Berlin`) or `--enabled` (`true` or `false`) of one phase.
- `dreams diary` prints the private diary of the agent. Owner, Admin or a person with the right **Manage** on the agent can read it. The web page does not open the diary, it only shows whether the file exists.

All dreams commands are marked experimental in the command reference.

## Next

- Memories and their health: [memories.md](memories.md)
- Recurring jobs of your own: [recurring-tasks.md](recurring-tasks.md)
- Usage and limits: [budgets.md](budgets.md)
- Roles and rights: [users-and-roles.md](users-and-roles.md)
