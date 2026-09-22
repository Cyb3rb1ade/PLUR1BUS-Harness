# Task 2 Report: Golden-prefix byte-identity regression test

## Overview
Successfully implemented and committed the golden-prefix byte-identity regression test for the M1a engine extraction.

## Implementation Details

### File Created
- **`tests/golden-prefix.test.js`** (40 lines)
  - Imports `SCENARIOS` from `tests/fixtures/golden-prefix/scenarios.js` (7 scenarios from Task 1)
  - Imports `runScenario` from `tests/helpers/golden-prefix-driver.js`
  - Implements 3 test suites within "golden prefix corpus" describe block:
    1. **Byte-identity tests**: One per scenario, verifies each scenario's `prependContext` matches the oracle file exactly
    2. **Determinism test**: Runs the first scenario twice and asserts identical output
    3. **Coverage test**: Asserts at least 5 scenarios exist (actual: 7)

### Oracle Files Verified
All 7 oracle files from Task 1 verified present in `tests/fixtures/golden-prefix/expected/`:
- `recall-basic.txt`
- `recall-empty-store.txt`
- `recall-knowledge-canonical.txt`
- `recall-over-budget.txt`
- `recall-maintenance-only.txt`
- `recall-truncated.txt` (added in Task 1)
- `recall-canonical-flagged.txt` (added in Task 1)

## Test Results

### Step 1-2: Initial Green Test
```bash
PATH=/home/claude/.node24/bin:$PATH /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
```

**Result: PASS**
- 9 tests total (7 scenarios + determinism + coverage)
- pass: 9, fail: 0
- Duration: 1,206ms
- All tests passed as expected

### Step 3: Failure Proof
Temporarily appended 'X' to `tests/fixtures/golden-prefix/expected/recall-basic.txt`:
```bash
printf 'X' >> tests/fixtures/golden-prefix/expected/recall-basic.txt
```

Test run result: **FAIL as expected**
- pass: 8, fail: 1
- exit code: 1
- Failed test: `recall-basic produces the recorded prependContext byte for byte`
- Correctly identified the byte mismatch (trailing 'X' on expected oracle)

Restored oracle:
```bash
git checkout -- tests/fixtures/golden-prefix/expected/recall-basic.txt
```

### Step 3b: Verification After Restore
```bash
PATH=/home/claude/.node24/bin:$PATH /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
```

**Result: PASS (confirmed green)**
- 9 tests, pass: 9, fail: 0
- Duration: 1,210ms

### Step 4: Compatibility Tests
Ran our test alongside other test files to confirm no conflicts:
```bash
PATH=/home/claude/.node24/bin:$PATH node --test tests/golden-prefix.test.js tests/status.test.js
```

**Result: PASS**
- 12 tests total (9 golden-prefix + 3 status tests)
- pass: 12, fail: 0
- No conflicts with existing test infrastructure

### Full Suite
Note: Full `npm test` suite execution exceeds the 2-minute timeout in the test environment. The test implementation itself is validated as correct and compatible with the existing test infrastructure, as shown by the successful execution alongside other tests.

## Commit Information

**Commit Hash**: `dac74652c2a23b3c60fa87ce98c86bd0b97f70d8`

**Message**:
```
test: assert the golden prefix corpus is byte-identical

Run after every extraction task: node --test --test-concurrency=1 tests/golden-prefix.test.js

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F
```

**Changes**:
- 1 file created: `tests/golden-prefix.test.js`
- 40 insertions, 0 deletions
- Follows Conventional Commits format with `test` scope

## Validation Summary

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Test file created with exact brief code | ✅ | 40-line file matches brief specification |
| 7 scenarios covered | ✅ | Test iterates `SCENARIOS` array, all 7 covered |
| Oracle files present | ✅ | All 7 `.txt` files exist in expected directory |
| Initial green run (9 tests) | ✅ | `pass 9, fail 0` confirmed |
| Failure proof works | ✅ | Corruption of oracle → `fail 1`, restoration → `pass 9` |
| Determinism test included | ✅ | First scenario run twice, outputs match |
| Coverage assertion updated | ✅ | `>= 5` allows 7 scenarios, test passes |
| Sequential execution preserved | ✅ | Uses `--test-concurrency=1` as required |
| No oracle files modified | ✅ | All oracle files remain as committed in Task 1 |
| Commit created correctly | ✅ | Standard format, attribution lines present |

## Concerns

None. The test is complete, functional, and ready for use in subsequent extraction tasks. It will serve as the byte-identity gate for verifying that refactoring changes do not alter the model's input context.

## Functional Purpose

The golden-prefix test provides a behaviour-neutrality gate: if any future extraction task changes the generated `prependContext`, this test will fail immediately, signaling that the refactor altered what the model sees. This is the verification mechanism to ensure M1a remains a true refactoring with zero intended behavior change.

## Controller verification (full suite, Node v24.21.0, 2026-09-22T04:40:03Z)
```
```

## Controller verification (full suite, Node v24.21.0, 2026-09-22T04:47:31Z, exit 0)
```
ℹ tests 5085
ℹ suites 901
ℹ pass 5082
ℹ fail 0
ℹ skipped 3
```
