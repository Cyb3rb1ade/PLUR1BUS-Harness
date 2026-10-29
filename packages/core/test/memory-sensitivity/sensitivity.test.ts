import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySensitivityStore } from "../../src/memory-sensitivity/store.ts";
import { SensitivityScanner, computeContentHash } from "../../src/memory-sensitivity/scanner.ts";
import { MemorySensitivityService } from "../../src/memory-sensitivity/service.ts";
import type { SensitivityCategory } from "../../src/memory-sensitivity/types.ts";

describe("memory sensitivity marking (Festlegung 5)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: MemorySensitivityStore;
  let service: MemorySensitivityService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-mem-sens-"));
    dbPath = join(tmpDir, "memory-sensitivity.sqlite");
    store = new MemorySensitivityStore({ path: dbPath });
    service = new MemorySensitivityService({ store });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scanner detects health category from medical keywords", () => {
    const scanner = new SensitivityScanner();
    const categories = scanner.scan("Patient was diagnosed with acute hypertension and prescribed beta blockers.");
    assert.ok(categories.includes("health"), `expected health, got ${categories}`);
  });

  it("scanner detects financial category from IBAN and bank keywords", () => {
    const scanner = new SensitivityScanner();
    const categories = scanner.scan("Please transfer the monthly salary to IBAN DE89370400440532013000.");
    assert.ok(categories.includes("financial"), `expected financial, got ${categories}`);
  });

  it("scanner detects credential category from API keys and tokens", () => {
    const scanner = new SensitivityScanner();
    const categories = scanner.scan("The staging API key is sk-ant-api03-1234567890abcdef1234567890.");
    assert.ok(categories.includes("credential"), `expected credential, got ${categories}`);
  });

  it("scanner detects identity category from passport and SSN references", () => {
    const scanner = new SensitivityScanner();
    const categories = scanner.scan("Reisepass Nummer C01X00T4L ausgestellt in Berlin.");
    assert.ok(categories.includes("identity"), `expected identity, got ${categories}`);
  });

  it("scanner detects personal category from private address and birth date", () => {
    const scanner = new SensitivityScanner();
    const categories = scanner.scan("Geburtsdatum: 14.05.1988, Privatadresse: Musterstraße 12, Köln.");
    assert.ok(categories.includes("personal"), `expected personal, got ${categories}`);
  });

  it("service assesses card, stores result with rule source and caches by hash", async () => {
    const card = { id: "card-1", text: "Diagnose: Typ-2-Diabetes. Behandlung mit Metformin." };
    const detected = await service.assessCard(card);
    assert.deepEqual(detected, ["health"]);

    const record = service.getSensitivity("card-1");
    assert.ok(record);
    assert.equal(record.cardId, "card-1");
    assert.equal(record.source, "rule");
    assert.deepEqual(record.categories, ["health"]);

    // Repeated call hits cache
    const secondCall = await service.assessCard(card);
    assert.deepEqual(secondCall, ["health"]);

    // Another card with exact same content re-uses hash cache
    const card2 = { id: "card-2", text: "Diagnose: Typ-2-Diabetes. Behandlung mit Metformin." };
    const detected2 = await service.assessCard(card2);
    assert.deepEqual(detected2, ["health"]);
  });

  it("manual mark sets categories with source manual and cannot be overwritten by rule scan", async () => {
    service.setSensitivity("card-manual", ["financial", "personal"]);
    const record = service.getSensitivity("card-manual");
    assert.ok(record);
    assert.equal(record.source, "manual");
    assert.deepEqual(record.categories, ["financial", "personal"]);

    // Running assessCard with rule-triggering text does not downgrade manual source
    const assessed = await service.assessCard({ id: "card-manual", text: "API key sk-ant-api03-1234567890abcdef1234567890" });
    assert.deepEqual(assessed, ["financial", "personal"]);
    assert.equal(service.getSensitivity("card-manual")?.source, "manual");
  });

  it("manual unmark removes specific category or clears all", () => {
    service.setSensitivity("card-unmark", ["health", "financial"]);

    const clearedOne = service.clearSensitivity("card-unmark", "health");
    assert.equal(clearedOne.cleared, true);
    assert.deepEqual(clearedOne.remaining, ["financial"]);
    assert.deepEqual(service.getSensitivity("card-unmark")?.categories, ["financial"]);

    const clearedAll = service.clearSensitivity("card-unmark");
    assert.equal(clearedAll.cleared, true);
    assert.deepEqual(clearedAll.remaining, []);
    assert.equal(service.getSensitivity("card-unmark"), null);
  });
});
