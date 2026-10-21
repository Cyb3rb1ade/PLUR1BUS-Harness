import { test } from "node:test";

// Qualification cases for GP5 S1; no existing test is replaced or relaxed.
test.todo("GP5 S1: signed Windows update uses zip >= 9 without another zip 4 parser in the install graph");
test.todo("GP5 S1: modified signature refuses a malicious archive before any extraction write");
test.todo("GP5 S1: selected updater preserves anti-rollback and the exclusive install slot on native targets");
