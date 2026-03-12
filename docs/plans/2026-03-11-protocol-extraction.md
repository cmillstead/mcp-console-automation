# Protocol Extraction Implementation Plan

**Date**: 2026-03-11
**Design Doc**: `docs/plans/2026-03-11-protocol-extraction-design.md`
**Target**: Extract 7 protocol session managers + 1 TimeoutRecoveryManager from `src/core/ConsoleManager.ts` (11,015 lines)

---

## Conventions

- **CM** = `src/core/ConsoleManager.ts`
- All line numbers are from the current `master` (commit `db77dbd`)
- Every phase ends with: `npm test -- --selectProjects unit`, `npm run lint`, `npm run typecheck`
- Each task is 2-5 minutes of implementation work
- TDD: write failing test first, then implement, then verify

---

## Phase 0 — Delete Dead `dockerProtocol` Field

**Goal**: Remove the unused `dockerProtocol` field and its ~62-line constructor initialization. This is the simplest possible extraction and validates nothing breaks.

### Task 0.1: Delete `dockerProtocol` field declaration

**File**: `src/core/ConsoleManager.ts`
**Line 134**: Delete the field declaration:
```typescript
// DELETE this line:
  private dockerProtocol: DockerProtocol;
```

### Task 0.2: Delete `dockerProtocol` constructor initialization

**File**: `src/core/ConsoleManager.ts`
**Lines 360-422** (inside `constructor`): Delete the entire block that initializes `this.dockerProtocol = new DockerProtocol({...})`. This is a 62-line block starting at line 360:
```typescript
    // Initialize Docker protocol with default configuration
    this.dockerProtocol = new DockerProtocol({
```
and ending at line 422:
```typescript
    });
```

### Task 0.3: Delete `dockerProtocol` references from `destroy()` and dead method

**File**: `src/core/ConsoleManager.ts`

There are exactly 2 references to `this.dockerProtocol` (found via grep):
1. **Line 361**: Constructor init (deleted in Task 0.2)
2. **Line 7795**: In the `destroy()` method's legacy protocol cleanup array:
   ```typescript
   { name: 'docker', instance: this.dockerProtocol },
   ```
   Delete this line from the `legacyProtocols` array (line 7795).

Also delete `setupDockerProtocolHandlers` (lines 1519-1618) -- this is a dead method that already returns immediately with all its code commented out. The `createDockerSession` method (line 5001) uses `this.protocolFactory.createProtocol('docker')`, NOT `this.dockerProtocol`, so it stays.

### Task 0.4: Remove unused DockerProtocol import

**File**: `src/core/ConsoleManager.ts`
**Line 85**: Delete:
```typescript
import { DockerProtocol } from '../protocols/DockerProtocol.js';
```

### Task 0.5: Verify

```bash
npm run typecheck
npm run lint
npm test 2>&1 | tail -20
```

**Expected**: All 1,012+ tests pass. Zero type errors. No new lint warnings.

### Task 0.6: Commit

```bash
git add src/core/ConsoleManager.ts
git commit -m "refactor: delete dead dockerProtocol field and constructor init

Removes ~65 lines of dead code. Docker sessions already use the unified
protocolFactory.createProtocol('docker') path via createDockerSession().

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 1 — TimeoutRecoveryManager Extraction

**Goal**: Extract ~607 lines of timeout recovery logic into `src/core/TimeoutRecoveryManager.ts`.

### Methods to extract (from CM symbol map):

| Method | Lines | Line Range |
|---|---|---|
| `attemptTimeoutRecovery` | 324 | 2325-2649 |
| `restoreSessionStateFromBookmark` | 32 | 2654-2684 |
| `restoreCommandQueueFromPersistence` | 29 | 2684-2717 |
| `attemptSSHReconnectionWithPersistence` | 39 | 2717-2787 |
| `classifyTimeoutError` | 38 | 3308-3346 |
| `determineTimeoutSeverity` | 38 | 3351-3390 |
| `recordRecoveryAttempt` | 64 | 3390-3455 |
| `getTimeoutRecoveryMetrics` | 31 | 3455-3487 |
| `logRecoveryMetrics` | 21 | 3487-3509 |
| `validateSessionRecovery` | 82 | 3509-3592 |
| `testSSHResponsiveness` | 118 | 3161-3282 |
| `clearStaleOutput` | 6 | 3282-3301 |
| `delay` | 6 | 3301-3308 |

**Fields to move**:
- `timeoutRecoveryAttempts: Map<string, number>` (line 213)
- `maxTimeoutRecoveryAttempts = 3` (line 214)
- `recoveryMetrics` (lines 217-235)
- `TIMEOUT_ERROR_PATTERNS` (static, lines 238-276)

### Task 1.1: Write failing test for TimeoutRecoveryManager

**File**: `tests/unit/timeout-recovery-manager.test.ts`

```typescript
import { TimeoutRecoveryManager, TimeoutRecoveryHost } from '../../src/core/TimeoutRecoveryManager';
import { Logger } from '../../src/utils/logger';
import { ErrorRecovery } from '../../src/core/ErrorRecovery';
import { RetryManager } from '../../src/core/RetryManager';

function createMockHost(): TimeoutRecoveryHost {
  return {
    getSSHClient: jest.fn().mockReturnValue(null),
    getSSHChannel: jest.fn().mockReturnValue(null),
    attemptSSHReconnection: jest.fn().mockResolvedValue({ success: true, reconnected: true }),
    sendInput: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockReturnValue({ id: 'test-session', status: 'running' }),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getSessionRecovery: jest.fn().mockReturnValue({
      shouldTriggerInteractiveRecovery: jest.fn().mockReturnValue({ shouldTrigger: false }),
      updateInteractiveState: jest.fn().mockResolvedValue(undefined),
      recoverSession: jest.fn().mockResolvedValue(false),
    }),
    getPersistenceManager: jest.fn().mockReturnValue({
      getSessionData: jest.fn().mockReturnValue(null),
      saveSessionData: jest.fn().mockResolvedValue(undefined),
    }),
    emitEvent: jest.fn(),
    clearQueueOutputBuffer: jest.fn(),
    isSelfHealingEnabled: jest.fn().mockReturnValue(true),
    delay: jest.fn().mockResolvedValue(undefined),
    getSessionPersistenceData: jest.fn().mockReturnValue(null),
    getSessionBookmarks: jest.fn().mockReturnValue([]),
    createSessionBookmark: jest.fn().mockResolvedValue(undefined),
    getRetryManager: jest.fn().mockReturnValue({
      executeWithRetry: jest.fn().mockImplementation(async (fn) => fn()),
      getCircuitBreakerStates: jest.fn().mockReturnValue({}),
    }),
    getErrorRecovery: jest.fn().mockReturnValue({
      classifyError: jest.fn().mockReturnValue({ type: 'timeout', severity: 'medium', recoverable: true }),
      attemptRecovery: jest.fn().mockResolvedValue(false),
    }),
  };
}

function createMockLogger(): Logger {
  const logger = new Logger('test');
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  return logger;
}

describe('TimeoutRecoveryManager', () => {
  let manager: TimeoutRecoveryManager;
  let host: TimeoutRecoveryHost;
  let logger: Logger;

  beforeEach(() => {
    host = createMockHost();
    logger = createMockLogger();
    manager = new TimeoutRecoveryManager(host, logger);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(TimeoutRecoveryManager);
    });
  });

  describe('classifyTimeoutError', () => {
    it('should classify command acknowledgment timeout', () => {
      const error = new Error('SSH command acknowledgment timeout after 30000ms');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('command_acknowledgment');
      expect(result.recoverable).toBe(true);
    });

    it('should classify SSH connection timeout', () => {
      const error = new Error('SSH connection timeout');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('ssh_connection');
    });

    it('should classify network latency timeout', () => {
      const error = new Error('High latency detected');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('network_latency');
    });

    it('should handle unknown timeout errors', () => {
      const error = new Error('Some unknown error');
      const result = manager.classifyTimeoutError(error);
      expect(result.type).toBe('timeout');
    });
  });

  describe('getTimeoutRecoveryMetrics', () => {
    it('should return initial empty metrics', () => {
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(0);
      expect(metrics.successfulRecoveries).toBe(0);
    });
  });

  describe('attemptTimeoutRecovery', () => {
    it('should fail when max attempts exceeded', async () => {
      // Exhaust max attempts
      for (let i = 0; i < 4; i++) {
        manager['recoveryAttempts'].set('test-session', i);
      }
      const command = {
        input: 'test-command',
        timestamp: new Date(),
        acknowledged: false,
        sent: true,
        retryCount: 0,
        id: 'cmd-1',
      };
      const result = await manager.attemptTimeoutRecovery('test-session', command as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Max recovery attempts');
    });

    it('should attempt reconnection when SSH client is missing', async () => {
      host.getSSHClient = jest.fn().mockReturnValue(null);
      host.getSSHChannel = jest.fn().mockReturnValue(null);
      const command = {
        input: 'test-command',
        timestamp: new Date(),
        acknowledged: false,
        sent: true,
        retryCount: 0,
        id: 'cmd-1',
      };
      const result = await manager.attemptTimeoutRecovery('test-session', command as any);
      expect(host.getSSHClient).toHaveBeenCalledWith('test-session');
    });
  });

  describe('dispose', () => {
    it('should clear internal state', () => {
      manager['recoveryAttempts'].set('test-session', 3);
      manager.dispose();
      expect(manager['recoveryAttempts'].size).toBe(0);
    });
  });
});
```

Run:
```bash
npx jest tests/unit/timeout-recovery-manager.test.ts 2>&1 | tail -10
```
**Expected**: FAIL (module not found).

### Task 1.2: Create TimeoutRecoveryHost interface and TimeoutRecoveryManager class

**File**: `src/core/TimeoutRecoveryManager.ts`

Create the file with:
1. `TimeoutRecoveryHost` interface (exported) -- see design doc section 3.4
2. `TimeoutRecoveryManager` class (exported) with:
   - Constructor takes `(host: TimeoutRecoveryHost, logger: Logger)`
   - All private fields from CM lines 213-276 (the maps, metrics, patterns)
   - All methods listed in the extraction table above -- copy verbatim from CM, then change `this.` references to use `this.host.` for host callbacks

**Key transformations when moving methods**:
- `this.timeoutRecoveryAttempts` -> `this.recoveryAttempts` (rename in new class)
- `this.maxTimeoutRecoveryAttempts` -> `this.maxRecoveryAttempts`
- `this.sshClients.get(sessionId)` -> `this.host.getSSHClient(sessionId)`
- `this.sshChannels.get(sessionId)` -> `this.host.getSSHChannel(sessionId)`
- `this.sessions.get(sessionId)` -> `this.host.getSession(sessionId)`
- `this.outputBuffers.get(sessionId)` -> `this.host.getOutputBuffer(sessionId)`
- `this.outputBuffers.set(sessionId, ...)` -> `this.host.setOutputBuffer(sessionId, ...)`
- `this.sessionRecovery` -> `this.host.getSessionRecovery()`
- `this.persistenceManager` -> `this.host.getPersistenceManager()`
- `this.retryManager.executeWithRetry(...)` -> `this.host.getRetryManager().executeWithRetry(...)`
- `this.errorRecovery.classifyError(...)` -> `this.host.getErrorRecovery().classifyError(...)`
- `this.emitEvent(...)` -> `this.host.emitEvent(...)`
- `this.delay(...)` -> `this.host.delay(...)`
- `this.createSessionBookmark(...)` -> `this.host.createSessionBookmark(...)`
- `this.attemptSSHReconnection(...)` -> `this.host.attemptSSHReconnection(...)`
- `ConsoleManager.TIMEOUT_ERROR_PATTERNS` -> `TimeoutRecoveryManager.TIMEOUT_ERROR_PATTERNS`

Make `classifyTimeoutError` public (it was private in CM but the test needs it; also useful for external callers).

### Task 1.3: Wire TimeoutRecoveryManager into ConsoleManager

**File**: `src/core/ConsoleManager.ts`

1. Add import at top:
```typescript
import { TimeoutRecoveryManager, TimeoutRecoveryHost } from './TimeoutRecoveryManager.js';
```

2. Add field declaration (near line 129, after `commandQueueManager`):
```typescript
  private timeoutRecoveryManager!: TimeoutRecoveryManager;
```

3. In constructor (after `this.errorRecovery = new ErrorRecovery();` around line 474), add:
```typescript
    // Initialize timeout recovery manager
    this.timeoutRecoveryManager = new TimeoutRecoveryManager(
      this.buildTimeoutRecoveryHost(),
      this.logger
    );
```

4. Add `buildTimeoutRecoveryHost()` method (add near the other `build*Host()` methods):
```typescript
  private buildTimeoutRecoveryHost(): TimeoutRecoveryHost {
    return {
      getSSHClient: (sessionId: string) => this.sshClients.get(sessionId),
      getSSHChannel: (sessionId: string) => this.sshChannels.get(sessionId),
      attemptSSHReconnection: (sessionId: string) => this.attemptSSHReconnection(sessionId),
      sendInput: (sessionId: string, input: string) => this.sendInput(sessionId, input),
      getSession: (sessionId: string) => this.sessions.get(sessionId),
      getOutputBuffer: (sessionId: string) => this.outputBuffers.get(sessionId) || [],
      setOutputBuffer: (sessionId: string, buffer: any[]) => this.outputBuffers.set(sessionId, buffer),
      getSessionRecovery: () => this.sessionRecovery,
      getPersistenceManager: () => this.persistenceManager,
      emitEvent: (event: any) => this.emitEvent(event),
      clearQueueOutputBuffer: (sessionId: string) => {
        const buffer = this.outputBuffers.get(sessionId);
        if (buffer) buffer.length = 0;
      },
      isSelfHealingEnabled: () => this.selfHealingEnabled,
      delay: (ms: number) => this.delay(ms),
      getSessionPersistenceData: (sessionId: string) => this.sessionPersistenceData.get(sessionId),
      getSessionBookmarks: (sessionId: string) => this.sessionBookmarks.get(sessionId) || [],
      createSessionBookmark: (sessionId: string, reason: string) => this.createSessionBookmark(sessionId, reason),
      getRetryManager: () => this.retryManager,
      getErrorRecovery: () => this.errorRecovery,
    };
  }
```

5. Replace the body of `attemptTimeoutRecovery` method (line 2325-2649) with delegation:
```typescript
  private async attemptTimeoutRecovery(
    sessionId: string,
    command: QueuedCommand
  ): Promise<TimeoutRecoveryResult> {
    return this.timeoutRecoveryManager.attemptTimeoutRecovery(sessionId, command);
  }
```

6. Replace `classifyTimeoutError` (line 3308-3346), `determineTimeoutSeverity` (3351-3390), `recordRecoveryAttempt` (3390-3455), `getTimeoutRecoveryMetrics` (3455-3487), `logRecoveryMetrics` (3487-3509), `validateSessionRecovery` (3509-3592), `testSSHResponsiveness` (3161-3282), `clearStaleOutput` (3282-3301) with thin delegations:
```typescript
  // Keep getTimeoutRecoveryMetrics as public, delegate:
  getTimeoutRecoveryMetrics() {
    return this.timeoutRecoveryManager.getTimeoutRecoveryMetrics();
  }
```

For private methods that are ONLY called from `attemptTimeoutRecovery` (which is now delegated), simply **delete** them from CM since the logic lives in TimeoutRecoveryManager now.

7. Delete the field declarations that moved (lines 213-276): `timeoutRecoveryAttempts`, `maxTimeoutRecoveryAttempts`, `recoveryMetrics`, `TIMEOUT_ERROR_PATTERNS`.

8. In `destroy()` (line 10328), add before `this.removeAllListeners()`:
```typescript
    this.timeoutRecoveryManager.dispose();
```

### Task 1.4: Run tests and verify

```bash
npx jest tests/unit/timeout-recovery-manager.test.ts 2>&1 | tail -20
npm run typecheck
npm run lint
npm test 2>&1 | tail -20
```

**Expected**: New tests pass. All existing tests pass. Zero type errors.

### Task 1.5: Commit

```bash
git add src/core/TimeoutRecoveryManager.ts src/core/ConsoleManager.ts tests/unit/timeout-recovery-manager.test.ts
git commit -m "refactor: extract TimeoutRecoveryManager from ConsoleManager

Moves ~607 lines of timeout recovery logic (attemptTimeoutRecovery,
classifyTimeoutError, determineTimeoutSeverity, recordRecoveryAttempt,
validateSessionRecovery, testSSHResponsiveness, etc.) into a dedicated
TimeoutRecoveryManager class using the Host callback pattern.

Eliminates: timeoutRecoveryAttempts, recoveryMetrics,
TIMEOUT_ERROR_PATTERNS fields from ConsoleManager.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 2 — ProtocolSessionManagerBase + SerialSessionManager

**Goal**: Create the abstract base class and extract SerialSessionManager (~387 lines) as pattern validation.

### Methods to extract from CM:

| Method | Line Range |
|---|---|
| `createSerialSession` | 5460-5604 |
| `setupSerialProtocolEventHandlers` | 5609-5650 |
| `handleSerialOutput` | 5650-5673 |
| `handleSerialLine` | 5673-5701 |
| `handleSerialBinaryData` | 5701-5709 |
| `getDefaultSerialErrorPatterns` | 5709-5757 |
| `cleanupSerialSession` | 5757-5786 |
| `sendInputToSerial` | 8794-8837 |
| `discoverSerialDevices` | 10259-10278 |
| `getSerialConnectionStatus` | 10278-10289 |
| `resetSerialDevice` | 10289-10311 |
| `getSerialOutputBuffer` | 10311-10322 |
| `clearSerialOutputBuffer` | 10322-10328 |

**Fields to move**:
- `serialProtocol?: any` (line 181) -> `protocol: IProtocol | null`

### Task 2.1: Write failing test for SerialSessionManager

**File**: `tests/unit/serial-session-manager.test.ts`

```typescript
import { SerialSessionManager } from '../../src/core/SerialSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';

function createMockHost(): ProtocolSessionHost {
  const mockProtocol = {
    createConnection: jest.fn().mockResolvedValue(undefined),
    discoverDevices: jest.fn().mockResolvedValue([]),
    getConnectionStatus: jest.fn().mockReturnValue({ connected: false }),
    sendData: jest.fn().mockResolvedValue(undefined),
    sendBreak: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    on: jest.fn().mockReturnThis(),
    removeAllListeners: jest.fn(),
  };

  return {
    getSession: jest.fn().mockReturnValue(null),
    setSession: jest.fn(),
    deleteSession: jest.fn(),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getMaxBufferSize: jest.fn().mockReturnValue(10000),
    createStreamManager: jest.fn(),
    deleteStreamManager: jest.fn(),
    updateSessionStatus: jest.fn().mockResolvedValue(undefined),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn(),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue({ addPatterns: jest.fn() }),
    addErrorPatterns: jest.fn(),
    isSelfHealingEnabled: jest.fn().mockReturnValue(false),
    getNextSequenceNumber: jest.fn().mockReturnValue(1),
    getLogger: jest.fn().mockReturnValue(new Logger('test')),
    getMonitoringSystem: jest.fn().mockReturnValue({
      startSessionMonitoring: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

function createMockLogger(): Logger {
  const logger = new Logger('test');
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  return logger;
}

describe('SerialSessionManager', () => {
  let manager: SerialSessionManager;
  let host: ProtocolSessionHost;
  let logger: Logger;

  beforeEach(() => {
    host = createMockHost();
    logger = createMockLogger();
    manager = new SerialSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('should create an instance', () => {
    expect(manager).toBeInstanceOf(SerialSessionManager);
  });

  describe('createSession', () => {
    it('should create a serial session with explicit options', async () => {
      const session = { id: 'test-1', status: 'initializing' };
      const options = {
        command: 'serial',
        consoleType: 'serial',
        serialOptions: {
          path: '/dev/ttyUSB0',
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
        },
      };
      const result = await manager.createSession('test-1', session as any, options as any);
      expect(result).toBe('test-1');
      expect(host.setSession).toHaveBeenCalled();
    });

    it('should throw when no serial options provided for non-serial type', async () => {
      const session = { id: 'test-2', status: 'initializing' };
      const options = { command: 'test', consoleType: 'ssh' };
      await expect(
        manager.createSession('test-2', session as any, options as any)
      ).rejects.toThrow('Serial options');
    });
  });

  describe('sendInput', () => {
    it('should delegate sendInput to protocol', async () => {
      // First create a session to init the protocol
      const session = { id: 'test-3', status: 'initializing' };
      const options = {
        command: 'serial',
        consoleType: 'serial',
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      };
      await manager.createSession('test-3', session as any, options as any);
      await manager.sendInput('test-3', 'hello\n');
      // Protocol's sendData should have been called
      const protocol = await (host.getOrCreateProtocol as jest.Mock).mock.results[0].value;
      expect(protocol.sendData).toHaveBeenCalled();
    });
  });

  describe('getDefaultSerialErrorPatterns', () => {
    it('should return array of error patterns', () => {
      const patterns = manager.getDefaultSerialErrorPatterns();
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  describe('destroy', () => {
    it('should clean up protocol on destroy', async () => {
      const session = { id: 'test-4', status: 'initializing' };
      const options = {
        command: 'serial',
        consoleType: 'serial',
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      };
      await manager.createSession('test-4', session as any, options as any);
      await manager.destroy();
      // Should not throw
    });
  });
});
```

### Task 2.2: Create ProtocolSessionManagerBase abstract class

**File**: `src/core/ProtocolSessionManagerBase.ts`

```typescript
import { Logger } from '../utils/logger.js';
import type { IProtocol } from './IProtocol.js';
import type { ConsoleType } from '../types/index.js';

/**
 * Host interface shared by all protocol session managers.
 * ConsoleManager implements this via buildXxxHost() pattern.
 */
export interface ProtocolSessionHost {
  // Session state access
  getSession(sessionId: string): any;
  setSession(sessionId: string, session: any): void;
  deleteSession(sessionId: string): void;

  // Output buffer management
  getOutputBuffer(sessionId: string): any[];
  setOutputBuffer(sessionId: string, buffer: any[]): void;
  getMaxBufferSize(): number;

  // Stream management
  createStreamManager(sessionId: string, options: any): void;
  deleteStreamManager(sessionId: string): void;

  // Session manager integration
  updateSessionStatus(sessionId: string, status: string, metadata?: Record<string, unknown>): Promise<void>;
  registerSessionWithHealthMonitoring(sessionId: string, session: any, options: any): Promise<void>;

  // Event emission
  emitEvent(event: any): void;
  emitTypedEvent(eventName: string, data: Record<string, unknown>): void;

  // Protocol factory access
  getProtocolFactory(): any;
  getOrCreateProtocol(type: ConsoleType | string): Promise<IProtocol>;

  // Error detection
  getErrorDetector(): any;
  addErrorPatterns(patterns: any[]): void;

  // Self-healing
  isSelfHealingEnabled(): boolean;

  // Command queue integration
  getNextSequenceNumber(sessionId: string): number;

  // Logger access
  getLogger(): Logger;

  // Monitoring system
  getMonitoringSystem(): any;
}

/**
 * Abstract base class for all protocol session managers.
 * Provides lazy protocol initialization, event handler setup, and cleanup.
 */
export abstract class ProtocolSessionManagerBase {
  protected protocol: IProtocol | null = null;
  protected host: ProtocolSessionHost;
  protected logger: Logger;
  protected protocolType: ConsoleType | string;

  constructor(host: ProtocolSessionHost, logger: Logger, protocolType: ConsoleType | string) {
    this.host = host;
    this.logger = logger;
    this.protocolType = protocolType;
  }

  /** Lazy-init the protocol instance */
  protected async ensureProtocol(): Promise<IProtocol> {
    if (!this.protocol) {
      this.protocol = await this.host.getOrCreateProtocol(this.protocolType);
      this.setupEventHandlers();
    }
    return this.protocol;
  }

  /** Subclass implements protocol-specific event wiring */
  protected abstract setupEventHandlers(): void;

  /** Cleanup protocol and session state */
  async destroy(): Promise<void> {
    if (this.protocol && typeof (this.protocol as any).cleanup === 'function') {
      try {
        await (this.protocol as any).cleanup();
      } catch (e) {
        this.logger.warn(
          `Error cleaning up ${this.protocolType} protocol:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.protocol = null;
  }
}
```

### Task 2.3: Create SerialSessionManager

**File**: `src/core/SerialSessionManager.ts`

Create the class extending `ProtocolSessionManagerBase`. Move all methods from the extraction table in Task 2 intro. Key points:
- Constructor calls `super(host, logger, 'serial')`
- `createSession(sessionId, session, options)` — copy from CM `createSerialSession` (lines 5460-5604), transform `this.` references:
  - `this.serialProtocol` -> `await this.ensureProtocol()`
  - `this.sessions.set(...)` -> `this.host.setSession(...)`
  - `this.outputBuffers.set(...)` -> `this.host.setOutputBuffer(...)`
  - `this.streamManagers.set(...)` -> `this.host.createStreamManager(...)`
  - `this.monitoringSystems.set(...)` -> host monitoring
  - `this.errorDetector.addPatterns(...)` -> `this.host.addErrorPatterns(...)`
  - `this.emit(...)` -> `this.host.emitEvent(...)`
  - `this.selfHealingEnabled` -> `this.host.isSelfHealingEnabled()`
  - `this.registerSessionWithHealthMonitoring(...)` -> `this.host.registerSessionWithHealthMonitoring(...)`
- Move `sendInputToSerial` as `sendInput(sessionId, input)` — copy from CM line 8794
- Move `discoverSerialDevices`, `getSerialConnectionStatus`, `resetSerialDevice`, `getSerialOutputBuffer`, `clearSerialOutputBuffer` as public methods
- Make `getDefaultSerialErrorPatterns` public (for testing)

### Task 2.4: Wire SerialSessionManager into ConsoleManager

1. Add import: `import { SerialSessionManager } from './SerialSessionManager.js';`
2. Add field: `private serialSessionManager!: SerialSessionManager;`
3. In constructor, after TimeoutRecoveryManager init:
```typescript
    this.serialSessionManager = new SerialSessionManager(
      this.buildProtocolSessionHost(),
      this.logger
    );
```
4. Add `buildProtocolSessionHost()` method (shared by all protocol managers):
```typescript
  private buildProtocolSessionHost(): ProtocolSessionHost {
    return {
      getSession: (id: string) => this.sessions.get(id),
      setSession: (id: string, s: any) => this.sessions.set(id, s),
      deleteSession: (id: string) => this.sessions.delete(id),
      getOutputBuffer: (id: string) => this.outputBuffers.get(id) || [],
      setOutputBuffer: (id: string, buf: any[]) => this.outputBuffers.set(id, buf),
      getMaxBufferSize: () => this.maxBufferSize,
      createStreamManager: (id: string, opts: any) => {
        const sm = new StreamManager(id, opts);
        this.streamManagers.set(id, sm);
      },
      deleteStreamManager: (id: string) => this.streamManagers.delete(id),
      updateSessionStatus: (id, status, meta) => this.sessionManager.updateSessionStatus(id, status, meta),
      registerSessionWithHealthMonitoring: (id, session, opts) => this.registerSessionWithHealthMonitoring(id, session, opts),
      emitEvent: (event: any) => this.emitEvent(event),
      emitTypedEvent: (name: string, data: any) => this.emit(name, data),
      getProtocolFactory: () => this.protocolFactory,
      getOrCreateProtocol: async (type: string) => {
        let protocol = this.protocolCache.get(type);
        if (!protocol) {
          protocol = await this.protocolFactory.createProtocol(type);
          this.protocolCache.set(type, protocol);
        }
        return protocol;
      },
      getErrorDetector: () => this.errorDetector,
      addErrorPatterns: (patterns: any[]) => this.errorDetector.addPatterns(patterns),
      isSelfHealingEnabled: () => this.selfHealingEnabled,
      getNextSequenceNumber: (id: string) => {
        const counter = this.outputSequenceCounters.get(id) || 0;
        this.outputSequenceCounters.set(id, counter + 1);
        return counter + 1;
      },
      getLogger: () => this.logger,
      getMonitoringSystem: () => this.monitoringSystem,
    };
  }
```
5. Replace `createSerialSession` body with: `return this.serialSessionManager.createSession(sessionId, session, options);`
6. Replace `sendInputToSerial` body with: `return this.serialSessionManager.sendInput(sessionId, input);`
7. Replace serial utility methods (`discoverSerialDevices`, etc.) with delegations
8. Delete `serialProtocol` field (line 181)
9. Delete `setupSerialProtocolEventHandlers`, `handleSerialOutput`, `handleSerialLine`, `handleSerialBinaryData`, `getDefaultSerialErrorPatterns`, `cleanupSerialSession` methods
10. In `destroy()`, remove the `serialProtocol.cleanup()` block (lines ~10355-10358), add: `await this.serialSessionManager.destroy();`

### Task 2.5: Verify

```bash
npx jest tests/unit/serial-session-manager.test.ts 2>&1 | tail -20
npm run typecheck
npm run lint
npm test 2>&1 | tail -20
```

### Task 2.6: Commit

```bash
git add src/core/ProtocolSessionManagerBase.ts src/core/SerialSessionManager.ts src/core/ConsoleManager.ts tests/unit/serial-session-manager.test.ts
git commit -m "refactor: extract ProtocolSessionManagerBase + SerialSessionManager

Creates abstract base class for protocol session managers with lazy
protocol init, event handler setup, and cleanup.

Extracts SerialSessionManager (~387 lines): createSerialSession,
setupSerialProtocolEventHandlers, handleSerialOutput, sendInputToSerial,
discoverSerialDevices, etc. Eliminates serialProtocol field.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 3 — WebSocketTerminalSessionManager

**Goal**: Extract ~312 lines.

### Methods to extract:

| Method | Line Range |
|---|---|
| `setupWebSocketTerminalIntegration` | 11531-11599 |
| `handleWebSocketTerminalOutput` | 11604-11650 |
| `attemptWebSocketTerminalRecovery` | 11655-11704 |
| `createWebSocketTerminalSession` | 12717-12791 |
| `sendInputToWebSocketTerminal` | 12633-12712 |

**Fields to move**:
- `webSocketTerminalProtocol?: any` (line 184) -> `protocol: IProtocol | null`
- `webSocketTerminalSessions: Map<string, WebSocketTerminalSessionState>` (line 203)

### Task 3.1: Write failing test

**File**: `tests/unit/websocket-terminal-session-manager.test.ts`

Follow same pattern as serial test. Key tests:
- Constructor creates instance
- `createSession` stores session state and delegates to protocol
- `sendInput` delegates and handles reconnection on error
- `handleOutput` buffers output and emits events
- `destroy` cleans up sessions map and protocol

### Task 3.2: Create WebSocketTerminalSessionManager

**File**: `src/core/WebSocketTerminalSessionManager.ts`

Extends `ProtocolSessionManagerBase` with `protocolType = 'websocket-terminal'`.
- Has internal `wsSessions: Map<string, WebSocketTerminalSessionState>`
- `createSession` -- from `createWebSocketTerminalSession` (lines 12717-12791)
- `sendInput` -- from `sendInputToWebSocketTerminal` (lines 12633-12712)
- `setupEventHandlers` -- from `setupWebSocketTerminalIntegration` (lines 11531-11599)
- `handleOutput` -- from `handleWebSocketTerminalOutput` (lines 11604-11650)
- `attemptRecovery` -- from `attemptWebSocketTerminalRecovery` (lines 11655-11704)
- Override `destroy()` to clear `wsSessions` map

### Task 3.3: Wire into ConsoleManager

Same pattern as Phase 2:
1. Import, declare field, init in constructor using `buildProtocolSessionHost()`
2. Replace method bodies with delegations
3. Delete `webSocketTerminalProtocol` field, `webSocketTerminalSessions` map
4. Add to `destroy()`

### Task 3.4: Verify and commit

```bash
npx jest tests/unit/websocket-terminal-session-manager.test.ts
npm run typecheck && npm run lint && npm test
```

Commit message: `refactor: extract WebSocketTerminalSessionManager from ConsoleManager`

---

## Phase 4 — AzureSessionManager

**Goal**: Extract ~375 lines.

### Methods to extract:

| Method | Line Range |
|---|---|
| `setupAzureIntegration` | 11086-11159 |
| `createAzureCloudShellSession` | 11164-11211 |
| `createAzureBastionSession` | 11216-11266 |
| `createAzureArcSession` | 11266-11314 |
| `sendInputToAzureSession` | 11314-11332 |
| `cleanupAzureSession` | 11332-11344 |
| `createAzureSession` | 11344-11369 |
| `getAzureSessionMetrics` | 11369-11376 |
| `checkAzureSessionHealth` | 11376-11383 |
| `resizeAzureSession` | 11383-11399 |
| `getAzureMonitoringMetrics` | 11451-11458 |
| `performAzureHealthCheck` | 11458-11465 |
| `updateAzureCostEstimate` | 11465-11472 |

**Fields to move**:
- `azureProtocol?: any` (line 183) -> `protocol: IProtocol | null`

**Host extension**: `AzureSessionHost extends ProtocolSessionHost` with `getAzureMonitoring(): AzureMonitoring`

### Task 4.1-4.4: Same TDD pattern

- Test file: `tests/unit/azure-session-manager.test.ts`
- Implementation: `src/core/AzureSessionManager.ts`
- Key: `azureMonitoring` stays in CM, accessed via `host.getAzureMonitoring()`
- Wire: replace method bodies, delete field, add to destroy

Commit: `refactor: extract AzureSessionManager from ConsoleManager`

---

## Phase 5 — AWSSSMSessionManager

**Goal**: Extract ~503 lines.

### Methods to extract:

| Method | Line Range |
|---|---|
| `createAWSSSMSession` | 5786-5915 |
| `determineSSMSessionType` | 5920-5940 |
| `setupAWSSSMProtocolEventHandlers` | 5940-6035 |
| `handleSSMOutput` | 6035-6073 |
| `handleSSMSessionTermination` | 6073-6093 |
| `handleSSMSessionError` | 6093-6118 |
| `setupSSMSessionMonitoring` | 6118-6159 |
| `attemptSSMSessionRecovery` | 6159-6256 |
| `sendInputToAWSSSM` | 8837-8887 |

**Fields to move**:
- `awsSSMProtocol?: any` (line 182) -> `protocol: IProtocol | null`

**Host extension**: `AWSSSMSessionHost extends ProtocolSessionHost` with `setupSSMSessionMonitoring(sessionId, ssmSessionId)`

### Task 5.1-5.4: Same TDD pattern

- Test file: `tests/unit/aws-ssm-session-manager.test.ts`
- Implementation: `src/core/AWSSSMSessionManager.ts`

Commit: `refactor: extract AWSSSMSessionManager from ConsoleManager`

---

## Phase 6 — KubernetesSessionManager

**Goal**: Extract ~652 lines.

### Methods to extract:

| Method | Line Range |
|---|---|
| `createKubernetesSession` | 4826-4996 |
| `parseKubernetesOptions` | 5123-5167 |
| `parseKubernetesLogOptions` | 5167-5227 |
| `parsePortForwardOptions` | 5227-5264 |
| `setupKubernetesExecHandlers` | 5264-5290 |
| `setupKubernetesLogHandlers` | 5290-5318 |
| `setupKubernetesPortForwardHandlers` | 5318-5342 |
| `handleKubernetesSessionClosed` | 5342-5362 |
| `handleKubernetesLogData` | 5362-5395 |
| `handleKubernetesLogError` | 5395-5420 |
| `handleKubernetesLogEnd` | 5420-5440 |
| `handleKubernetesPortForwardStopped` | 5440-5460 |
| `sendInputToKubernetes` | 8529-8575 |

**Fields to move**:
- `kubernetesProtocol?: any` (line 180) -> `protocol: IProtocol | null`

### Task 6.1-6.4: Same TDD pattern

- Test file: `tests/unit/kubernetes-session-manager.test.ts`
- Implementation: `src/core/KubernetesSessionManager.ts`
- Key: Multiple session types (exec, logs, port-forward) need separate handler setup

Commit: `refactor: extract KubernetesSessionManager from ConsoleManager`

---

## Phase 7 — WindowsRemoteSessionManager

**Goal**: Extract ~660 lines. Most complex due to 3 sub-protocols (RDP, WinRM, VNC) and 6 Maps.

### Methods to extract:

| Method | Line Range |
|---|---|
| `setupRDPIntegration` | 11472-11531 |
| `handleRDPOutput` | 11704-11726 |
| `createRDPSession` | 11766-11825 |
| `handleWinRMOutput` | 11726-11766 |
| `createWinRMSession` | 11830-11924 |
| `createVNCSession` | 11929-12107 |
| `setupVNCEventHandlers` | 12112-12189 |
| `sendRDPInput` | 12189-12204 |
| `sendRDPClipboardData` | 12204-12223 |
| `startRDPFileTransfer` | 12223-12248 |
| `getRDPSession` | 12248-12255 |
| `getRDPCapabilities` | 12255-12262 |
| `disconnectRDPSession` | 12262-12280 |
| `sendInputToWinRM` | 8887-8964 |
| `mapAuthMethodToVNCSecurityType` | 13423-13455 |

**Fields to move**:
- `rdpProtocol?: any` (line 185) -> `protocol: IProtocol | null` (base RDP protocol)
- `rdpSessions: Map<string, RDPSession>` (line 190)
- `winrmProtocols: Map<string, any>` (line 176) -> `Map<string, IProtocol>`
- `winrmSessions: Map<string, WinRMSessionState>` (line 191)
- `vncProtocols: Map<string, any>` (line 177) -> `Map<string, IProtocol>`
- `vncSessions: Map<string, VNCSession>` (line 192)
- `vncFramebuffers: Map<string, VNCFramebuffer>` (line 193)

### Task 7.1: Write failing test

**File**: `tests/unit/windows-remote-session-manager.test.ts`

Key tests:
- RDP session creation and event handling
- WinRM per-session protocol instance creation
- VNC per-session protocol + framebuffer initialization
- `destroy()` clears all 6 Maps and cleans up all protocol instances
- RDP input, clipboard, file transfer delegation
- `mapAuthMethodToVNCSecurityType` mapping

### Task 7.2: Create WindowsRemoteSessionManager

**File**: `src/core/WindowsRemoteSessionManager.ts`

Extends `ProtocolSessionManagerBase` with `protocolType = 'rdp'`.
- Internal Maps for all 6 state collections
- `createRDPSession` uses `ensureProtocol()` (base class handles RDP protocol)
- `createWinRMSession` creates per-session protocol via `host.getOrCreateProtocol('winrm')` (NOT the base protocol)
- `createVNCSession` creates per-session protocol via `host.getOrCreateProtocol('vnc')`
- Override `destroy()` to iterate and clean up all per-session protocols, then call `super.destroy()`
- Fix `any` types: `winrmProtocols: Map<string, IProtocol>`, `vncProtocols: Map<string, IProtocol>`

### Task 7.3: Wire into ConsoleManager

1. Replace all RDP/WinRM/VNC method bodies with delegations
2. Delete all 7 fields (rdpProtocol, rdpSessions, winrmProtocols, winrmSessions, vncProtocols, vncSessions, vncFramebuffers)
3. In constructor, remove Map initializations for these 6 Maps
4. Add to `destroy()`

### Task 7.4: Verify and commit

```bash
npx jest tests/unit/windows-remote-session-manager.test.ts
npm run typecheck && npm run lint && npm test
```

Commit: `refactor: extract WindowsRemoteSessionManager from ConsoleManager`

---

## Post-Extraction Verification Checklist

After all 8 phases are complete:

### Line Count Verification
```bash
wc -l src/core/ConsoleManager.ts
# Expected: ~7,500 lines (down from 11,015)

wc -l src/core/TimeoutRecoveryManager.ts src/core/ProtocolSessionManagerBase.ts \
  src/core/SerialSessionManager.ts src/core/WebSocketTerminalSessionManager.ts \
  src/core/AzureSessionManager.ts src/core/AWSSSMSessionManager.ts \
  src/core/KubernetesSessionManager.ts src/core/WindowsRemoteSessionManager.ts
# Expected: ~3,500 lines total
```

### `any` Count Verification
```bash
grep -c 'any' src/core/ConsoleManager.ts
# Should be ~25-30 fewer than before
```

### Legacy Fields Verification
```bash
grep -n 'kubernetesProtocol\|serialProtocol\|awsSSMProtocol\|azureProtocol\|webSocketTerminalProtocol\|rdpProtocol\|dockerProtocol' src/core/ConsoleManager.ts
# Expected: zero matches (all 7 eliminated)
```

### Full Test Suite
```bash
npm test 2>&1 | tail -20
# Expected: 1,012+ existing tests + ~105 new tests, all passing

npm run typecheck
# Expected: 0 errors

npm run lint
# Expected: no new warnings
```

### Coverage Thresholds

After extraction, update `jest.config.cjs` coverage thresholds:
```javascript
coverageThreshold: {
  global: {
    branches: 8,
    functions: 20,
    lines: 16,
    statements: 16,
  },
},
```

---

## File Summary

### New Files (8)
| File | Est. Lines | Purpose |
|---|---|---|
| `src/core/ProtocolSessionManagerBase.ts` | ~90 | Abstract base class + ProtocolSessionHost interface |
| `src/core/TimeoutRecoveryManager.ts` | ~607 | Timeout recovery logic + TimeoutRecoveryHost interface |
| `src/core/SerialSessionManager.ts` | ~387 | Serial protocol session management |
| `src/core/WebSocketTerminalSessionManager.ts` | ~312 | WebSocket terminal session management |
| `src/core/AzureSessionManager.ts` | ~375 | Azure (CloudShell/Bastion/Arc) session management |
| `src/core/AWSSSMSessionManager.ts` | ~503 | AWS SSM session management |
| `src/core/KubernetesSessionManager.ts` | ~652 | Kubernetes (exec/logs/port-forward) session management |
| `src/core/WindowsRemoteSessionManager.ts` | ~660 | RDP/WinRM/VNC session management |

### New Test Files (7)
| File | Est. Tests |
|---|---|
| `tests/unit/timeout-recovery-manager.test.ts` | ~15 |
| `tests/unit/serial-session-manager.test.ts` | ~12 |
| `tests/unit/websocket-terminal-session-manager.test.ts` | ~14 |
| `tests/unit/azure-session-manager.test.ts` | ~12 |
| `tests/unit/aws-ssm-session-manager.test.ts` | ~14 |
| `tests/unit/kubernetes-session-manager.test.ts` | ~15 |
| `tests/unit/windows-remote-session-manager.test.ts` | ~18 |
| **Total** | **~100** |

### Modified Files (1)
- `src/core/ConsoleManager.ts`: reduced from ~11,015 to ~7,500 lines

### Success Criteria
1. ConsoleManager.ts <= 7,500 lines
2. All 7 legacy protocol fields eliminated
3. `dockerProtocol` field deleted
4. 8 new files created (7 managers + 1 base class)
5. ~100 new unit tests, all passing
6. Existing 1,012+ tests still passing
7. ~35-40 explicit `any` usages eliminated
8. `npm run typecheck` and `npm run lint` pass clean
