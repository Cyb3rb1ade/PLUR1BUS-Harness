# M4 phase 4 — Identity and delivery

## Inventory / decisions

New principal-bound DeliveryTargets SQLite service, RPC target list/add/confirm/remove/subscribe, Recurring destination manager and job selector (DE/EN). Direct DM challenge is the sole validation authority; browser/RPC confirm only issues a new challenge. Existing pairing entropy/lifetime/limits remain unchanged. No engine changes.

User jobs optionally store deliveryTarget; create/update/run validate it under runAs. Completed turns deliver their assistant result after a second live check. System jobs and Dreams expose completion hooks wired to explicit per-person target subscriptions, sending fixed status only; system subscriptions require a current Owner/Admin. No default external delivery and no raw diary/system-detail export.

Host-only ALS now carries the real channel/account/sender/chat plus resolved person into engine memory; public RPC caller stays cli-only. Memory re-resolves the link at each call and uses canonical v2 identity and existing legacy union. Adapter metadata additions supply actual runtime bot account IDs for Telegram, Slack, Matrix and Signal. Disabled people are rejected before channel commands and turns.

## Threat table

| Attack | Guard | Test |
| --- | --- | --- |
| Foreign destination / runAs | own person + current agent.use | targets.test and user-jobs hardening |
| Confirmation from browser, group, wrong bot/chat/sender | challenge hash, exact host-verified direct route | targets.test wrong account/chat, one-use, expiry |
| Revoked target/link/allowlist | revalidate before and after async target lookup | target removal/allowlist tests |
| Concurrent quota bypass | second quota check immediately before insert | parallel 40-add test, only 32 accepted |
| Spoof canonical channel principal | host-only ALS + live exact link | genuine two-channel pairing test, unlinked refusal |
| Engine unsupported provider | host channels.register public API | real pinned-engine Matrix/Buzz private recall test |
| Private system output | fixed status only, current owner/admin | explicit subscription test |

## Behaviour changes

Channel memory uses actual transport provenance with one shared canonical user principal. Transport identifiers remain evidence, not RPC authority. A paired person is the same person across channels; unlinked inputs do not receive their recall union. Persona/temporal mood context may legitimately vary between turns; private recalled data is the acceptance invariant.

## Owner questions

No new dependency. Existing pairing entropy question remains open. Delivery confirmation uses a separate cryptographic one-time challenge and does not change pairing codes.

## Hotspots

Additive adapter account metadata, router optional command hook, core wiring, user-job optional field, system completion hook, schemas/generated fixtures, Recurring page. M6 channel tools and M3 core/API wiring should merge normally.

## Validation

Node 24.21.0. Initial broad core subset: 380 tests, 378 passed, two existing TODOs. Final targeted tests after review corrections: 42/42 (real adapters, delivery, jobs, actual pinned engine). New DE/EN destination/selector browser tests pass with axe; existing recurring audit subset has two failures in unrelated run/history interactions, so no whole-Web green claim. Final lint/docs results recorded in ledger. No CI polling or external delivery.

## Known gaps

Completion subscriptions are managed through RPC; Web currently manages destinations and user-job selection, not system/Dreams subscription editing. System/Dreams delivery is an honest fixed status notification, not raw feature-result export. Runtime tests use local transport fakes; real service interoperability and all five OS targets remain acceptance work. Historical group memories are not reclassified or migrated.

Final boundary checks: RPC-schema 55/55, real core hosting 3/3, human-only delivery RPC test 1/1; built Core/Buzz/Matrix JavaScript imports succeed. No native or additional external dependency introduced.
