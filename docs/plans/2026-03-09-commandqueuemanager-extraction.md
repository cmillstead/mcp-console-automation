# CommandQueueManager Extraction Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract command queue management from ConsoleManager into a dedicated CommandQueueManager class.

**Architecture:** CommandQueueManager owns all queue state, execution tracking, and queue processing. ConsoleManager implements a `CommandQueueHost` callback interface for the few things that need session/SSH/protocol access. Other managers (NetworkMetricsManager, SessionPersistenceManager, ErrorRecovery) are passed directly.

**Tech Stack:** TypeScript, Jest

---

### Scope

**Interfaces to move** (lines 96-141):
- `QueuedCommand`
- `SessionCommandQueue`
- `CommandQueueConfig`
- `TimeoutRecoveryResult` (lines 111-117)

**Fields to move** (7 total, lines 170-178):
- `commandExecutions: Map<string, CommandExecution>`
- `sessionCommandQueue: Map<string, string[]>`
- `outputSequenceCounters: Map<string, number>`
- `promptPatterns: Map<string, RegExp>`
- `commandQueues: Map<string, SessionCommandQueue>`
- `queueConfig: CommandQueueConfig`
- `commandProcessingIntervals: Map<string, NodeJS.Timeout>`

**Methods to move** (29 total):
1. `initializeSessionCommandTracking` (line 682)
2. `createSessionBookmark` (line 718) — thin wrapper stays, but queue snapshot logic moves
3. `createSessionDataProvider` (line 737) — queue part moves
4. `serializeCommandQueue` (line 761)
5. `deserializeCommandQueue` (line 780)
6. `startCommandExecution` (line 802)
7. `completeCommandExecution` (line 852)
8. `getCommandOutput` (line 913)
9. `detectCommandCompletion` (line 926)
10. `executeCommandInSession` (line 939)
11. `waitForCommandCompletion` (line 1018)
12. `getCommandExecutionDetails` (line 1103)
13. `getSessionCommandHistory` (line 1110)
14. `cleanupSessionCommandHistory` (line 1120)
15. `configurePromptDetection` (line 6006)
16. `initializeCommandQueue` (line 7356)
17. `processCommandQueue` (line 7394)
18. `sendCommandToSSH` (line 7649)
19. `handleSSHOutputForQueue` (line 7713)
20. `addCommandToQueue` (line 7734)
21. `clearCommandQueue` (line 7773)
22. `getCommandQueueStats` (line 7805)
23. `configureCommandQueue` (line 9601)
24. `getSessionQueueStats` (line 9609)
25. `getAllCommandQueueStats` (line 9616)
26. `clearSessionCommandQueue` (line 9639)
27. `clearAllCommandQueues` (line 9646)
28. `setSessionPromptPattern` (line 9655)
29. `forceProcessCommandQueue` (line 9678)

---

### Callback Interface Design

```typescript
/**
 * Interface that ConsoleManager implements to provide
 * session/SSH/protocol access to CommandQueueManager.
 */
export interface CommandQueueHost {
  // Session access
  getSession(sessionId: string): ConsoleSession | undefined;
  updateSessionExecutionState(sessionId: string, state: 'idle' | 'executing', commandId?: string): void;
  getOutputBufferLength(sessionId: string): number;

  // SSH/protocol access
  getSSHChannel(sessionId: string): ClientChannel | undefined;
  getSessionSSHHost(sessionId: string): string | undefined;
  sendInput(sessionId: string, input: string): Promise<void>;
  addToOutputBuffer(sessionId: string, output: ConsoleOutput): void;

  // Event emission
  emitEvent(event: ConsoleEvent): void;

  // Monitoring
  isSessionMonitored(sessionId: string): boolean;
  recordMonitoringEvent(sessionId: string, type: string, data: any): void;
  recordCommandMetrics(success: boolean, duration: number, command: string, sessionId: string): void;

  // Recovery (stays in ConsoleManager due to deep coupling)
  attemptTimeoutRecovery(sessionId: string, command: QueuedCommand): Promise<TimeoutRecoveryResult>;

  // Utilities
  delay(ms: number): Promise<void>;
}
```

---

### Task 1: Create CommandQueueManager class

**Files:**
- Create: `src/core/CommandQueueManager.ts`

**Step 1: Create the file with interfaces, fields, constructor**

Create `src/core/CommandQueueManager.ts` with:
- Export interfaces: `QueuedCommand`, `SessionCommandQueue`, `CommandQueueConfig`, `TimeoutRecoveryResult`, `CommandQueueHost`
- Import types: `CommandExecution`, `ConsoleOutput`, `ConsoleEvent`, `SessionOptions`, `SSHConnectionOptions` from types
- Import: `ClientChannel` from ssh2
- Import: `Logger`, `SessionPersistenceManager`, `NetworkMetricsManager`, `ErrorRecovery`
- Import: `v4 as uuidv4` from uuid

Constructor takes:
- `logger: Logger`
- `host: CommandQueueHost`
- `networkMetricsManager: NetworkMetricsManager`
- `persistenceManager: SessionPersistenceManager`
- `errorRecovery: ErrorRecovery`

Initialize all 7 fields in constructor. Default `queueConfig` with same values as current ConsoleManager constructor (maxQueueSize: 100, commandTimeout: 30000, interCommandDelay: 100, acknowledgmentTimeout: 5000, enablePromptDetection: true, defaultPromptPattern: /[$#>]\s*$/).

**Step 2: Move all 29 methods**

Move each method, replacing `this.sessions.get()` with `this.host.getSession()`, `this.sshChannels.get()` with `this.host.getSSHChannel()`, etc. Key transformations:

- `startCommandExecution`: use `host.getSession()`, `host.updateSessionExecutionState()`, `host.getOutputBufferLength()`
- `completeCommandExecution`: use `host.getSession()`, `host.updateSessionExecutionState()`, `host.recordCommandMetrics()`
- `executeCommandInSession`: use `host.getSession()`, `host.sendInput()`, `host.addToOutputBuffer()`
- `processCommandQueue`: use `host.getSSHChannel()`, `host.getSessionSSHHost()`, `host.attemptTimeoutRecovery()`, `host.delay()`
- `sendCommandToSSH`: use `host.isSessionMonitored()`, `host.recordMonitoringEvent()`, `host.emitEvent()`
- `initializeSessionCommandTracking`: takes `consoleType` string instead of full SessionOptions
- `configurePromptDetection`: takes `sshOptions: {host, username}` instead of full SessionOptions

Public methods: `initializeSessionCommandTracking`, `executeCommandInSession`, `addCommandToQueue`, `handleSSHOutputForQueue`, `configurePromptDetection`, `getCommandExecutionDetails`, `getSessionCommandHistory`, `cleanupSessionCommandHistory`, `configureCommandQueue`, `getSessionQueueStats`, `getAllCommandQueueStats`, `clearSessionCommandQueue`, `clearAllCommandQueues`, `setSessionPromptPattern`, `getCommandQueueConfig`, `forceProcessCommandQueue`, `serializeCommandQueue`, `getCommandQueueSnapshot` (for SessionDataProvider), `clearCommandQueue`

**Step 3: Add dispose() method**

Clear all `commandProcessingIntervals` timers, reject all pending queue commands, clear all maps.

---

### Task 2: Update ConsoleManager to delegate

**Files:**
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Add CommandQueueManager field and implement CommandQueueHost**

- Import `CommandQueueManager` and `CommandQueueHost`
- Remove moved interfaces, fields, and methods
- Add `private commandQueueManager: CommandQueueManager`
- Implement `CommandQueueHost` on ConsoleManager (add the interface methods)
- Instantiate CommandQueueManager in constructor, passing `this` as host

**Step 2: Replace all call sites**

Replace every `this.<movedMethod>()` with `this.commandQueueManager.<method>()`. Key call sites to find:
- `initializeSessionCommandTracking` — called during session creation
- `initializeCommandQueue` — called in SSH handlers
- `handleSSHOutputForQueue` — called from SSH data handlers
- `addCommandToQueue` — called from sendInput
- `clearCommandQueue` — called during session cleanup
- `executeCommandInSession` — public API
- `createSessionBookmark` — wrapper that passes queue snapshot
- `createSessionDataProvider` — delegates queue part

**Step 3: Update createSessionDataProvider**

The `getCommandQueueSnapshot` part now delegates to `commandQueueManager.getCommandQueueSnapshot(sessionId)`.

**Step 4: Update destroy()**

Call `this.commandQueueManager.dispose()` and remove commandProcessingIntervals cleanup.

---

### Task 3: Typecheck

Run: `./node_modules/.bin/tsc --noEmit`
Expected: Clean

---

### Task 4: Run tests

Run: `./node_modules/.bin/jest tests/protocols/ tests/ErrorDetector.test.ts --ci --maxWorkers=2 --forceExit`
Expected: Same pass/fail as before

---

### Task 5: Commit

```
git add src/core/CommandQueueManager.ts src/core/ConsoleManager.ts
git commit -m "refactor: extract CommandQueueManager from ConsoleManager"
```
