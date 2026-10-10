# Long conversations (compaction)

A model can only process a limited amount of text at once, its context window. A long session grows beyond it. The harness
therefore shrinks what the model sees with each answer, without losing the history. This page describes what happens,
what is hidden and what is deleted, and which settings exist. Every command here exists in this build (`docs/cli.md` is the
full reference). The German version is [../de/lange-gespraeche.md](../de/lange-gespraeche.md).

## Hide, do not delete

This is the basic principle: the harness hides material from the context that the model does not need right now. Nothing is
deleted. The complete history of a session stays in its store. Only what the model sees at the next step is hidden. If a
later turn refers to a hidden result, it comes back into the context.

There are two mechanisms for this.

## 1. Summaries

When a session grows, the harness prepares a summary of the older part after a turn, once that part reaches a share of the
context window (65 percent by default). When the summary is ready and the context becomes too full (88 percent by
default), the harness swaps the older part for the summary.

A few rules apply:

- **Before every swap, the harness saves the facts of the part being swapped out into memory.** This happens through a
  checkpoint. Information from the old part is not lost, even when it is no longer in the context.
- **Incognito sessions are excluded.** If you write with `plur1bus chat --no-memory`, no memory checkpoint is created.
- A summary has a fixed upper limit (15 percent of the window by default). If summaries themselves grow too large, they are
  condensed into a new one in several stages, and the previous one goes into it.
- A single very large message, for example a long tool output, is shortened in the context and marked with a pointer. The
  original stays in the history.

A model writes the summary, in the role `summarize`. If that model is not available, or the call exceeds the budget, the
harness takes a simple, deterministic summary instead, without a model. That path needs no model.

## 2. Hidden tool outputs

After each turn, the harness checks whether old tool calls and their results are still needed in the context. If a pair is
no longer relevant, the harness hides it. It stays in the history.

- The last three turns (default) are never hidden.
- The decider is Laya by default, a local checker on the processor. If it is not available or takes too long, a conservative
  heuristic applies. With `off` you disable hiding.
- The decision has a time budget (100 milliseconds by default). If it exceeds it, the context stays unchanged.
- If a new turn refers to a hidden result, it becomes visible again.

## Looking at sessions

Show a session by its id. The command prints the last messages:

```sh
plur1bus session list
plur1bus session show <id>
```

Continue a session:

```sh
plur1bus chat --session <id> "Where did we leave off?"
```

Archive a session without deleting it:

```sh
plur1bus session archive <id>
```

A view that shows which tool outputs are currently hidden, or which summaries apply, does not exist in this build. The
`session show` command only shows the last messages.

## Settings

All settings live under `session.compaction` in `config.json`. The default values are listed next to them.

| Key | Default | Effect |
|---|---|---|
| `session.compaction.softRatio` | `0.65` | From this share of the window, a summary is prepared |
| `session.compaction.hardRatio` | `0.88` | From this share, the finished summary is swapped in. Must be larger than `softRatio` |
| `session.compaction.summaryMaxTokens` | `1228` | Upper limit of a summary in tokens, at most 15 percent of the window |
| `session.compaction.maxMessageTokens` | `819` | Upper limit of a single message in the context; the original stays in the history |
| `session.compaction.summarizer` | `llm` | `llm` uses the role `summarize`, `digest` always takes the simple summary |
| `session.compaction.prune.enabled` | `true` | Turns hiding of tool outputs after each turn on or off |
| `session.compaction.prune.keepLastTurns` | `3` | The last N turns are never hidden |
| `session.compaction.prune.decider` | `laya` | `laya`, `heuristic` or `off` |
| `session.compaction.prune.maxMs` | `100` | Time budget of the decision in milliseconds |
| `session.compaction.prune.batchSize` | `16` | At most this many tool pairs in one decision |

An example for a more cautious setting that summarizes earlier:

```json
{
  "session": {
    "compaction": {
      "softRatio": 0.5,
      "hardRatio": 0.8,
      "summarizer": "llm",
      "prune": { "enabled": true, "keepLastTurns": 5, "decider": "heuristic" }
    }
  }
}
```

### The model for summaries

The role `summarize` determines which model writes summaries. For this the harness uses a model profile named `summarize`
from `modelProfiles`. You create a profile with this name in `config.json`, with the candidates you want to use. If it is
missing, or none of its candidates is usable, the deterministic path applies. How to create and connect profiles is
described in [providers.md](providers.md).

The summary may not call tools and receives no memory content. It sees only the part of the history that it summarizes.

## Next

- [quickstart.md](quickstart.md): first steps, chat and memory.
- [providers.md](providers.md): providers, model profiles and fallback.
- [operations.md](operations.md): changing configuration and troubleshooting.
