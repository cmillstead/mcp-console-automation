# HealthOrchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract monitoring/health orchestration from ConsoleManager into HealthOrchestrator, reducing ConsoleManager by ~820 lines and deleting 4 redundant monitoring classes (~2,568 lines).

**Architecture:** HealthOrchestrator owns 7 self-healing classes (HealthMonitor, HeartbeatMonitor, SessionRecovery, MetricsCollector, SSHConnectionKeepAlive, NetworkMetricsManager, SessionPersistenceManager), all event wiring, and decision logic. ConsoleManager implements HealthOrchestratorHost callback interface for session lifecycle actions. Follows the existing CommandQueueManager/CommandQueueHost pattern.

**Tech Stack:** TypeScript, Node.js EventEmitter, Jest for testing

**Design doc:** `docs/plans/2026-03-09-monitoring-consolidation-design.md`

---

## Phase A: Thin Facade

Move instantiation and event wiring from ConsoleManager into HealthOrchestrator. Behavior stays identical — callbacks still route to ConsoleManager methods.

### Task 1: Create HealthOrchestratorHost interface and HealthOrchestrator skeleton

**Files:**
- Create: `src/core/HealthOrchestrator.ts`

**Step 1: Create file with interface and empty class**

```typescript
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { HealthMonitor } from './HealthMonitor.js';
import { HeartbeatMonitor } from './HeartbeatMonitor.js';
import { SessionRecovery } from './SessionRecovery.js';
import { MetricsCollector } from './MetricsCollector.js';
import { SSHConnectionKeepAlive } from './SSHConnectionKeepAlive.js';
import { NetworkMetricsManager } from './NetworkMetricsManager.js';
import { SessionPersistenceManager } from './SessionPersistenceManager.js';

export interface HealthOrchestratorHost {
  // Session lifecycle
  getSession(sessionId: string): any;
  getSessionIds(): string[];
  stopSession(sessionId: string): Promise<void>;
  createSession(options: any): Promise<string>;

  // Resource management
  optimizeMemoryUsage(): Promise<void>;
  throttleOperations(): Promise<void>;
  cleanupTemporaryFiles(): Promise<void>;
  optimizeNetworkConnections(): Promise<void>;

  // Event emission
  emitEvent(event: string, data: any): void;

  // Queue access
  setQueueConcurrency(concurrency: number): void;

  // Output buffer management
  trimOutputBuffers(maxEntries: number): void;

  // Session recovery action handlers
  handleSessionInterruptRequest(data: any): void;
  handlePromptResetRequest(data: any): void;
  handleSessionRefreshRequest(data: any): void;
  handleCommandRetryRequest(data: any): void;
  handleInteractiveStateUpdate(data: any): void;

  // Self-healing state queries
  isSelfHealingEnabled(): boolean;
  getKnownHosts(): string[];
}

export interface HealthOrchestratorConfig {
  selfHealingEnabled: boolean;
  predictiveHealingEnabled: boolean;
  autoRecoveryEnabled: boolean;
  healthMonitor: {
    checkInterval: number;
    thresholds: {
      cpu: number;
      memory: number;
      disk: number;
      networkLatency: number;
      processResponseTime: number;
      sshConnectionLatency: number;
      sshHealthScore: number;
    };
  };
  heartbeatMonitor: {
    interval: number;
    timeout: number;
    maxMissedBeats: number;
    enableAdaptiveInterval: boolean;
    retryAttempts: number;
    retryDelay: number;
    gracePeriod: number;
    sshHeartbeatInterval: number;
    sshTimeoutThreshold: number;
    enableSSHProactiveReconnect: boolean;
    sshFailureRiskThreshold: number;
  };
  sessionRecovery: {
    enabled: boolean;
    maxRecoveryAttempts: number;
    recoveryDelay: number;
    backoffMultiplier: number;
    maxBackoffDelay: number;
    persistenceEnabled: boolean;
    persistencePath: string;
    enableSmartRecovery: boolean;
    snapshotInterval: number;
    recoveryTimeout: number;
  };
  metricsCollector: {
    enabled: boolean;
    collectionInterval: number;
    retentionPeriod: number;
    aggregationWindow: number;
    enableRealTimeMetrics: boolean;
    enableHistoricalMetrics: boolean;
    persistenceEnabled: boolean;
    persistencePath: string;
    exportFormats: string[];
    alertThresholds: {
      errorRate: number;
      responseTime: number;
      throughput: number;
      availability: number;
    };
  };
  sshKeepAlive: {
    enabled: boolean;
    keepAliveInterval: number;
    keepAliveCountMax: number;
    serverAliveInterval: number;
    serverAliveCountMax: number;
    connectionTimeout: number;
    reconnectOnFailure: boolean;
    maxReconnectAttempts: number;
    reconnectDelay: number;
    backoffMultiplier: number;
    maxReconnectDelay: number;
    enableAdaptiveKeepAlive: boolean;
    connectionHealthThreshold: number;
  };
}

export class HealthOrchestrator extends EventEmitter {
  private healthMonitor!: HealthMonitor;
  private heartbeatMonitor!: HeartbeatMonitor;
  private sessionRecovery!: SessionRecovery;
  private metricsCollector!: MetricsCollector;
  private sshKeepAlive!: SSHConnectionKeepAlive;
  private networkMetricsManager: NetworkMetricsManager;
  private sessionPersistenceManager: SessionPersistenceManager;

  private host: HealthOrchestratorHost;
  private logger: Logger;
  private config: HealthOrchestratorConfig;

  constructor(
    logger: Logger,
    host: HealthOrchestratorHost,
    config: HealthOrchestratorConfig,
    networkMetricsManager: NetworkMetricsManager,
    sessionPersistenceManager: SessionPersistenceManager
  ) {
    super();
    this.logger = logger;
    this.host = host;
    this.config = config;
    this.networkMetricsManager = networkMetricsManager;
    this.sessionPersistenceManager = sessionPersistenceManager;
  }

  // Sub-component access (needed by CommandQueueManager)
  getNetworkMetricsManager(): NetworkMetricsManager {
    return this.networkMetricsManager;
  }

  getSessionPersistenceManager(): SessionPersistenceManager {
    return this.sessionPersistenceManager;
  }

  // Placeholder methods — filled in Task 2 and 3
  start(): void {}
  async stop(): Promise<void> {}
  onSessionCreated(sessionId: string, sessionData: any): void {}
  onSessionDestroyed(sessionId: string): void {}
}
```

**Step 2: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No new errors

**Step 3: Commit**

```bash
git add src/core/HealthOrchestrator.ts
git commit -m "feat: add HealthOrchestrator skeleton with HealthOrchestratorHost interface"
```

---

### Task 2: Move self-healing component instantiation into HealthOrchestrator

**Files:**
- Modify: `src/core/HealthOrchestrator.ts`
- Reference: `src/core/ConsoleManager.ts:1010-1115` (initializeSelfHealingComponents)

**Step 1: Add `initializeComponents()` method to HealthOrchestrator**

Move the logic from `ConsoleManager.initializeSelfHealingComponents()` (lines 1010-1115) into a private `initializeComponents()` method on HealthOrchestrator. Use `this.config` fields instead of hardcoded values. Call it from the constructor after assigning fields.

The method should:
- Create HealthMonitor with `config.healthMonitor`
- Create HeartbeatMonitor with `config.heartbeatMonitor` + `config.predictiveHealingEnabled`
- Create SessionRecovery with `config.sessionRecovery`
- Create MetricsCollector with `config.metricsCollector` + `config.predictiveHealingEnabled`
- Create SSHConnectionKeepAlive with `config.sshKeepAlive` + `config.predictiveHealingEnabled`
- Start proactive monitoring based on NODE_ENV

**Step 2: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No new errors

**Step 3: Commit**

```bash
git add src/core/HealthOrchestrator.ts
git commit -m "feat: move self-healing component instantiation into HealthOrchestrator"
```

---

### Task 3: Move event wiring into HealthOrchestrator

**Files:**
- Modify: `src/core/HealthOrchestrator.ts`
- Reference: `src/core/ConsoleManager.ts:1120-1573` (setupSelfHealingIntegration)

**Step 1: Add `setupEventWiring()` method**

Move the logic from `ConsoleManager.setupSelfHealingIntegration()` (lines 1120-1573) into a private `setupEventWiring()` method. Replace:
- `this.emit(...)` → `this.host.emitEvent(...)`
- `this.metricsCollector.*` → `this.metricsCollector.*` (stays the same, it's internal now)
- `this.initiateSessionRecovery(...)` → `this.host.emitEvent('internal:initiate-recovery', ...)` (temporary — Phase B moves this logic in)
- `this.handleCriticalSystemIssue(...)` → route through host
- `this.handleSSHConnectionFailure(...)` → route through host
- `this.triggerSystemHealingMode(...)` → route through host
- `this.triggerPredictiveHealing(...)` → route through host
- `this.enhanceSessionMonitoring(...)` → route through host
- `this.prepareBackupSSHConnection(...)` → route through host
- `this.stopSession(...)` → `this.host.stopSession(...)`
- `this.createSession(...)` → `this.host.createSession(...)`
- `this.getSession(...)` → `this.host.getSession(...)`
- Session recovery request handlers → `this.host.handleSessionInterruptRequest(...)` etc.

**Important:** For Phase A, the decision logic stays in the event handlers (same as ConsoleManager had). The callbacks just route through the host interface. In Phase B, we'll move decision logic into HealthOrchestrator proper.

Also add healing stats tracking that was in ConsoleManager:
```typescript
private healingStats = {
  totalHealingAttempts: 0,
  successfulHealingAttempts: 0,
  automaticRecoveries: 0,
  preventedFailures: 0,
  proactiveReconnections: 0,
};
```

**Step 2: Implement `start()` and `stop()` methods**

`start()` should:
- Call `initializeComponents()`
- Call `setupEventWiring()`
- Start healthMonitor, heartbeatMonitor, metricsCollector
- Start networkMetricsManager monitoring via `host.getKnownHosts()`

`stop()` should:
- Stop healthMonitor, heartbeatMonitor, metricsCollector, sshKeepAlive, sessionRecovery
- Match `ConsoleManager.shutdownSelfHealingComponents()` (lines 3368-3401)

**Step 3: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/core/HealthOrchestrator.ts
git commit -m "feat: move event wiring and lifecycle into HealthOrchestrator"
```

---

### Task 4: Wire ConsoleManager to use HealthOrchestrator

**Files:**
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Add HealthOrchestratorHost implementation**

In ConsoleManager:
1. Import HealthOrchestrator and HealthOrchestratorHost
2. Add `private healthOrchestrator: HealthOrchestrator` field
3. Implement HealthOrchestratorHost methods — most already exist on ConsoleManager, they just need to be exposed:
   - `getSession(id)` → `this.sessions.get(id)` (or existing `getSession`)
   - `getSessionIds()` → `Array.from(this.sessions.keys())`
   - `stopSession(id)` → existing `stopSession()`
   - `createSession(opts)` → existing `createSession()`
   - `optimizeMemoryUsage()` → existing private method
   - `throttleOperations()` → existing private method
   - `cleanupTemporaryFiles()` → existing private method
   - `optimizeNetworkConnections()` → existing private method
   - `emitEvent(event, data)` → `this.emit(event, data)`
   - `setQueueConcurrency(n)` → `this.queue.concurrency = n`
   - `trimOutputBuffers(max)` → iterate `this.outputBuffers`, trim
   - Session recovery handlers → existing private methods (bind to this)
   - `isSelfHealingEnabled()` → `this.selfHealingEnabled`
   - `getKnownHosts()` → existing `getKnownHosts()` method

4. In constructor, create HealthOrchestrator:
   - Pass `this` as host (ConsoleManager implements HealthOrchestratorHost)
   - Pass config built from existing hardcoded values (lines 1012-1096)
   - Pass `this.networkMetricsManager` and `this.persistenceManager`

5. Replace `this.initializeSelfHealingComponents()` + `this.setupSelfHealingIntegration()` calls with `this.healthOrchestrator.start()`

6. Replace `this.shutdownSelfHealingComponents()` with `this.healthOrchestrator.stop()`

**Step 2: Remove old code from ConsoleManager**

Delete these methods (they now live in HealthOrchestrator):
- `initializeSelfHealingComponents()` (lines 1010-1115)
- `setupSelfHealingIntegration()` (lines 1120-1573)
- `shutdownSelfHealingComponents()` (lines 3368-3401)

Keep these on ConsoleManager (host interface implementations):
- `handleCriticalSystemIssue()` → stays (Phase B moves its decision logic)
- `initiateSessionRecovery()` → stays (Phase B moves it)
- `triggerSystemHealingMode()`, `triggerPredictiveHealing()`, etc. → stay (Phase B moves them)
- `optimizeMemoryUsage()`, `throttleOperations()`, `cleanupTemporaryFiles()` → stay permanently (host actions)

Also remove the direct field declarations for the 5 self-healing classes:
- `healthMonitor`, `heartbeatMonitor`, `sessionRecovery`, `metricsCollector`, `sshKeepAlive`
- These are now owned by HealthOrchestrator

**Step 3: Update query methods to delegate**

Update these ConsoleManager methods to go through HealthOrchestrator:
- `getMetrics()` → `this.healthOrchestrator.getMetrics()`
- `exportMetrics()` → `this.healthOrchestrator.exportMetrics()`
- `performHealthCheck()` → `this.healthOrchestrator.performHealthCheck()`
- `getRecoveryHistory()` → `this.healthOrchestrator.getRecoveryHistory()`
- `getSelfHealingConfig()` → `this.healthOrchestrator.getSelfHealingConfig()`
- `setSelfHealingEnabled()` → `this.healthOrchestrator.setSelfHealingEnabled()`
- `getComprehensiveHealthCheck()` session health/connection health sections → delegate

For this to work, add these public methods to HealthOrchestrator:
- `getMetrics()`, `exportMetrics()`, `performHealthCheck()`, `getRecoveryHistory()`
- `getSelfHealingConfig()`, `setSelfHealingEnabled()`, `setPredictiveHealingEnabled()`, `setAutoRecoveryEnabled()`
- `getSessionHeartbeat(sessionId)`, `getConnectionHealth()`, `getCurrentMetrics()`
- `forceHeartbeat(sessionId)`, `getHealthStatistics()`
- `recoverSession(sessionId, reason)`

These are thin wrappers that delegate to internal components.

**Step 4: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: No new errors (may need to iterate on types)

**Step 5: Run tests**

Run: `npx jest tests/unit/ --forceExit`
Expected: Same pass/fail as before (no behavior change)

**Step 6: Run lint**

Run: `npm run lint`
Expected: 0 errors

**Step 7: Commit**

```bash
git add src/core/ConsoleManager.ts src/core/HealthOrchestrator.ts
git commit -m "refactor: wire ConsoleManager to use HealthOrchestrator facade"
```

---

### Task 5: Add HealthOrchestrator unit test

**Files:**
- Create: `tests/unit/health-orchestrator.test.ts`

**Step 1: Write test with mocked host**

```typescript
import { HealthOrchestrator, HealthOrchestratorHost, HealthOrchestratorConfig } from '../../src/core/HealthOrchestrator';
import { Logger } from '../../src/utils/logger';
import { NetworkMetricsManager } from '../../src/core/NetworkMetricsManager';
import { SessionPersistenceManager } from '../../src/core/SessionPersistenceManager';

// Create mock host
function createMockHost(): HealthOrchestratorHost {
  return {
    getSession: jest.fn().mockReturnValue(null),
    getSessionIds: jest.fn().mockReturnValue([]),
    stopSession: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue('new-session-id'),
    optimizeMemoryUsage: jest.fn().mockResolvedValue(undefined),
    throttleOperations: jest.fn().mockResolvedValue(undefined),
    cleanupTemporaryFiles: jest.fn().mockResolvedValue(undefined),
    optimizeNetworkConnections: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    setQueueConcurrency: jest.fn(),
    trimOutputBuffers: jest.fn(),
    handleSessionInterruptRequest: jest.fn(),
    handlePromptResetRequest: jest.fn(),
    handleSessionRefreshRequest: jest.fn(),
    handleCommandRetryRequest: jest.fn(),
    handleInteractiveStateUpdate: jest.fn(),
    isSelfHealingEnabled: jest.fn().mockReturnValue(true),
    getKnownHosts: jest.fn().mockReturnValue([]),
  };
}

// Create default config
function createDefaultConfig(): HealthOrchestratorConfig {
  // Use same values as ConsoleManager.initializeSelfHealingComponents()
  // (see design doc for full config)
  return { /* ... fill from ConsoleManager lines 1012-1096 */ };
}

describe('HealthOrchestrator', () => {
  let orchestrator: HealthOrchestrator;
  let host: HealthOrchestratorHost;
  let logger: Logger;

  beforeEach(() => {
    host = createMockHost();
    logger = new Logger('test');
    const networkMetrics = new NetworkMetricsManager(logger);
    const persistence = new SessionPersistenceManager(logger);
    orchestrator = new HealthOrchestrator(
      logger, host, createDefaultConfig(),
      networkMetrics, persistence
    );
  });

  afterEach(async () => {
    await orchestrator.stop();
  });

  test('can be instantiated', () => {
    expect(orchestrator).toBeDefined();
  });

  test('start() initializes and starts components', () => {
    orchestrator.start();
    // Should not throw
  });

  test('stop() shuts down cleanly', async () => {
    orchestrator.start();
    await orchestrator.stop();
    // Should not throw
  });

  test('exposes NetworkMetricsManager', () => {
    expect(orchestrator.getNetworkMetricsManager()).toBeDefined();
  });

  test('exposes SessionPersistenceManager', () => {
    expect(orchestrator.getSessionPersistenceManager()).toBeDefined();
  });

  test('getSelfHealingConfig() returns config state', () => {
    orchestrator.start();
    const config = orchestrator.getSelfHealingConfig();
    expect(config).toHaveProperty('selfHealingEnabled');
    expect(config).toHaveProperty('autoRecoveryEnabled');
    expect(config).toHaveProperty('predictiveHealingEnabled');
    expect(config).toHaveProperty('healingStats');
  });
});
```

**Step 2: Run the test**

Run: `npx jest tests/unit/health-orchestrator.test.ts --forceExit`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/unit/health-orchestrator.test.ts
git commit -m "test: add HealthOrchestrator unit tests"
```

---

## Phase B: Thick Facade

Move decision logic from ConsoleManager into HealthOrchestrator. ConsoleManager only implements host actions.

### Task 6: Move decision methods into HealthOrchestrator

**Files:**
- Modify: `src/core/HealthOrchestrator.ts`
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Move decision methods**

Move these from ConsoleManager into HealthOrchestrator as private methods:
- `handleCriticalSystemIssue()` (lines 1575-1596) — calls `this.host.optimizeMemoryUsage()` etc. instead of calling directly
- `initiateSessionRecovery()` (lines 1598-1610) — calls `this.host.getSession()` + `this.sessionRecovery.recoverSession()`
- `triggerPredictiveHealing()` (lines 1612-1619) — calls `this.host.emitEvent()`
- `triggerSystemHealingMode()` (lines 1621-1628) — calls `this.host.emitEvent()`
- `enhanceSessionMonitoring()` (lines 1630-1635)
- `handleSSHConnectionFailure()` (lines 1637-1662) — calls `this.host.emitEvent()`
- `prepareBackupSSHConnection()` (lines 1664-1671) — calls `this.host.emitEvent()`

**Step 2: Update event wiring to call local methods instead of host**

In `setupEventWiring()`, update the callbacks that were temporarily routing through host to now call the local decision methods directly. For example:
- `this.host.emitEvent('internal:initiate-recovery', ...)` → `this.initiateSessionRecovery(sessionId, reason)`
- Direct host calls for handleCriticalSystemIssue → `this.handleCriticalSystemIssue(issue)`

**Step 3: Move state**

Move these fields from ConsoleManager to HealthOrchestrator (if not already done in Task 3):
- `healingStats`
- `predictiveHealingEnabled`
- `autoRecoveryEnabled`
- `selfHealingEnabled`

**Step 4: Delete moved methods from ConsoleManager**

Remove the decision methods listed in Step 1 from ConsoleManager. Also remove:
- `setSelfHealingEnabled()` — delegate to orchestrator
- `setPredictiveHealingEnabled()` — delegate to orchestrator
- `setAutoRecoveryEnabled()` — delegate to orchestrator
- `recoverSession()` public method — delegate to orchestrator

**Step 5: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 6: Run tests**

Run: `npx jest tests/unit/ --forceExit`

**Step 7: Run lint**

Run: `npm run lint`

**Step 8: Commit**

```bash
git add src/core/HealthOrchestrator.ts src/core/ConsoleManager.ts
git commit -m "refactor: move decision logic from ConsoleManager into HealthOrchestrator"
```

---

### Task 7: Add decision logic tests

**Files:**
- Modify: `tests/unit/health-orchestrator.test.ts`

**Step 1: Add tests for decision logic**

```typescript
describe('decision logic', () => {
  test('3 missed heartbeats triggers session recovery', async () => {
    orchestrator.start();
    // Simulate heartbeatMissed event with missedCount >= 3
    // Verify host.getSession() was called
    // Verify sessionRecovery.recoverSession() was called (via internal)
  });

  test('critical issue routes to appropriate host action', async () => {
    orchestrator.start();
    // Simulate criticalIssue event with type 'high-memory-usage'
    // Verify host.optimizeMemoryUsage() was called
  });

  test('high error rate triggers system healing mode', () => {
    orchestrator.start();
    // Simulate alertThresholdExceeded with metric 'errorRate', value > 0.1
    // Verify host.emitEvent('system-healing-mode-activated', ...) was called
  });

  test('trend prediction with high confidence triggers predictive healing', () => {
    orchestrator.start();
    // Simulate trendPrediction event with confidence > 0.8
    // Verify host.emitEvent('predictive-healing-triggered', ...) was called
    // Verify healingStats.preventedFailures incremented
  });

  test('SSH keep-alive failure triggers connection failure handling', async () => {
    orchestrator.start();
    // Simulate keepAliveFailed with consecutiveFailures >= 3
    // Verify host.emitEvent('ssh-connection-failure-detected', ...) was called
  });

  test('connection degradation triggers backup preparation when predictive enabled', () => {
    // Use config with predictiveHealingEnabled: true
    orchestrator.start();
    // Simulate connectionDegraded with trend > 0.3
    // Verify host.emitEvent('backup-connection-preparing', ...) was called
  });
});
```

**Step 2: Run tests**

Run: `npx jest tests/unit/health-orchestrator.test.ts --forceExit`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/unit/health-orchestrator.test.ts
git commit -m "test: add decision logic tests for HealthOrchestrator"
```

---

## Phase C: Delete Redundant Monitoring Classes

### Task 8: Remove MonitoringSystem usage from ConsoleManager

**Files:**
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Find and remove MonitoringSystem references**

In ConsoleManager:
1. Remove import: `import { MonitoringSystem } from '../monitoring/MonitoringSystem.js';`
2. Remove field: `private monitoringSystem: MonitoringSystem;`
3. Remove instantiation: `this.monitoringSystem = new MonitoringSystem();` (line 315)
4. Remove field: `private monitoringSystems: Map<string, any>;` (line 288)
5. Search for all `this.monitoringSystem.` and `this.monitoringSystems.` calls — remove or replace with HealthOrchestrator equivalents if needed
6. Search for any MonitoringSystem event listeners — remove

**Step 2: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 3: Run tests**

Run: `npx jest tests/unit/ --forceExit`

**Step 4: Commit**

```bash
git add src/core/ConsoleManager.ts
git commit -m "refactor: remove MonitoringSystem usage from ConsoleManager"
```

---

### Task 9: Delete redundant monitoring classes

**Files:**
- Delete: `src/monitoring/MonitoringSystem.ts` (495 lines)
- Delete: `src/monitoring/AlertManager.ts` (676 lines)
- Delete: `src/monitoring/AnomalyDetector.ts` (643 lines)
- Delete: `src/monitoring/PerformanceProfiler.ts` (754 lines)

**Step 1: Verify no other imports exist**

Search for imports of these 4 files across the codebase. MonitoringSystem should have been the only external consumer (removed in Task 8). AlertManager, AnomalyDetector, PerformanceProfiler should only be imported by MonitoringSystem.

Run grep for each:
```
grep -r "AlertManager\|AnomalyDetector\|PerformanceProfiler" src/ --include="*.ts" -l
```

If any file besides MonitoringSystem.ts imports them, update that file first.

**Step 2: Delete the 4 files**

```bash
rm src/monitoring/MonitoringSystem.ts
rm src/monitoring/AlertManager.ts
rm src/monitoring/AnomalyDetector.ts
rm src/monitoring/PerformanceProfiler.ts
```

**Step 3: Check if any index/barrel exports reference them**

Look for `src/monitoring/index.ts` or similar barrel files that re-export these classes. Remove those exports.

**Step 4: Verify it compiles**

Run: `./node_modules/.bin/tsc --noEmit`

**Step 5: Run tests**

Run: `npx jest tests/unit/ --forceExit`

**Step 6: Run lint**

Run: `npm run lint`

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete 4 redundant monitoring classes (-2,568 lines)"
```

---

### Task 10: Final verification

**Step 1: Full test suite**

Run: `npx jest --forceExit`
Expected: Same pass/fail as before Phase A started (no regressions)

**Step 2: Full typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: Clean

**Step 3: Lint**

Run: `npm run lint`
Expected: 0 errors

**Step 4: Verify line count reduction**

Run: `wc -l src/core/ConsoleManager.ts src/core/HealthOrchestrator.ts`
Expected: ConsoleManager ~820 lines shorter, HealthOrchestrator ~900 lines

**Step 5: Commit any final fixes, then create PR**

---

## Summary

| Task | Phase | Description | Est. lines changed |
|------|-------|-------------|-------------------|
| 1 | A | HealthOrchestrator skeleton + interface | +150 |
| 2 | A | Move component instantiation | +100 |
| 3 | A | Move event wiring + lifecycle | +500 |
| 4 | A | Wire ConsoleManager to use it | -600 |
| 5 | A | Unit tests | +100 |
| 6 | B | Move decision logic | +200, -200 |
| 7 | B | Decision logic tests | +80 |
| 8 | C | Remove MonitoringSystem usage | -30 |
| 9 | C | Delete 4 monitoring classes | -2,568 |
| 10 | — | Final verification | 0 |
