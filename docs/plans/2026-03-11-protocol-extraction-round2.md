# Protocol Extraction Round 2 — Implementation Plan

**Date:** 2026-03-11
**Design Doc:** `docs/plans/2026-03-11-protocol-extraction-round2-design.md`
**Branch:** `refactor/protocol-extraction-round2`
**Target:** ConsoleManager.ts 8,268 → ~6,600 lines (-1,668 lines)

## Prerequisites

```bash
git checkout master && git pull
git checkout -b refactor/protocol-extraction-round2
npm run typecheck && npx jest --selectProjects unit 2>&1 | tail -5
# Expect: 1,159 tests passing, 37 suites
```

## Phase 0: Cleanup (untracked files)

### Task 0.1: Gitignore plan docs and clean up test data

Add plan docs to `.gitignore` or commit them (they're reference material).

```bash
# Discard unstaged changes to generated data files
git checkout -- data/benchmarks/parallel-vs-sequential.json
git checkout -- data/recordings/integration-test/wait-test.json
git checkout -- data/recordings/test/test-metadata.json
git checkout -- data/sessions.json
git checkout -- test-report.xml

# Remove untracked test data
rm -rf data/metrics/
rm -f data/recordings/test/test-from-file.json

# Commit plan docs (design reference)
git add docs/plans/2026-03-09-baseprotocol-migration-design.md
git add docs/plans/2026-03-09-baseprotocol-migration.md
git add docs/plans/2026-03-09-health-orchestrator-implementation.md
git add docs/plans/2026-03-09-monitoring-consolidation-design.md
git add docs/plans/2026-03-09-phase3-medium-remediation.md
git add docs/plans/2026-03-09-typescript-strict-mode.md
git add docs/plans/2026-03-11-protocol-extraction-design.md
git add docs/plans/2026-03-11-protocol-extraction.md
git add docs/plans/2026-03-11-protocol-extraction-round2-design.md
git add docs/plans/2026-03-11-protocol-extraction-round2.md
git commit -m "docs: add design and plan docs from remediation phases"
```

Verify: `git status` shows clean working tree.

---

## Phase 1: IPCSessionManager (simplest — stub only)

### Task 1.1: Create `src/core/IPCSessionManager.ts`

**Extract from ConsoleManager.ts:**
- `createIPCSession` (lines ~8035-8052)

**Fields to own internally:**
- `ipcSessions: Map<string, IPCSessionState>` (currently empty stub)

**Pattern:** Extends `ProtocolSessionManagerBase`, `setupEventHandlers()` is no-op (stub).

```typescript
// src/core/IPCSessionManager.ts
import { ProtocolSessionManagerBase, ProtocolSessionHost } from './ProtocolSessionManagerBase.js';
import { Logger } from '../utils/logger.js';
import type { ConsoleSession, SessionOptions, IPCSessionState } from '../types/index.js';

export class IPCSessionManager extends ProtocolSessionManagerBase {
  private ipcSessions: Map<string, IPCSessionState> = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'ipc');
  }

  protected setupEventHandlers(): void { /* stub */ }

  async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string> {
    // Move body from ConsoleManager.createIPCSession
  }

  override async destroy(): Promise<void> {
    this.ipcSessions.clear();
    await super.destroy();
  }
}
```

### Task 1.2: Create `tests/unit/ipc-session-manager.test.ts` (~12 tests)

Test groups: constructor, createSession (throws without ipcOptions, returns sessionId), destroy.

### Task 1.3: Wire into ConsoleManager

- Add `import { IPCSessionManager } from './IPCSessionManager.js'`
- Add field: `private ipcSessionManager!: IPCSessionManager`
- Initialize in constructor after host builders
- Replace `createIPCSession()` body with delegation: `return this.ipcSessionManager.createSession(sessionId, session, options)`
- Remove `ipcProtocols` and `ipcSessions` Map declarations
- Add `this.ipcSessionManager.destroy()` to `destroy()`, remove ipc cleanup from ConsoleManager's destroy

### Task 1.4: Verify

```bash
npm run typecheck && npx jest --selectProjects unit 2>&1 | tail -5
git add -A && git commit -m "refactor: extract IPCSessionManager from ConsoleManager"
```

---

## Phase 2: SFTPSessionManager

### Task 2.1: Create `src/core/SFTPSessionManager.ts` (~200 lines)

**Extract from ConsoleManager.ts:**
- `createSFTPSession` (lines ~2580-2667 — within the createSessionInternal routing)
- `setupSFTPEventHandlers` (lines 7086-7101)
- `updateTransferSessionStats` (lines 7106-7117)
- `cleanupSFTPSession` (lines 7122-7133)
- `getSFTPProtocol` (lines 7138-7140)
- `uploadFile` (lines 7145-7156)
- `downloadFile` (lines 7161-7172)

**Fields to own internally:**
- `sftpProtocols: Map<string, IProtocol>` (was `Map<string, any>`)
- `fileTransferSessions: Map<string, FileTransferSession>`

**Pattern:** Per-session protocol (uses `host.getProtocolFactory().createProtocol('sftp')`). `setupEventHandlers()` is no-op (events wired per-session).

**`any` reduction:** `sftpProtocols: Map<string, any>` → `Map<string, IProtocol>`

### Task 2.2: Create `tests/unit/sftp-session-manager.test.ts` (~35 tests)

Test groups: constructor, createSession, uploadFile, downloadFile, getSFTPProtocol, cleanupSFTPSession, setupSFTPEventHandlers (transfer-progress stats mutation), destroy.

### Task 2.3: Wire into ConsoleManager

- Import + field + init
- Replace SFTP method bodies with delegation
- Remove `sftpProtocols`, `fileTransferSessions` declarations
- Move SFTP cleanup from `destroy()` to manager

### Task 2.4: Verify

```bash
npm run typecheck && npx jest --selectProjects unit 2>&1 | tail -5
git commit -m "refactor: extract SFTPSessionManager from ConsoleManager"
```

---

## Phase 3: WinRMSessionManager

### Task 3.1: Create `src/core/WinRMSessionManager.ts` (~250 lines)

**Extract from ConsoleManager.ts:**
- `createWinRMSession` (lines 6687-6772)
- `handleWinRMOutput` (lines 6641-6672)
- `sendInputToWinRM` (lines 4347-4413)

**Fields to own internally:**
- `winrmProtocols: Map<string, IProtocol>` (was `Map<string, any>`)
- `winrmSessions: Map<string, WinRMSessionState>`

**Pattern:** Per-session protocol. `setupEventHandlers()` is no-op.

**`any` reduction:** `winrmProtocols: Map<string, any>` → `Map<string, IProtocol>`

### Task 3.2: Create `tests/unit/winrm-session-manager.test.ts` (~38 tests)

Test groups: constructor, createSession (port/protocol defaults), sendInput (dual Map guards, perf counter mutations), handleWinRMOutput, setupEventHandlers, cleanupSession, destroy.

### Task 3.3: Wire into ConsoleManager + verify + commit

---

## Phase 4: WSLSessionManager

### Task 4.1: Create `src/core/WSLSessionManager.ts` (~300 lines)

**Extract from ConsoleManager.ts:**
- `setupWSLIntegration` (lines 7179-7189)
- `createWSLSession` (lines 7209-7254)
- `sendInputToWSL` (lines 7259-7317)
- `getWSLDistributions` (lines 7322-7331)
- `getWSLSystemInfo` (lines 7336-7343)
- `startWSLDistribution` (lines 7348-7359)
- `stopWSLDistribution` (lines 7364-7375)
- `getWSLHealthStatus` (lines 7380-7392)
- `translateWSLPath` (lines 7397-7407)
- `isWSLAvailable` (lines 7412-7418)
- `getWSLConfig` (lines 7424-7431)

**Fields to own internally:**
- `wslProtocol` uses the singleton `ensureProtocol()` pattern (only manager that does)

**Pattern:** Singleton protocol — uses `ProtocolSessionManagerBase.ensureProtocol()` normally.

**`any` reduction:** `wslProtocol?: any` → typed via base `this.protocol: IProtocol | null`. WSL-specific methods called via cast to a local `WSLProtocol` interface extending `IProtocol`.

**`resizeSession` note:** ConsoleManager's `resizeSession()` (line 6591) reaches into `this.wslProtocol`. After extraction, this becomes `this.wslSessionManager.resizeTerminal(sessionId, cols, rows)`. Add a `resizeTerminal` method to the manager.

### Task 4.2: Create `tests/unit/wsl-session-manager.test.ts` (~35 tests)

Test groups: constructor, setupWSLIntegration (idempotent, graceful error), createSession, sendInputToWSL (executeCommand, stdout/stderr output synthesis), 8 delegation methods, resizeTerminal, isWSLAvailable (swallows errors), destroy.

### Task 4.3: Wire into ConsoleManager + verify + commit

Also update `resizeSession()` to delegate WSL resize to the manager.

---

## Phase 5: VNCSessionManager

### Task 5.1: Create `src/core/VNCSessionManager.ts` (~350 lines)

**Extract from ConsoleManager.ts:**
- `createVNCSession` (lines 6777-6946)
- `setupVNCEventHandlers` (lines 6951-7023)
- `mapAuthMethodToVNCSecurityType` (lines 8057-8080)

**Fields to own internally:**
- `vncProtocols: Map<string, IProtocol>` (was `Map<string, any>`)
- `vncSessions: Map<string, VNCSession>`
- `vncFramebuffers: Map<string, VNCFramebuffer>`

**Extended host interface:**
```typescript
export interface VNCSessionHost extends ProtocolSessionHost {
  handleSessionError(sessionId: string, error: Error, operation: string): Promise<boolean>;
}
```

ConsoleManager implements via:
```typescript
private buildVNCSessionHost(): VNCSessionHost {
  return {
    ...this.buildProtocolSessionHost(),
    handleSessionError: (sid, err, op) => this.handleSessionError(sid, err, op),
  };
}
```

**`any` reduction:**
- `vncProtocols: Map<string, any>` → `Map<string, IProtocol>`
- 4× `(connectedSession as any).X` → local `VNCConnectedSession` interface

### Task 5.2: Create `tests/unit/vnc-session-manager.test.ts` (~40 tests)

Test groups: constructor, createSession (VNCSession construction, framebuffer init, auth mapping), setupVNCEventHandlers (framebuffer-update, server-message, clipboard, error, disconnect), mapAuthMethodToVNCSecurityType (9 auth types), cleanupSession, destroy.

### Task 5.3: Wire into ConsoleManager + verify + commit

---

## Phase 6: IPMISessionManager

### Task 6.1: Create `src/core/IPMISessionManager.ts` (~600 lines)

**Extract from ConsoleManager.ts:**
- `createIPMISession` (lines 7439-7510)
- `setupIPMIEventHandlers` (lines 7515-7580)
- `startIPMIMonitoring` (lines 7585-7641)
- `handleIPMISessionClosed` (lines 7646-7682)
- `sendIPMIInput` (lines 7687-7710)
- `executeIPMIPowerControl` (lines 7715-7754)
- `readIPMISensors` (lines 7759-7825)
- `getIPMIEventLog` (lines 7796-7825)
- `mountIPMIVirtualMedia` (lines 7830-7869)
- `unmountIPMIVirtualMedia` (lines 7874-7910)
- `updateIPMIFirmware` (lines 7915-7959)
- `getIPMISystemInfo` (lines 7964-7989)
- `configureIPMILAN` (lines 7994-8030)

**Fields to own internally:**
- `ipmiProtocols: Map<string, IProtocol>` (was `Map<string, any>`)
- `ipmiSessions: Map<string, IPMISessionState>`
- `ipmiMonitoringIntervals: Map<string, NodeJS.Timeout | NodeJS.Timeout[]>`

**Pattern:** Per-session protocol. `setupEventHandlers()` is no-op (events wired per-session on the `ipmiSession` object, not the protocol). The `startIPMIMonitoring` creates intervals that call `readIPMISensors` and `getIPMIEventLog` internally.

**`any` reduction:** `ipmiProtocols: Map<string, any>` → `Map<string, IProtocol>`, `ipmiSession: any` → `EventEmitter` or `IPMISessionHandle`.

**Important:** IPMI event handlers attach to the `ipmiSession` object (returned by `protocol.createSession()`), NOT the protocol itself. This differs from all other managers.

### Task 6.2: Create `tests/unit/ipmi-session-manager.test.ts` (~65 tests)

Test groups: constructor, createSession (monitoring intervals), sendIPMIInput (dual Map guards), executeIPMIPowerControl (5 operations), readIPMISensors, getIPMIEventLog, mountIPMIVirtualMedia, unmountIPMIVirtualMedia, updateIPMIFirmware, getIPMISystemInfo, configureIPMILAN (iteration), setupIPMIEventHandlers (on ipmiSession not protocol), startIPMIMonitoring (interval creation/cleanup), destroy (interval cleanup).

### Task 6.3: Wire into ConsoleManager + verify + commit

Remove `ipmiProtocols`, `ipmiSessions`, `ipmiMonitoringIntervals` declarations. Move IPMI interval cleanup from `destroy()` to manager.

---

## Final Verification

```bash
npm run typecheck
npx jest --selectProjects unit 2>&1 | tail -10
# Expect: ~1,384 tests passing (1,159 + 225 new)
wc -l src/core/ConsoleManager.ts
# Expect: ~6,600 lines
```

## Subagent Execution Notes

Each phase should be dispatched as a fresh subagent with:
1. Full ConsoleManager.ts source (relevant sections only — constructor fields, the methods being extracted, destroy(), and the routing in createSessionInternal/sendInput)
2. ProtocolSessionManagerBase.ts (86 lines)
3. One example extraction for reference (e.g., RDPSessionManager.ts for per-session pattern, or WebSocketTerminalSessionManager.ts for singleton)
4. Relevant type definitions from types/index.ts
5. Codesight CLI available: `CODESIGHT_ALLOWED_ROOTS="/Users/cevin/src" codesight-mcp <tool> --args`

For per-session managers (IPMI, VNC, WinRM, SFTP, IPC): use RDPSessionManager as the reference pattern.
For singleton manager (WSL): use WebSocketTerminalSessionManager as the reference pattern.
