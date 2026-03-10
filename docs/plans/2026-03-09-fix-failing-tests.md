# Fix Failing Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 80 pre-existing test failures (21 in ConsoleManager.test.ts, 60 in framework/ tests)

**Architecture:** Fixes fall into 7 independent groups. Most are test bugs (wrong mocks, wrong assertions, sandbox paths). A few are source code bugs (RegExp 'g' flag, error patterns). Groups are independent and can be parallelized.

**Tech Stack:** TypeScript, Jest, Node.js

---

## Task 1: Fix ConsoleManager.test.ts (21 tests)

**Files:**
- Modify: `tests/protocols/ConsoleManager.test.ts`

**Problem:** Test mocks `../../src/monitoring/MonitoringSystem.js` which was deleted in CODE-HIGH-4. The mock is unused — the test just assigns a stub `monitoringSystem` property on the ConsoleManager instance but never asserts on it.

**Step 1: Remove the MonitoringSystem mock**

In `tests/protocols/ConsoleManager.test.ts`:
- Delete line 11: `jest.mock('../../src/monitoring/MonitoringSystem.js');`
- In the `beforeEach` block (~line 200-203), update the `monitoringSystem` stub to reference the HealthOrchestrator property name instead. Check what ConsoleManager actually uses now (likely `healthOrchestrator`). If the property doesn't exist or isn't used by any test, just remove the stub entirely.

**Step 2: Run tests**

```bash
npx jest tests/protocols/ConsoleManager.test.ts --no-coverage
```

Expected: All 21 tests pass (they were only blocked by the import error).

**Step 3: Commit**

```bash
git add tests/protocols/ConsoleManager.test.ts
git commit -m "fix(tests): update ConsoleManager.test.ts mocks for deleted MonitoringSystem"
```

---

## Task 2: Fix OutputFilterEngine RegExp 'g' flag bug (13 tests)

**Files:**
- Modify: `src/core/OutputFilterEngine.ts`

**Problem:** `getOrCreateRegex()` (~line 433) creates RegExp with `'g'` flag. When `.test()` is called with the `'g'` flag, JavaScript advances `lastIndex` after each match, causing every other call to `.test()` on different strings to fail. This breaks grep filtering, AND logic, and combined filters.

**Step 1: Remove the 'g' flag from getOrCreateRegex()**

In `src/core/OutputFilterEngine.ts`, find the `getOrCreateRegex` method (~line 433-436):
```typescript
let flags = 'g';
```
Change to:
```typescript
let flags = '';
```

The `'g'` flag is not needed for `.test()` or single-match operations. It's only needed for `.matchAll()` or repeated `.exec()` on the same string, which this code doesn't do.

**Step 2: Fix streaming mode filter** (~line 232-256)

The streaming mode processes chunks but doesn't apply the grep filter within chunks. Ensure `applyGrepFilter()` is called on each chunk, not just the final concatenated result. Read the streaming code path to understand the exact issue.

**Step 3: Fix maxLines metadata** (~line 184-204)

`metadata.totalLines` reports the original input length. When `maxLines` is set, `totalLines` should reflect the actual number of lines processed (capped at maxLines). Update the metadata calculation.

**Step 4: Fix error handling for invalid regex** (~line 223-226)

The implementation throws on invalid regex. Change to return `{ success: false, error: ... }` instead:
```typescript
} catch (error: any) {
  return {
    success: false,
    output: [],
    metadata: { totalLines: 0, filteredLines: 0, ... },
    error: error.message
  };
}
```

**Step 5: Run tests**

```bash
npx jest tests/unit/framework/outputFilterEngine.test.ts --no-coverage
```

Expected: All 26 tests pass.

**Step 6: Commit**

```bash
git add src/core/OutputFilterEngine.ts
git commit -m "fix: remove RegExp 'g' flag causing stateful test() failures in OutputFilterEngine"
```

---

## Task 3: Fix Matchers and AssertionEngine error patterns (2 tests)

**Files:**
- Modify: `src/testing/Matchers.ts` (~line 242-251)
- Modify: `src/testing/AssertionEngine.ts` (~line 160-173)

**Problem:** Default error patterns use `/exception:/i` (with colon) but test inputs like `'Exception occurred'` have no colon. Same for `/fatal:/i` vs `'Fatal error'`.

**Step 1: Fix Matchers.ts error patterns**

In `src/testing/Matchers.ts`, update the default error patterns (~line 242-251):
- Change `/exception:/i` to `/exception/i`
- Change `/fatal:/i` to `/fatal/i`
- Change `/error:/i` to `/error/i` (to catch "Syntax error detected")
- Change `/failed:/i` to `/failed/i`

**Step 2: Fix AssertionEngine.ts error patterns**

In `src/testing/AssertionEngine.ts`, apply same changes (~line 160-173):
- Remove colons from patterns that have them, matching the broader intent

**Step 3: Run tests**

```bash
npx jest tests/unit/framework/Matchers.test.ts tests/unit/framework/AssertionEngine.test.ts --no-coverage
```

Expected: Both pass.

**Step 4: Commit**

```bash
git add src/testing/Matchers.ts src/testing/AssertionEngine.ts
git commit -m "fix: broaden error detection patterns to match without trailing colons"
```

---

## Task 4: Fix CodeGenerator.test.ts filesystem cleanup (22 tests)

**Files:**
- Modify: `tests/unit/framework/CodeGenerator.test.ts` (~line 24-34)

**Problem:** `beforeEach` uses `fs.unlinkSync()` on directory entries, but `data/generated-tests/deep` is a subdirectory, not a file. `unlinkSync` can't remove directories.

**Step 1: Fix the cleanup logic**

Replace the manual file-by-file cleanup with recursive directory removal:

```typescript
beforeEach(() => {
  // Clean output directory
  if (fs.existsSync(testOutputDir)) {
    fs.rmSync(testOutputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testOutputDir, { recursive: true });
});
```

**Step 2: Run tests**

```bash
npx jest tests/unit/framework/CodeGenerator.test.ts --no-coverage
```

Expected: All 22 tests pass.

**Step 3: Commit**

```bash
git add tests/unit/framework/CodeGenerator.test.ts
git commit -m "fix(tests): use recursive rmSync for CodeGenerator test cleanup"
```

---

## Task 5: Fix phase1-integration.test.ts ConfigManager path (13 tests)

**Files:**
- Modify: `tests/unit/framework/phase1-integration.test.ts`

**Problem:** ConsoleManager constructor calls ConfigManager which tries to `mkdirSync('~/.console-automation-mcp')`. The sandbox blocks writing to home directory. The test needs to mock ConfigManager to prevent real filesystem access.

**Step 1: Mock ConfigManager**

Add a jest.mock at the top of the test file:

```typescript
jest.mock('../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn().mockReturnValue({
      getConfigPath: jest.fn().mockReturnValue('/tmp/test-config'),
      get: jest.fn().mockReturnValue(undefined),
      set: jest.fn(),
    }),
  },
}));
```

Also ensure any other imports that trigger real filesystem operations are mocked (check if ConsoleManager constructor does other I/O).

**Step 2: Run tests**

```bash
npx jest tests/unit/framework/phase1-integration.test.ts --no-coverage
```

Expected: All 13 tests pass.

**Step 3: Commit**

```bash
git add tests/unit/framework/phase1-integration.test.ts
git commit -m "fix(tests): mock ConfigManager in phase1-integration to avoid filesystem access"
```

---

## Task 6: Fix SnapshotManager timestamp sorting (3 tests + 1 phase2)

**Files:**
- Modify: `src/testing/SnapshotManager.ts`
- Modify: `tests/unit/framework/SnapshotManager.test.ts`

**Problem:** `loadBySessionId()` returns wrong snapshot. `listSnapshots()` sorts by `b.timestamp - a.timestamp` (newest first), but the timestamp used for sorting may not match the snapshot's internal timestamp. Additionally, the test creates snapshots with very close timestamps causing race conditions.

**Step 1: Read and fix SnapshotManager source**

Read `src/testing/SnapshotManager.ts` to understand how snapshots are stored and sorted. The `loadBySessionId(sessionId, timestamp)` method should:
- When timestamp is provided: find the snapshot matching that exact timestamp
- When no timestamp: return the most recent snapshot

Ensure the sorting uses the snapshot's stored timestamp (not file mtime) for consistency.

**Step 2: Fix test timing**

In `tests/unit/framework/SnapshotManager.test.ts`, ensure snapshots created in sequence have distinct timestamps. Add explicit timestamp fields rather than relying on `Date.now()`:

```typescript
const snap1 = { ..., timestamp: 1000 };
const snap2 = { ..., timestamp: 2000 };
```

**Step 3: Run tests**

```bash
npx jest tests/unit/framework/SnapshotManager.test.ts tests/unit/framework/phase2-integration.test.ts --no-coverage
```

Expected: All pass.

**Step 4: Commit**

```bash
git add src/testing/SnapshotManager.ts tests/unit/framework/SnapshotManager.test.ts
git commit -m "fix: ensure SnapshotManager sorts by stored timestamp consistently"
```

---

## Task 7: Fix RetryManager, ParallelExecutor, FlakeDetector, phase4 tests (8 tests)

**Files:**
- Modify: `tests/unit/framework/RetryManager.test.ts`
- Modify: `tests/unit/framework/ParallelExecutor.test.ts`
- Modify: `tests/unit/framework/FlakeDetector.test.ts`
- Possibly modify: `src/testing/ParallelExecutor.ts`

### RetryManager (1 test)

**Problem:** Test uses an executor that always passes on first attempt, but `successAfterRetry` counts tests with `attempts > 1`.

**Fix:** Change the test executor to fail once then succeed:
```typescript
const callCounts = new Map<string, number>();
const executor = async (t: TestDefinition): Promise<TestResult> => {
  const count = (callCounts.get(t.name) || 0) + 1;
  callCounts.set(t.name, count);
  return {
    test: t,
    status: count > 1 ? 'pass' : 'fail',
    duration: 100,
    output: count > 1 ? 'Passed on retry' : 'Failed first time',
  };
};
```

### ParallelExecutor (3 tests)

**Problem 1:** "should demonstrate speedup" — sequential execution doesn't actually sleep, so parallel isn't faster.
**Problem 2:** "should isolate tests" — `result.test` is undefined.

**Fix:** Read `src/testing/ParallelExecutor.ts` to understand the execution model. Fix the test expectations to match actual behavior, or fix the source code if sequential execution should include real delays.

### FlakeDetector (1 test)

**Problem:** Test sets `parallel: false` but is named "should run detection in parallel".

**Fix:** Change to `parallel: true` or rename the test to match behavior.

### phase4 tests (3 tests)

These cascade from ParallelExecutor fixes. Fix ParallelExecutor first, then verify.

**Run:**
```bash
npx jest tests/unit/framework/RetryManager.test.ts tests/unit/framework/ParallelExecutor.test.ts tests/unit/framework/FlakeDetector.test.ts tests/unit/framework/phase4-integration.test.ts tests/unit/framework/phase4-performance.test.ts --no-coverage
```

**Commit:**
```bash
git add tests/unit/framework/RetryManager.test.ts tests/unit/framework/ParallelExecutor.test.ts tests/unit/framework/FlakeDetector.test.ts
git commit -m "fix(tests): correct test expectations for RetryManager, ParallelExecutor, FlakeDetector"
```

---

## Summary

| Task | Tests Fixed | Type |
|------|------------|------|
| 1. ConsoleManager mocks | 21 | Test fix (deleted mock) |
| 2. OutputFilterEngine RegExp | 13 | Source fix (RegExp 'g' flag) |
| 3. Error patterns | 2 | Source fix (pattern broadening) |
| 4. CodeGenerator cleanup | 22 | Test fix (rmSync) |
| 5. phase1 ConfigManager | 13 | Test fix (mock ConfigManager) |
| 6. SnapshotManager sorting | 4 | Source + test fix |
| 7. Retry/Parallel/Flake | 8 | Test + possibly source fix |
| **Total** | **~80** | |

Tasks 1-5 are independent and can be parallelized. Task 6 must complete before verifying phase2. Task 7's phase4 depends on ParallelExecutor fix.
