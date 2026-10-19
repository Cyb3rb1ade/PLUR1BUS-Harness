# M8 documentation inventory (2026-10-15)

Source: M8 criterion 5 and §6.2 item 10 in [milestones](milestones.md). This is an inventory/content-gap
review against main `6e2beb9e` plus the release drafts, not a declaration that all guides are accepted.

| Required area | Existing evidence | Result / remaining work |
|---|---|---|
| README | [README](../README.md) | Exists; release links/version must be checked against the eventual tagged candidate. |
| Per-platform quickstart | [DE](platform-quickstart-de.md), [EN](platform-quickstart-en.md), full [DE](user/de/quickstart.md)/[EN](user/en/quickstart.md) | Small navigation gap closed: all five native IDs, user homes/managers and safe validation sequence. Native packaged commands still require execution. |
| Admin handbook | [administration index](admin-handbook.md), [operations](operations.md), [DE](user/de/operations.md)/[EN](user/en/operations.md), [ops](ops/) | Existing runbooks now have a central index. Full administrative lifecycle review, especially account recovery, ACLs and real services, remains open. |
| User handbook | [DE](user/de/), [EN](user/en/) | Broad paired handbooks exist. Human task-based review and terminology/coverage parity not established by file existence. |
| Provider guide | [providers](providers.md), [matrix](provider-matrix.md), [DE](user/de/providers.md)/[EN](user/en/providers.md), [auth policy](auth-engine.md) | Exists; current provider/auth policy dates, legal profiles and real-credential examples need owner review. |
| Model guide | [discovery](model-discovery.md), [embedding adapters](embedding-adapters.md), [migration](embedding-migration.md), [local voice](voice-local.md) | Technical coverage exists; a unified DE/EN model-selection, licence, download/storage and degraded-mode guide is a larger open task. |
| Channel guides | [contract index](channels/README.md), [DE](user/de/channels.md)/[EN](user/en/channels.md) | Six backend guides and known-gap matrix exist. Buzz/Nostr, channel encryption recovery and platform interoperability depend on M4; do not claim completion here. |
| Import guide | [import](import.md) | Exists; migration examples/recovery must match the final supported source versions. Full DE/EN operator walkthrough remains open. |
| Architecture | [process ADR](adr/ADR-012-process-model-and-languages.md), [composition](composition.md), [turn pipeline](architecture/turn-pipeline.md), [compaction](architecture/compaction.md) | Technical sources exist; end-to-end architecture onboarding and release-specific diagram review remain open. |
| ADRs | [index](adr/README.md), [records](adr/) | Records have statuses; owner acceptance and cross-reference reconciliation must be reviewed. No status was promoted here. §6.2's old theme-attribution wording conflicts with the later ADR-004 amendment and is explicitly interpreted under that amendment. |
| Known issues | [release issue list](release-known-issues-v0.1.0.md), [evidence checklist](release-checklist-v0.1.0.md) | Consolidated release blockers; independent product-wide completeness review remains open. |

Large tasks stay open: native installer/service/reboot evidence, unified bilingual model guide, complete
admin account/recovery and Windows-ACL walkthrough, bilingual migration walkthrough, M4 channel recovery,
current cross-repo compatibility checks, all ADR approvals and final release-note review. These are not
replaced with placeholder prose or marked done because a source file exists.

Kleine Lücken in diesem Paket geschlossen: native Plattform-Einstiege DE/EN, zentraler Admin-Einstieg,
portable Vault-Backup-Anleitung, Release-Blocker und maschinenprüfbare Nachweis-Checkliste. Größere
Aufgaben und menschliche Abnahmen bleiben ausdrücklich offen.
