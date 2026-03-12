# TypeScript noImplicitAny + Explicit Any Reduction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable `noImplicitAny` in tsconfig.json and reduce explicit `any` in the top 4 offender files by ~50%.

**Architecture:** Fix all 59 implicit any errors first (type annotations on callback params, install missing @types packages), then systematically replace explicit `any` with `unknown` or proper types in the 4 worst files.

**Tech Stack:** TypeScript, @types/node-cron, @types/node-forge

---

### Task 1: Install missing @types packages

**Files:**
- Modify: `package.json`

**Step 1: Install type packages**

Run: `npm install --save-dev @types/node-cron @types/node-forge --cache "$TMPDIR/npm-cache"`

This fixes 2 of the 59 errors:
- `src/core/TriggerManager.ts(8)`: Could not find declaration file for 'node-cron'
- `src/protocols/RDPProtocol.ts(5)`: Could not find declaration file for 'node-forge'

**Step 2: Verify those errors are gone**

Run: `./node_modules/.bin/tsc --noEmit --noImplicitAny 2>&1 | grep -c "error TS"`
Expected: 57 (down from 59)

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @types/node-cron and @types/node-forge"
```

---

### Task 2: Fix ConsoleManager.ts implicit any errors (35 errors)

**Files:**
- Modify: `src/core/ConsoleManager.ts`

**What to fix:** All 35 errors are callback parameters and destructured bindings that need type annotations. Read each error line, understand the context, and add the appropriate type.

**Error categories:**

1. **Lines 4345-4407** (~15 errors): Kubernetes event handler destructured bindings. Types: `k8sSessionId: string`, `sessionState: string`, `streamId: string`, `podName: string`, `data: string`, `raw: Buffer`, `error: Error`, `portForwardId: string`, `localPort: number`, `remotePort: number`

2. **Line 3985**: Object literal property `pid` — needs explicit type annotation on the containing object

3. **Line 4566**: Parameter `device` — type as `string` or the appropriate device interface

4. **Line 7131**: Member `n` — needs type annotation on class/interface member

5. **Lines 9554-9618** (~10 errors): Event handler callback params. Types: `sessionId: string`, `error: Error`, `output: string`, `tokenInfo: Record<string, unknown>`, `attempt: number`

6. **Lines 10577-10754** (~7 errors): RDP/VNC event handler callback params. Types: `update: Record<string, unknown>`, `message: string`, `clipboardData: string`, `error: Error`, `connectionState: string`, `progress: Record<string, unknown>`

**Step 1: Read each error line in ConsoleManager.ts and add types**

For each error, read 5 lines of context around the line number to understand what type is needed. Add the appropriate type annotation.

**Step 2: Verify errors are fixed**

Run: `./node_modules/.bin/tsc --noEmit --noImplicitAny 2>&1 | grep "ConsoleManager.ts"`
Expected: 0 errors from ConsoleManager.ts

**Step 3: Commit**

```bash
git add src/core/ConsoleManager.ts
git commit -m "fix: add type annotations to ConsoleManager.ts implicit any params"
```

---

### Task 3: Fix remaining implicit any errors (22 errors in 7 files)

**Files:**
- Modify: `src/core/SSHConnectionKeepAlive.ts` (3 errors)
- Modify: `src/core/SSHSessionHandler.ts` (1 error)
- Modify: `src/mcp/server.ts` (1 error)
- Modify: `src/tests/ParallelExecutor.test.ts` (5 errors)
- Modify: `src/tests/phase4-performance.test.ts` (4 errors)
- Modify: `src/tests/phase4-integration.test.ts` (2 errors)
- Modify: `src/tests/phase5-integration.test.ts` (2 errors)
- Modify: `src/tests/TestReplayEngine.test.ts` (1 error)
- Modify: `src/tests/WorkerPool.test.ts` (3 errors)

**SSHConnectionKeepAlive.ts fixes:**
- Line 391: `(code)` → `(code: number)`
- Line 399: `(error)` → `(error: Error)`
- Line 618: `(code)` → `(code: number)`

**SSHSessionHandler.ts fix:**
- Line 313: `(err)` → `(err: Error)`

**server.ts fix:**
- Line 2836: `(o)` → `(o: unknown)` or the appropriate type based on context

**Test file fixes (all the same pattern):**
All test files have object literals with `assertions` properties that are empty arrays `[]` — TypeScript infers `any[]`. Fix by typing them: `assertions: [] as string[]` or adding a type annotation to the containing variable.

**Step 1: Fix all errors in the listed files**

Read each error line, add appropriate type.

**Step 2: Verify all implicit any errors are gone**

Run: `./node_modules/.bin/tsc --noEmit --noImplicitAny 2>&1 | grep -c "error TS"`
Expected: 0

**Step 3: Commit**

```bash
git add src/core/SSHConnectionKeepAlive.ts src/core/SSHSessionHandler.ts src/mcp/server.ts src/tests/
git commit -m "fix: resolve remaining implicit any errors across codebase"
```

---

### Task 4: Enable noImplicitAny in tsconfig.json

**Files:**
- Modify: `tsconfig.json`

**Step 1: Add the flag**

In `tsconfig.json`, add `"noImplicitAny": true` to compilerOptions (after the `"strict": false` line).

**Step 2: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "feat: enable noImplicitAny in tsconfig.json (CODE-HIGH-3)"
```

---

### Task 5: Reduce explicit `any` in types/index.ts (~34 → ~15)

**Files:**
- Modify: `src/types/index.ts`

**Strategy:**
- `metadata?: any` → `metadata?: Record<string, unknown>`
- `Record<string, any>` → `Record<string, unknown>` for truly unknown shapes
- Keep `any` only where a specific type would require invasive changes to callers
- For callback types like `(data: any) => void`, use `unknown` if the callback doesn't need to access specific properties

**Step 1: Read the full types/index.ts file**

Identify all `any` usages and categorize:
- Safe to change to `unknown`: metadata fields, generic records, untyped params
- Needs specific type: fields where callers access properties (would break with `unknown`)
- Leave as `any`: third-party interop or would cascade too many changes

**Step 2: Make the changes**

Replace each identified `any` with the appropriate type.

**Step 3: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: 0 errors (if errors appear from callers, some changes may need to stay as `any`)

**Step 4: Count reduction**

Run: `grep -c ': any\b\|as any\b\|<any>' src/types/index.ts`
Expected: ~15 or fewer (down from 34)

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "refactor: reduce explicit any in types/index.ts"
```

---

### Task 6: Reduce explicit `any` in server.ts (~89 → ~45)

**Files:**
- Modify: `src/mcp/server.ts`

**Strategy:**
- Catch blocks: `catch (error: any)` → `catch (error: unknown)`, use `error instanceof Error ? error.message : String(error)` pattern
- Tool handler params: type with interfaces matching tool input schemas if feasible, otherwise `unknown` with runtime narrowing
- `as any` casts: replace with proper types or `as unknown as TargetType` where needed
- `debugLog` calls with `any` args: use `unknown`

**Step 1: Read the file and identify all `any` usages**

**Step 2: Replace safe ones**

Focus on catch blocks first (easy wins), then tool handler params.

**Step 3: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: 0 errors

**Step 4: Count reduction**

Run: `grep -c ': any\b\|as any\b\|<any>' src/mcp/server.ts`
Expected: ~45 or fewer (down from 89)

**Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor: reduce explicit any in server.ts"
```

---

### Task 7: Reduce explicit `any` in ConsoleManager.ts (~72 → ~35)

**Files:**
- Modify: `src/core/ConsoleManager.ts`

**Strategy:**
- Catch blocks: `catch (error: any)` → `catch (error: unknown)`
- Event handler params that were already typed in Task 2 may have nearby explicit `any` — clean those up
- Protocol-specific data: use `unknown` where the type isn't available, leave `any` where callers need property access and typing would be invasive
- `as any` casts: evaluate case by case

**Step 1: Read and identify all explicit `any` usages**

**Step 2: Replace safe ones**

**Step 3: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 4: Count reduction**

Run: `grep -c ': any\b\|as any\b\|<any>' src/core/ConsoleManager.ts`
Expected: ~35 or fewer (down from 72)

**Step 5: Commit**

```bash
git add src/core/ConsoleManager.ts
git commit -m "refactor: reduce explicit any in ConsoleManager.ts"
```

---

### Task 8: Reduce explicit `any` in DataPipelineManager.ts (~59 → ~30)

**Files:**
- Modify: `src/core/DataPipelineManager.ts`

**Strategy:**
- Pipeline data types: `unknown` for data flowing through transforms
- Catch blocks: `unknown`
- `Record<string, any>` → `Record<string, unknown>`
- Transform function types: use generics or `unknown` with runtime narrowing

**Step 1: Read and identify all explicit `any` usages**

**Step 2: Replace safe ones**

**Step 3: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 4: Count reduction**

Run: `grep -c ': any\b\|as any\b\|<any>' src/core/DataPipelineManager.ts`
Expected: ~30 or fewer (down from 59)

**Step 5: Commit**

```bash
git add src/core/DataPipelineManager.ts
git commit -m "refactor: reduce explicit any in DataPipelineManager.ts"
```

---

### Task 9: Final verification

**Step 1: Full typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: 0 errors

**Step 2: Count total explicit any remaining**

Run: `grep -r ': any\b\|as any\b\|<any>' src/ --include='*.ts' -c | awk -F: '{sum+=$2} END {print sum}'`
Expected: measurably less than 1,159

**Step 3: Run lint**

Run: `npm run lint`
Expected: pass (or only pre-existing warnings)

**Step 4: Commit any final fixes**
