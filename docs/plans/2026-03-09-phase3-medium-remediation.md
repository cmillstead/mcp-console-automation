# Phase 3 (MEDIUM) Remediation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete all 6 remaining MEDIUM-priority code scan items (CODE-MED-1, CODE-MED-2, CODE-MED-3, CODE-MED-5, TEST-MED-1, TEST-MED-2).

**Architecture:** Tackle independent items first (swallowed errors, process.exit, coverage), then structural changes (BaseProtocol defaults), then the larger ProtocolFactory migration. Handle leaks last since removing forceExit depends on other fixes being stable.

**Tech Stack:** TypeScript, Jest, Node.js

---

### Task 1: Fix swallowed errors (CODE-MED-5)

**Files:**
- Modify: `src/protocols/SSHProtocol.ts:89-93`
- Modify: `src/protocols/SSHProtocol.ts:175-179` (second instance — verify line, same pattern)
- Modify: `src/protocols/UnixSocketProtocol.ts:534-536`
- Modify: `src/core/WindowsSSHAdapter.ts:129-131`

**Step 1: Fix SSHProtocol swallowed debug errors**

In `src/protocols/SSHProtocol.ts` around line 88-93, the local `debugLog` function swallows errors:
```typescript
// BEFORE:
const debugLog = (msg: string) => {
  try {
    console.error(`[SSH-DEBUG] ${msg}`);
  } catch (e) {
    // Ignore debug errors
  }
};
```
This pattern appears twice (once in `doCreateSession`, likely once more in another method). Since `console.error` essentially never throws, remove the try/catch entirely:
```typescript
// AFTER:
const debugLog = (msg: string) => {
  console.error(`[SSH-DEBUG] ${msg}`);
};
```
Find and fix both instances.

**Step 2: Fix UnixSocketProtocol cleanup error**

In `src/protocols/UnixSocketProtocol.ts:534`, the `fs.unlinkSync` catch is acceptable for cleanup — a missing file is expected. Add debug logging:
```typescript
// BEFORE:
} catch (e) {
  // Ignore cleanup errors
}

// AFTER:
} catch {
  // unlinkSync may fail if file already removed — benign
}
```
This one is actually fine as-is. No change needed — the comment is accurate and the error is truly ignorable (cleaning up a temp socket file that may not exist).

**Step 3: Fix WindowsSSHAdapter silent continue**

In `src/core/WindowsSSHAdapter.ts:129-131`, add logging when Plink path fails:
```typescript
// BEFORE:
} catch (e) {
  continue;
}

// AFTER:
} catch (e) {
  this.logger.debug(`Plink not found at path, trying next:`, e instanceof Error ? e.message : String(e));
  continue;
}
```

**Step 4: Run typecheck and tests**

Run: `./node_modules/.bin/tsc --noEmit && npx jest --testPathPattern="SSHProtocol|UnixSocket|WindowsSSH" --no-coverage`

**Step 5: Commit**

```bash
git add src/protocols/SSHProtocol.ts src/protocols/UnixSocketProtocol.ts src/core/WindowsSSHAdapter.ts
git commit -m "fix: add logging to swallowed errors (CODE-MED-5)"
```

---

### Task 2: Replace process.exit() with graceful shutdown (CODE-MED-3)

**Files:**
- Modify: `src/mcp/server.ts` (3 locations: lines ~3530, ~3733, ~3988)

There are 5 process.exit() calls total: 3 in server.ts and 2 in examples/KubernetesDemo.ts. The example file is fine (demo scripts legitimately exit). Focus on server.ts.

**Step 1: Replace process.exit in gracefulShutdown fallback (line ~3530)**

This is the catch handler when `gracefulShutdown()` itself fails. Keep as-is — this is the absolute last resort when shutdown has failed. `process.exit(1)` is correct here because there's nothing else to try.

**Step 2: Replace process.exit at end of gracefulShutdown (line ~3733)**

Replace the hard `process.exit()` at the end of `gracefulShutdown()` with an event emission pattern that allows tests and callers to handle shutdown without killing the process:

```typescript
// BEFORE (line 3733):
process.exit(exitCode);

// AFTER:
this.emit('shutdown', exitCode);
// In production, actually exit. In test mode, just emit.
if (process.env.NODE_ENV !== 'test') {
  process.exit(exitCode);
}
```

**Step 3: Replace process.exit in startup failure (line ~3988)**

Replace the module-level startup failure handler:

```typescript
// BEFORE:
server.start().catch((error) => {
  debugLog('[DEBUG] Server start failed:', error);
  setTimeout(() => process.exit(1), 100);
});

// AFTER:
server.start().catch((error) => {
  debugLog('[DEBUG] Server start failed:', error);
  // Allow logs to flush, then exit
  setTimeout(() => {
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  }, 100);
});
```

**Step 4: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "fix: guard process.exit() behind NODE_ENV check (CODE-MED-3)"
```

---

### Task 3: Add default capabilities to BaseProtocol (CODE-MED-1)

**Files:**
- Modify: `src/core/BaseProtocol.ts`
- Modify: All 63 protocol files in `src/protocols/` (mechanical: spread defaults + keep only overrides)
- Test: Existing `tests/unit/protocol-conformance.test.ts` must still pass

**Step 1: Add getDefaultCapabilities() to BaseProtocol**

In `src/core/BaseProtocol.ts`, change `capabilities` from abstract to a concrete property with defaults:

```typescript
// BEFORE (line 28):
public abstract readonly capabilities: ProtocolCapabilities;

// AFTER:
public readonly capabilities: ProtocolCapabilities;

// Add static method after the constructor:
protected static getDefaultCapabilities(): ProtocolCapabilities {
  return {
    supportsStreaming: false,
    supportsFileTransfer: false,
    supportsX11Forwarding: false,
    supportsPortForwarding: false,
    supportsAuthentication: false,
    supportsEncryption: false,
    supportsCompression: false,
    supportsMultiplexing: false,
    supportsKeepAlive: false,
    supportsReconnection: false,
    supportsBinaryData: false,
    supportsCustomEnvironment: false,
    supportsWorkingDirectory: false,
    supportsSignals: false,
    supportsResizing: false,
    supportsPTY: false,
    maxConcurrentSessions: 10,
    defaultTimeout: 30000,
    supportedEncodings: ['utf-8'],
    supportedAuthMethods: [],
    platformSupport: { windows: true, linux: true, macos: true, freebsd: true },
  };
}
```

Initialize `capabilities` to defaults in the constructor:
```typescript
constructor(name: string) {
  super();
  this.capabilities = BaseProtocol.getDefaultCapabilities();
  // ... rest of constructor
}
```

Wait — `capabilities` is `readonly`. Subclasses assign in their constructors. The pattern should be:
- Remove `abstract` from capabilities
- Keep it `readonly` but assign defaults in BaseProtocol constructor
- Subclasses assign `this.capabilities = { ...BaseProtocol.getDefaultCapabilities(), ...overrides }` in their constructors (before `super()` won't work since it's `readonly` and set in parent)

Better approach: Make capabilities assignable in constructor only. Change BaseProtocol to NOT set defaults — instead provide the static helper. Subclasses use it:

```typescript
// BaseProtocol keeps: public abstract readonly capabilities: ProtocolCapabilities;
// Add only the static helper method
```

Then in each protocol:
```typescript
// BEFORE (SSHProtocol):
this.capabilities = {
  supportsStreaming: true,
  supportsFileTransfer: true,
  supportsX11Forwarding: true,
  supportsPortForwarding: true,
  supportsAuthentication: true,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: true,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: true,
  supportsWorkingDirectory: true,
  supportsSignals: true,
  supportsResizing: true,
  supportsPTY: true,
  maxConcurrentSessions: 20,
  defaultTimeout: 30000,
  supportedEncodings: ['utf-8', 'ascii', 'binary'],
  supportedAuthMethods: ['password', 'publickey', 'keyboard-interactive'],
  platformSupport: { windows: true, linux: true, macos: true, freebsd: true },
};

// AFTER:
this.capabilities = {
  ...BaseProtocol.getDefaultCapabilities(),
  supportsStreaming: true,
  supportsFileTransfer: true,
  supportsX11Forwarding: true,
  supportsPortForwarding: true,
  supportsAuthentication: true,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: true,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: true,
  supportsWorkingDirectory: true,
  supportsSignals: true,
  supportsResizing: true,
  supportsPTY: true,
  maxConcurrentSessions: 20,
  supportedEncodings: ['utf-8', 'ascii', 'binary'],
  supportedAuthMethods: ['password', 'publickey', 'keyboard-interactive'],
};
```

For protocols where most capabilities are `false` (the default), the override list will be much shorter. Example (LocalProtocol):
```typescript
// AFTER:
this.capabilities = {
  ...BaseProtocol.getDefaultCapabilities(),
  supportsStreaming: true,
  supportsCustomEnvironment: true,
  supportsWorkingDirectory: true,
  supportsSignals: true,
  supportsResizing: true,
  supportsPTY: true,
  maxConcurrentSessions: 50,
  supportedEncodings: ['utf-8', 'ascii'],
};
```

**Step 2: Update all 63 protocol files**

For each file in `src/protocols/*.ts` (except index.ts):
1. Add import if needed: `import { BaseProtocol } from '../core/BaseProtocol.js';` (most already have this)
2. Replace the full capabilities literal with `{ ...BaseProtocol.getDefaultCapabilities(), <only non-default values> }`
3. Remove any values that match the defaults (all the `false` booleans, `defaultTimeout: 30000`, `platformSupport: { windows: true, linux: true, macos: true, freebsd: true }`, `supportedAuthMethods: []`, `supportedEncodings: ['utf-8']`)

This is mechanical but touches 63 files. Use a subagent for parallelization.

**Step 3: Run conformance tests**

Run: `npx jest tests/unit/protocol-conformance.test.ts --no-coverage`
Expected: All 550 tests pass (capabilities values unchanged, just sourcing differs)

**Step 4: Run full typecheck**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 5: Commit**

```bash
git add src/core/BaseProtocol.ts src/protocols/
git commit -m "refactor: add BaseProtocol.getDefaultCapabilities(), DRY protocol capabilities (CODE-MED-1)"
```

---

### Task 4: Set realistic coverage thresholds (TEST-MED-1)

**Files:**
- Modify: `jest.config.cjs` (lines 22-28)

**Step 1: Measure current coverage**

Run: `npx jest --coverage --no-cache 2>&1 | tail -20`

Note the actual branch/function/line/statement percentages.

**Step 2: Set thresholds to current levels minus 2% buffer**

In `jest.config.cjs`, update the `coverageThreshold` block with the measured values (minus ~2% for flake margin). Example if coverage is branches: 12%, functions: 25%, lines: 22%, statements: 22%:

```javascript
coverageThreshold: {
  global: {
    branches: 10,
    functions: 23,
    lines: 20,
    statements: 20
  }
}
```

**Step 3: Verify thresholds pass**

Run: `npx jest --coverage --no-cache 2>&1 | grep -A5 "Coverage Threshold"`
Expected: No threshold failures

**Step 4: Commit**

```bash
git add jest.config.cjs
git commit -m "chore: raise coverage thresholds to reflect current levels (TEST-MED-1)"
```

---

### Task 5: Remove forceExit, fix handle leaks (TEST-MED-2)

**Files:**
- Modify: `jest.config.cjs` (remove `forceExit: true`)
- Modify: Test files with handle leaks (determined by --detectOpenHandles output)

**Step 1: Remove forceExit**

In `jest.config.cjs` line 59, delete: `forceExit: true,`

Keep `detectOpenHandles: true` (line 58).

**Step 2: Run tests and identify open handles**

Run: `npx jest --no-coverage 2>&1 | tail -40`

If tests hang or report open handles, note which tests/handles are the problem.

**Step 3: Fix identified handle leaks**

Common fixes:
- Add `afterAll(() => { clearInterval/clearTimeout })` in test files
- Call `.destroy()` / `.cleanup()` on protocol/manager instances in afterAll
- Add `jest.useFakeTimers()` in tests that use timers
- Clear event listeners in afterAll

For each leaked handle, trace it to the test file and add proper cleanup.

**Step 4: Verify tests complete without forceExit**

Run: `npx jest --no-coverage`
Expected: All tests pass and process exits cleanly within timeout.

If tests still hang after fixing all identified handles, consider adding a `jest.config.cjs` setting:
```javascript
testTimeout: 30000, // reduce from 45000
```

**Step 5: Commit**

```bash
git add jest.config.cjs <any fixed test files>
git commit -m "fix: remove forceExit, fix open handle leaks in tests (TEST-MED-2)"
```

---

### Task 6: Route protocol creation through ProtocolFactory (CODE-MED-2)

**Files:**
- Modify: `src/core/ConsoleManager.ts` (remove legacy protocol fields, use factory)
- Test: Existing `tests/protocols/ConsoleManager.test.ts` must pass

**NOTE:** This is a large, high-risk refactor. It involves removing ~13 legacy protocol fields and ~8 session maps from ConsoleManager, and routing all creation through ProtocolFactory. Only do this if the codebase is stable after Tasks 1-5.

**Step 1: Audit legacy protocol fields**

Read `src/core/ConsoleManager.ts` lines 130-190 to find all legacy protocol fields:
- `dockerProtocol`, `kubernetesProtocol`, `serialProtocol`, `awsSSMProtocol`, `azureProtocol`, `webSocketTerminalProtocol`, `rdpProtocol`, `wslProtocol`, `ansibleProtocol`
- Session maps: `rdpSessions`, `winrmSessions`, `vncSessions`, `ipcSessions`, `ipmiSessions`, etc.

**Step 2: For each legacy protocol field, find all usages**

Search for each field name in ConsoleManager.ts. For each:
- If the protocol is created with `new XProtocol()`, replace with `await this.protocolFactory.createProtocol('x')`
- Cache the result in a generic map: `this.protocolCache: Map<string, IProtocol>`
- Add a helper: `private async getOrCreateProtocol(type: string): Promise<IProtocol>`

**Step 3: Add getOrCreateProtocol helper**

```typescript
private protocolCache: Map<string, IProtocol> = new Map();

private async getOrCreateProtocol(type: string): Promise<IProtocol> {
  let protocol = this.protocolCache.get(type);
  if (!protocol) {
    protocol = await this.protocolFactory.createProtocol(type);
    this.protocolCache.set(type, protocol);
  }
  return protocol;
}
```

**Step 4: Replace legacy protocol usages one at a time**

Start with the simplest protocol (e.g., `serialProtocol`). Replace:
```typescript
// BEFORE:
if (!this.serialProtocol) {
  this.serialProtocol = new SerialProtocol();
  await this.serialProtocol.initialize();
}

// AFTER:
const serialProtocol = await this.getOrCreateProtocol('serial');
```

Run tests after each protocol migration. Do NOT batch — one at a time.

**Step 5: Update destroy() method**

Replace individual protocol cleanup with:
```typescript
for (const [type, protocol] of this.protocolCache) {
  try {
    await protocol.cleanup();
  } catch (e) {
    this.logger.warn(`Error cleaning up ${type} protocol:`, e);
  }
}
this.protocolCache.clear();
```

**Step 6: Delete legacy protocol fields**

Once all usages are migrated, delete the old field declarations.

**Step 7: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass

**Step 8: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 9: Commit**

```bash
git add src/core/ConsoleManager.ts
git commit -m "refactor: route all protocol creation through ProtocolFactory (CODE-MED-2)"
```

---

## Execution Order

| Order | Task | Item | Risk | Est. Files |
|-------|------|------|------|------------|
| 1 | Task 1 | CODE-MED-5 (swallowed errors) | Low | 3 |
| 2 | Task 2 | CODE-MED-3 (process.exit) | Low | 1 |
| 3 | Task 3 | CODE-MED-1 (capabilities defaults) | Medium | 64 |
| 4 | Task 4 | TEST-MED-1 (coverage thresholds) | Low | 1 |
| 5 | Task 5 | TEST-MED-2 (forceExit/handles) | Medium | ~5 |
| 6 | Task 6 | CODE-MED-2 (ProtocolFactory migration) | High | ~2 |

Tasks 1, 2, and 4 are independent and can be parallelized.
Task 3 is independent but large (63 files).
Task 5 depends on Tasks 1-4 being committed (stable baseline).
Task 6 depends on Task 5 (tests must pass without forceExit first).
