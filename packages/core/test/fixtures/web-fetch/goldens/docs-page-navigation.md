# Configuring the scheduler

The scheduler decides which queued job runs next. It is configured in `quillstone.toml` under the `[scheduler]` table.

## Concurrency

Set `max_parallel` to the number of jobs that may run at the same time. The default is the number of CPU cores.

```toml
[scheduler]
max_parallel = 4
tick_ms = 250
```

## Priorities

Jobs carry a priority from 0 (lowest) to 9. Within one priority, jobs run in the order they were queued.

## Fairness

Enable `fair_share` to stop one tenant from filling every slot. Each tenant then gets at most `max_parallel / tenants` slots while others are waiting.
