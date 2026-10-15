# Release-Checkliste v0.1.0 — prüfbare Nachweise

Stand 15.10.2026; Basis `origin/main` @ `6e2beb9e`, plus Drafts [#522](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/522), [#524](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/524), [#527](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/527). **Keine Release-Freigabe.**

Die 14 Zeilen entsprechen `docs/milestones.md` §6.2. `erfüllt` verlangt einen benannten, bestandenen Nachweis; `offen` enthält fehlende Teilnachweise; `manuell` verlangt einen Menschen/echte Hardware. Dateiexistenz oder ein PR-Link beweist keinen grünen Lauf. Erste eigene funktionale Smoke-Ergebnisse auf Linux x64 und ARM sind grün (Run 38764711674); die übrigen Targets waren bei der einmaligen Sichtung noch in Arbeit/Warteschlange. Das ist weder T6 noch drei stabile Läufe.

Die historischen Kriterien werden nicht stillschweigend geändert: Die Token-Herkunft in Zeile 8 wird nach dem späteren ADR-004-Amendment vom 01.10. bewertet.

| # | Status | Kriterium | Nachweis / Restlücke |
|---|---|---|---|
| 1 | offen | Alle M1–M8-/§12-Kriterien und L1–L16 belegt | [docs/milestones.md](../docs/milestones.md) — Milestone-Abnahmen und vollständige L1–L16-Zuordnung fehlen. |
| 2 | offen | Fünf Targets T6 grün; Q2 macOS x64 dokumentiert | [.github/workflows/release-smoke.yml](../.github/workflows/release-smoke.yml), [docs/platform-matrix.md](../docs/platform-matrix.md), [tests/e2e/smoke.test.ts](../tests/e2e/smoke.test.ts) — Installierter Smoke mit Fake-Chat, echten Modellen/Reranker/Restart sowie bestehende Realmodell-Prüfung je Target konfiguriert; fünf native grüne Ergebnisse fehlen. |
| 3 | offen | B1–B10-Zahlen, vier Gates und T1–T7 | [docs/platform-matrix.md](../docs/platform-matrix.md), [docs/milestones.md](../docs/milestones.md) — Keine neue Referenzhardware-Messung oder Owner-Waiver. |
| 4 | offen | Admin-freie Installer, Modi, Doctor, Rollback, Uninstall | [crates/plur1bus/tests/setup.rs](../crates/plur1bus/tests/setup.rs), [tests/e2e/smoke.test.ts](../tests/e2e/smoke.test.ts), [crates/plur1bus/tests/update_apply.rs](../crates/plur1bus/tests/update_apply.rs) — Lokal macOS funktional/Parity belegt; native Plattformen, Windows-ACL und native Windows-Rollback-Ergebnisse offen. |
| 5 | manuell | Services und echter Neustart je OS | [docs/reboot-survival.md](../docs/reboot-survival.md), [crates/plur1bus/tests/service_real.rs](../crates/plur1bus/tests/service_real.rs), [crates/plur1bus/tests/reboot.rs](../crates/plur1bus/tests/reboot.rs) — Echter Neustart bleibt pro OS offen; simulierte Tests ersetzen ihn nicht. |
| 6 | offen | Backup/Restore inkl. Vault, Users, Sessions und Dream-Ledger | [tests/system/portable-backup.test.ts](../tests/system/portable-backup.test.ts), [scripts/release/portable-backup.mjs](../scripts/release/portable-backup.mjs), [docs/portable-backup.md](../docs/portable-backup.md) — Lokaler Fallback-Round-Trip und Dry-Run belegt; echte Keyrings/native fünf Targets und Unterbrechungsrecovery offen. |
| 7 | offen | Auth-Policy höchstens 90 Tage alt; prohibited-Profile nicht ladbar | [docs/auth-engine.md](../docs/auth-engine.md), [packages/providers](../packages/providers) — Vollständiger datierter Policy-/CI-Abgleich nicht Teil dieses Nachweises. |
| 8 | offen | Lizenz-/NC-Modell-Nachweise nach geltendem ADR-004 | [THIRD_PARTY.md](../THIRD_PARTY.md), [THIRD_PARTY-LICENSES.txt](../THIRD_PARTY-LICENSES.txt), [docs/adr](../docs/adr) — Generierte Attribution vorhanden; native Artefakte und unabhängige Vollständigkeitsprüfung offen. Die alte Token-Attributionsforderung ist durch ADR-004 vom 01.10. ersetzt. |
| 9 | offen | CSP, deny-by-default, Audit, Redaction, Red-Team | [docs/security.md](../docs/security.md), [docs/audit-chain.md](../docs/audit-chain.md), [docs/dependency-policy.md](../docs/dependency-policy.md), [docs/release-p3-backup-quality-handoff.md](../docs/release-p3-backup-quality-handoff.md) — Audit rot: 6 moderate, 8 high, 1 critical. Vollständige Security-Abnahme/Containment offen. |
| 10 | offen | Doku vollständig, ADRs Accepted, Known Issues | [docs/release-documentation-audit.md](../docs/release-documentation-audit.md), [README.md](../README.md), [docs/user](../docs/user), [docs/adr](../docs/adr) — Bestandsprüfung und Lückenliste vorhanden; Vollständigkeit/Freigabe offen. |
| 11 | offen | Kompatibilitätsmatrix veröffentlicht; Harness-Spalte gefüllt | [docs/compatibility-openclaw.md](../docs/compatibility-openclaw.md) — Aktuelle Versionskombinationen und Veröffentlichung nicht neu abgenommen. |
| 12 | offen | Engine-Publikation PR-14 und Plugin-Parität | [docs/engine-extraction.md](../docs/engine-extraction.md), [packages/core/package.json](../packages/core/package.json) — Engine-Repository/Paketpublikation und Plugin-Parität außerhalb dieses Pakets nicht geprüft. |
| 13 | manuell | Owner-Tag v0.1.0, Changelog, Release Notes und Degradierungen | [docs/release.md](../docs/release.md), [docs/manual-release.md](../docs/manual-release.md) — Tag und Veröffentlichung ausschließlich durch den Owner nach Abnahme. |
| 14 | offen | D78: zwei Upgrades, DE/EN-Notes, Signaturen, SBOM, Canary | [.github/workflows/release.yml](../.github/workflows/release.yml), [docs/updates.md](../docs/updates.md), [docs/release.md](../docs/release.md) — Keine neuen Tags/Signaturen/Canary-Nachweise; Desktop-/Container-Gates gehören den Parallelpaketen. |

Lokale Teilnachweise: Crypto/Manipulation/Rollback, strikte tsconfigs/Theme-Unabhängigkeit und Attribution-Drift sind getrennt ausführbar. Der installierte Fresh-Home-Smoke mit echten Modellen/Reranker und Neustart sowie der bestehende Realmodell-Zweisession-Test bestehen lokal auf macOS ARM. Der volle Backup-E2E-Round-Trip ist in `tests/system/portable-backup.test.ts` belegt und lokal mit Node 24.21 unter macOS ARM gelaufen. Das ist keine Hochstufung einer ganzen §6.2-Zeile.

```sh
node scripts/release/check-checklist.mjs              # Struktur/Pfade; kein Grün aus Link-Existenz
node scripts/release/check-checklist.mjs --run-local  # feste lokale Checks wirklich ausführen
node scripts/release/check-checklist.mjs --strict     # bleibt rot, solange offen/manuell
```

The validator checks evidence integrity and runs only a fixed registry of local commands. It does not query CI or infer remote success. Strict release readiness remains false while any checklist item is open/manual. Only the owner creates `v0.1.0`.

<!-- release-evidence:start -->
```json
{
  "schema": "plur1bus.release-evidence/1",
  "items": [
    {
      "id": 1,
      "status": "offen",
      "title": "Alle M1–M8-/§12-Kriterien und L1–L16 belegt",
      "evidence": [
        "docs/milestones.md"
      ],
      "gap": "Milestone-Abnahmen und vollständige L1–L16-Zuordnung fehlen."
    },
    {
      "id": 2,
      "status": "offen",
      "title": "Fünf Targets T6 grün; Q2 macOS x64 dokumentiert",
      "evidence": [
        ".github/workflows/release-smoke.yml",
        "docs/platform-matrix.md",
        "tests/e2e/smoke.test.ts"
      ],
      "gap": "Installierter Smoke mit Fake-Chat, echten Modellen/Reranker/Restart sowie bestehende Realmodell-Prüfung je Target konfiguriert; fünf native grüne Ergebnisse fehlen."
    },
    {
      "id": 3,
      "status": "offen",
      "title": "B1–B10-Zahlen, vier Gates und T1–T7",
      "evidence": [
        "docs/platform-matrix.md",
        "docs/milestones.md"
      ],
      "gap": "Keine neue Referenzhardware-Messung oder Owner-Waiver."
    },
    {
      "id": 4,
      "status": "offen",
      "title": "Admin-freie Installer, Modi, Doctor, Rollback, Uninstall",
      "evidence": [
        "crates/plur1bus/tests/setup.rs",
        "tests/e2e/smoke.test.ts",
        "crates/plur1bus/tests/update_apply.rs"
      ],
      "gap": "Lokal macOS funktional/Parity belegt; native Plattformen, Windows-ACL und native Windows-Rollback-Ergebnisse offen."
    },
    {
      "id": 5,
      "status": "manuell",
      "title": "Services und echter Neustart je OS",
      "evidence": [
        "docs/reboot-survival.md",
        "crates/plur1bus/tests/service_real.rs",
        "crates/plur1bus/tests/reboot.rs"
      ],
      "gap": "Echter Neustart bleibt pro OS offen; simulierte Tests ersetzen ihn nicht."
    },
    {
      "id": 6,
      "status": "offen",
      "title": "Backup/Restore inkl. Vault, Users, Sessions und Dream-Ledger",
      "evidence": [
        "tests/system/portable-backup.test.ts",
        "scripts/release/portable-backup.mjs",
        "docs/portable-backup.md"
      ],
      "gap": "Lokaler Fallback-Round-Trip und Dry-Run belegt; echte Keyrings/native fünf Targets und Unterbrechungsrecovery offen."
    },
    {
      "id": 7,
      "status": "offen",
      "title": "Auth-Policy höchstens 90 Tage alt; prohibited-Profile nicht ladbar",
      "evidence": [
        "docs/auth-engine.md",
        "packages/providers"
      ],
      "gap": "Vollständiger datierter Policy-/CI-Abgleich nicht Teil dieses Nachweises."
    },
    {
      "id": 8,
      "status": "offen",
      "title": "Lizenz-/NC-Modell-Nachweise nach geltendem ADR-004",
      "evidence": [
        "THIRD_PARTY.md",
        "THIRD_PARTY-LICENSES.txt",
        "docs/adr"
      ],
      "gap": "Generierte Attribution vorhanden; native Artefakte und unabhängige Vollständigkeitsprüfung offen. Die alte Token-Attributionsforderung ist durch ADR-004 vom 01.10. ersetzt."
    },
    {
      "id": 9,
      "status": "offen",
      "title": "CSP, deny-by-default, Audit, Redaction, Red-Team",
      "evidence": [
        "docs/security.md",
        "docs/audit-chain.md",
        "docs/dependency-policy.md",
        "docs/release-p3-backup-quality-handoff.md"
      ],
      "gap": "Audit rot: 6 moderate, 8 high, 1 critical. Vollständige Security-Abnahme/Containment offen."
    },
    {
      "id": 10,
      "status": "offen",
      "title": "Doku vollständig, ADRs Accepted, Known Issues",
      "evidence": [
        "docs/release-documentation-audit.md",
        "README.md",
        "docs/user",
        "docs/adr"
      ],
      "gap": "Bestandsprüfung und Lückenliste vorhanden; Vollständigkeit/Freigabe offen."
    },
    {
      "id": 11,
      "status": "offen",
      "title": "Kompatibilitätsmatrix veröffentlicht; Harness-Spalte gefüllt",
      "evidence": [
        "docs/compatibility-openclaw.md"
      ],
      "gap": "Aktuelle Versionskombinationen und Veröffentlichung nicht neu abgenommen."
    },
    {
      "id": 12,
      "status": "offen",
      "title": "Engine-Publikation PR-14 und Plugin-Parität",
      "evidence": [
        "docs/engine-extraction.md",
        "packages/core/package.json"
      ],
      "gap": "Engine-Repository/Paketpublikation und Plugin-Parität außerhalb dieses Pakets nicht geprüft."
    },
    {
      "id": 13,
      "status": "manuell",
      "title": "Owner-Tag v0.1.0, Changelog, Release Notes und Degradierungen",
      "evidence": [
        "docs/release.md",
        "docs/manual-release.md"
      ],
      "gap": "Tag und Veröffentlichung ausschließlich durch den Owner nach Abnahme."
    },
    {
      "id": 14,
      "status": "offen",
      "title": "D78: zwei Upgrades, DE/EN-Notes, Signaturen, SBOM, Canary",
      "evidence": [
        ".github/workflows/release.yml",
        "docs/updates.md",
        "docs/release.md"
      ],
      "gap": "Keine neuen Tags/Signaturen/Canary-Nachweise; Desktop-/Container-Gates gehören den Parallelpaketen."
    }
  ],
  "localProofs": [
    {
      "id": "local-backup-crypto",
      "status": "erfüllt",
      "checks": [
        "backup-crypto"
      ],
      "evidence": [
        "scripts/release/test/portable-backup.test.mjs"
      ]
    },
    {
      "id": "local-strict-theme",
      "status": "erfüllt",
      "checks": [
        "source-quality",
        "theme-regression"
      ],
      "evidence": [
        "scripts/release/check-source-quality.mjs",
        "scripts/release/test/source-quality.test.mjs"
      ]
    },
    {
      "id": "local-attribution-drift",
      "status": "erfüllt",
      "checks": [
        "attribution-drift"
      ],
      "evidence": [
        "scripts/release/third-party.mjs",
        "THIRD_PARTY.md",
        "THIRD_PARTY-LICENSES.txt"
      ]
    }
  ]
}
```
<!-- release-evidence:end -->
