# D125: Jev for message triage only as an explicit opt-in

**Status.** This plan records an owner decision; there is no product code yet. Decided 2026-11-06.

**What it changes.** D125 amends D105 ("Cost of the call") and ADR-015 (backend order for triage).

**Executor.** Sonnet. TypeScript; one Harness PR.

**Effort.** About 2 agent-days.

## 1. Background

PLUR1BUS 7.19 (the OpenClaw plugin) changed what happens once a decision model is selected. Its built-in runtime now filters the tools offered in conversations through TypeSafe Jev. To do that, it sends a bounded excerpt of the conversation history to TypeSafe, and those calls are billed as usage. Turning `decisionAssistance` off stops it.

The owner asked on 2026-11-06 whether the Harness should adopt this. The behaviour is already designed here:
- **D103:** category routing of tools and skills, with at most 3 categories, a 12-item shortlist, and `capabilities.search` always available.
- **D105:** one triage call per message that carries the category distribution, the model class and the effort.

The open question is only where the triage text goes.

## 2. State on `main` (verified 2026-11-06)

**Triage runs on the decision role only.**
- `DecisionClient` (`packages/core/src/decision/client.ts:44`) runs `triage-compat` on `role` only, whatever `decision.backend` says.
- The System One transport (`decision/system-one.ts:94`) refuses `triage-compat`.
- With no decision role, `composition/provider.ts` runs rule triage without any model call.

**Triage input.** The input is the last user message only (`provider.ts:225`).

**What reaches Jev today.** The only call that marks a request cloud-eligible is the synthetic `decision.test` probe (`composition/index.ts`), which asks whether 2 is even. No conversation content reaches Jev today.

**Jev settings.**
- `decision.systemOne.jev.enabled` defaults to `false`.
- Its schema help says: "Content also requires trusted caller admission; never arbitrary tool or triage text."
- A Jev request also needs:
  - a secret reference and a call-budget reservation;
  - `cloudEligible` from the caller;
  - neither `forceLocal` nor `privacy.localOnly` set for the agent;
  - the D73 egress checks.

**Off switch.** There is no general "off" switch. Only voice turn profiles have `features.decisionService`.

## 3. Decision (owner, 2026-11-06)

Owner answer to the recommendation "keep today's default (own role or local); Jev for triage only as an explicit opt-in": **yes**. The gain would be calibrated confidence and speed; the price is conversation excerpts at a third-party provider, plus usage.

1. **The default stays.** D105 triage, and the D103 category routing it carries, runs on the `decision` role (the person's own provider or a local model), with rule triage as the fallback.
   - Neither `decision.backend: jev` nor `auto` sends triage to Jev on its own.
   - This amends D105's sentence "runs on Jev with an API key, else Kev or Laya".
2. **The opt-in is a setting of its own.** `decision.triage` takes `role` (default), `jev` or `rules`.
   - `jev` takes effect only if all of these hold:
     - `decision.systemOne.jev` is enabled with a secret reference;
     - the call budget admits the call;
     - the turn is cloud-eligible: no `privacy.localOnly` for the agent, no `forceLocal`;
     - D73 egress allows the Jev origin.
   - If any of these fails, triage falls back to `role`, then to rules, within the single triage deadline. As ADR-015 requires, a fallback never resets the deadline.
3. **The content Jev may see is bounded.**
   - Allowed:
     - the current user message and the previous user message of the same session, each cut to its first 4,000 characters at a code-point boundary;
     - the category list (stable ids, names, one-line descriptions);
     - the class and effort options.
   - Never sent:
     - assistant replies, tool calls or tool results;
     - attachments, memories, the system prompt or persona;
     - secrets or D116 private entries;
     - content from other sessions.
   - The caller builds this view (ADR-015, "smallest permitted view"). It is the only place that sets `cloudEligible: true` for triage.
4. **`rules` is the general off switch.** It means rule triage only, with no model call. It is the counterpart of OpenClaw's `decisionAssistance` off. Voice turn profiles keep `features.decisionService`.
5. **Transparency.**
   - Choosing `jev` shows this notice in web settings, after `plur1bus config set` and in the desktop app (German and English): "Triage sends your current and previous message to TypeSafe Jev. This uses your Jev quota. Set `decision.triage` to `role` or `rules` to stop it."
   - `plur1bus doctor` shows the active triage source.
   - Every Jev triage call goes through the call budget (provider `jev`) and appears in `decision.completed` with backend, elapsed time and outcome, never content.
6. **The ADR-015 gates are unchanged.**
   - The German gate, real Jev approval and the owner's chat authorisation of paid calls stay separate gates.
   - Tests use loopback with recorded response shapes.

## 4. Mapping triage to Jev

Jev offers Choice, Score and Noul, but no task segmentation, so the `jev` path works like this:

- **Shape.** Rule triage decides the shape (`chat`, `followup`, `single`, `multi`) as today.
  - `chat` and `followup` make no Jev call.
  - `multi` runs the role triage, so segmentation and `dependsOn` stay as they are, and Jev is skipped.
- **`single` messages.** One Jev request carries Choice questions for three things:
  - the category distribution over the category list (keep the top 3 or fewer);
  - the model class over `small`, `medium`, `large` and `frontier`;
  - the reasoning effort.

  The System One body already names questions in a map (`questions.decision`). J2 checks against the API reference whether one request takes several named questions:
  - **If it does:** the transport accepts exactly those answer keys and no others.
  - **If it does not:** Jev answers the category distribution only, and class and effort keep the rule triage's defaults. No second call is added.
- **Low confidence.** Below `decision.confidence.triage`, or when the answer is invalid, triage advances to `role`, then to rules, within the same deadline.

## 5. Tasks (one Harness PR)

| Task | Scope | Files | Estimate |
|---|---|---|---|
| **J0** | This plan, plus amendment notes in ADR-015 and in D105 of the basics spec | `docs/` | done in this PR |
| **J1** | Config `decision.triage`: enum `role \| jev \| rules`, default `role`, `x-restart: live`, `x-tier: advanced`. Help text names the cost and the data sent. Run `pnpm gen` and `pnpm docs:gen`, and update the settings index. | `packages/config-schema/schema/config.schema.json`, `packages/web/src/pages/settings/config/meta.ts`, generated files | 0.25 |
| **J2** | Jev triage adapter: view builder (§3.3), shape gate (§4), multi-question request with closed answer keys, mapping to `TriageDecision`, confidence floor, order `jev → role → rules` under one deadline, budget reservation. Reuses the System One privacy checks unchanged. | `packages/core/src/decision/triage-jev.ts` (new), `decision/client.ts`, `decision/system-one.ts` | 0.75 |
| **J3** | Wiring: `decisionWork` in `provider.ts` reads `decision.triage` live per turn. `rules` goes straight to rule triage; `jev` passes the previous user message from `req.messages` to the adapter. | `packages/core/src/composition/provider.ts` | 0.25 |
| **J4** | Transparency: the notice (de/en catalogues) in web settings, the CLI `config set` warning and the desktop settings; a doctor row; the user doc (`docs/decision-service.md`, `docs/privacy.md`); CHANGELOG. | `packages/web`, `crates/plur1bus/src/commands/config.rs`, `docs/` | 0.25 |
| **J5** | Tests, red first, on loopback only (listed below) | `packages/core/test/decision/`, `packages/core/test/composition/` | 0.5 |

Tests for J5:
- With the default, and also with `decision.backend` set to `jev` or `auto`, nothing contacts the Jev origin.
- With `jev`, the request body holds exactly the bounded view. A long assistant reply, a tool result and an attachment in the session never appear in the body, and both messages are cut to 4,000 characters.
- Each of local-only, `forceLocal`, egress denial, budget refusal and a missing secret falls back to `role`, then to rules, and the trace says so.
- One deadline covers every fallback.
- `rules` makes zero model calls.
- A `multi` message skips Jev.
- `decision.completed` carries no message text.
- The notice appears when `jev` is chosen.

## 6. Order and gates

J1 → J2 → J3 → J4 and J5, all in one PR. No dependency on Kev or Laya.

**Acceptance.**
- `pnpm test` and `pnpm docs:check` are green.
- The `ci-gate` is green.
- Real Jev calls run only after the owner authorises them in chat (ADR-015). Until then the `jev` path is proven on loopback only.

**Stop and report if** the System One API cannot express the category distribution as one Choice question. In that case Jev cannot route tools without a second call, and the owner decides again.
