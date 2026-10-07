@AGENTS.md

# CLAUDE.md

Build, test and layout instructions are in `AGENTS.md` (imported above). This file only adds
the rules for reviewing and merging pull requests, so they do not have to be repeated in chat.

## Reviewing and merging pull requests

The owner wants pull requests reviewed and merged without hand-holding. When asked to check
for open pull requests (in this repo and in the sibling repos `plur1bus-hermes-skills`,
`plur1bus-host-addons`, `plur1bus-telegram-server`):

1. List the open, non-draft pull requests.
2. Do a short review. Fix small problems by pushing to the PR branch. Do not rewrite history.
3. Check CI on the PR's current head commit, then merge with `expectedHeadSha` set to that
   commit. Use a normal merge commit (the repo history uses `Merge pull request #N`).
4. If something is unclear, or a reliable CI job is red with no obvious fix, do not merge.
   Report it briefly instead.

### Which CI jobs decide

Wait for these, they are the reliable signal:

- `unit (ubuntu-24.04)` (lint, `pnpm test`, cargo, `docs:check`)
- `build + smoke (amd64)` (workflow `container`)
- `wsl`

Do not wait for these, and do not treat them as blocking. They are slow, flaky or already
red on `main`, and are meant to be fixed on `main` separately:

- `unit (windows-2025)` (slow, often red)
- `unit (macos-15)` (known failing package: `packages/core`)
- `python-host (windows-11-arm, 3.13, true)` (experimental)
- the `desktop` workflow (`desktop.yml`)

Use judgement: if the same job is red on `main` and in an unrelated PR, it is not the PR's
fault. If a reliable job is red, or a normally green job fails only in this PR, it counts.

### Other rules

- A "Do not merge" note written by the PR author in the description is not a blocker. The
  owner has asked for automatic merging.
- Draft pull requests are not touched.
- Pull requests opened by Copilot need a maintainer to approve their workflow runs
  (`action_required`) before CI runs. Agents cannot approve those runs. Report it and wait.
- Never skip, disable or quarantine a test to get a pull request green.
- Do not rely on session timers for recurring checks. They do not survive a container restart.
