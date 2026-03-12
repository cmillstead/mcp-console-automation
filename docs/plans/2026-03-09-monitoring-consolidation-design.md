# Monitoring/Health Consolidation Design — CODE-HIGH-4

**Date**: 2026-03-09
**Status**: Approved
**Approach**: Phased extraction (Facade first, then absorb, then delete)

---

## Problem

ConsoleManager owns 14 monitoring/health/error classes across two tiers that overlap significantly:

- **Self-healing tier** (7 classes, 142+ event listeners): HealthMonitor, HeartbeatMonitor, SessionRecovery, MetricsCollector, SSHConnectionKeepAlive, NetworkMetricsManager, SessionPersistenceManager
- **Monitoring tier** (4 classes): MonitoringSystem → AlertManager, AnomalyDetector, PerformanceProfiler

The monitoring tier duplicates self-healing tier capabilities (threshold alerts, anomaly detection, system metrics). All 7 self-healing classes are private to ConsoleManager with ~820 lines of instantiation, event wiring, decision logic, and query forwarding scattered across ConsoleManager.

## Solution

### HealthOrchestrator + HealthOrchestratorHost

Following the CommandQueueManager/CommandQueueHost pattern:

- **HealthOrchestrator** owns the 7 self-healing classes, all event wiring, and decision logic (when/why to act)
- **HealthOrchestratorHost** interface implemented by ConsoleManager provides actions (how to act)

### HealthOrchestratorHost Interface

```typescript
export interface HealthOrchestratorHost {
  // Session lifecycle (for recovery/reconnection)
  getSession(sessionId: string): any;
  getSessionIds(): string[];
  stopSession(sessionId: string): Promise<void>;
  createSession(options: any): Promise<string>;

  // Resource management (for critical issue handling)
  optimizeMemoryUsage(): Promise<void>;
  throttleOperations(): Promise<void>;
  cleanupTemporaryFiles(): Promise<void>;
  optimizeNetworkConnections(): Promise<void>;

  // Event emission (HealthOrchestrator emits through ConsoleManager)
  emitEvent(event: string, data: any): void;

  // Queue access (for throttling)
  setQueueConcurrency(concurrency: number): void;

  // Output buffer access (for memory optimization)
  trimOutputBuffers(maxEntries: number): void;
}
```

### HealthOrchestrator Class

```typescript
export class HealthOrchestrator extends EventEmitter {
  // Internal components (the 7 self-healing classes)
  private healthMonitor: HealthMonitor;
  private heartbeatMonitor: HeartbeatMonitor;
  private sessionRecovery: SessionRecovery;
  private metricsCollector: MetricsCollector;
  private sshKeepAlive: SSHConnectionKeepAlive;
  private networkMetricsManager: NetworkMetricsManager;
  private sessionPersistenceManager: SessionPersistenceManager;

  private host: HealthOrchestratorHost;
  private logger: Logger;

  // Decision logic state (moved from ConsoleManager)
  private healingStats: { preventedFailures: number; ... };
  private predictiveHealingEnabled: boolean;
  private autoRecoveryEnabled: boolean;

  constructor(logger: Logger, host: HealthOrchestratorHost, config: HealthOrchestratorConfig);

  // Lifecycle
  start(): void;
  stop(): Promise<void>;

  // Session integration
  onSessionCreated(sessionId: string, sessionData: any): void;
  onSessionDestroyed(sessionId: string): void;

  // Public query API
  getHealthReport(): HealthReport;
  getMetrics(format?: string): Promise<any>;
  getRecoveryStatistics(): any;
  forceHeartbeat(sessionId: string): Promise<any>;

  // Sub-component access (needed by CommandQueueManager)
  getNetworkMetricsManager(): NetworkMetricsManager;
  getSessionPersistenceManager(): SessionPersistenceManager;
}
```

### What Gets Deleted

| Class | Lines | Reason |
|-------|-------|--------|
| MonitoringSystem | 495 | Orchestrator role replaced by HealthOrchestrator |
| AlertManager | 676 | Threshold alerting in MetricsCollector (`alertThresholdExceeded`) |
| AnomalyDetector | 643 | Trend detection in MetricsCollector (`trendPrediction`) |
| PerformanceProfiler | 754 | System metrics in HealthMonitor |
| **Total** | **2,568** | |

### What Stays Separate

- **AuditLogger** (762 lines) — unique compliance capability, no overlap
- **AzureMonitoring** (715 lines) — platform-specific concern
- **ErrorDetector, ErrorRecovery, ErrorReporting** — different pipeline, external consumers (2 protocols use ErrorRecovery)
- **DiagnosticsManager** — singleton, separate diagnostics tracking

## Phases

### Phase A: Thin Facade

- Create `src/core/HealthOrchestrator.ts` with HealthOrchestratorHost interface
- Move instantiation of 7 classes from ConsoleManager → HealthOrchestrator
- Move event wiring (`setupSelfHealingIntegration`, `setupSessionRecoveryIntegration`) → HealthOrchestrator
- ConsoleManager implements HealthOrchestratorHost, callbacks still point to ConsoleManager methods
- Move start/stop lifecycle, add onSessionCreated/onSessionDestroyed hooks
- **Verify:** existing tests pass unchanged

### Phase B: Thick Facade

- Move decision logic into HealthOrchestrator:
  - `handleCriticalSystemIssue()` → calls host methods
  - `initiateSessionRecovery()` → calls host.getSession() + sessionRecovery
  - `triggerSystemHealingMode()`, `triggerPredictiveHealing()`, `enhanceSessionMonitoring()`
  - `handleSSHConnectionFailure()`, `prepareBackupSSHConnection()`
- Move query methods: getMetrics, getHealthReport, getRecoveryStatistics, forceHeartbeat
- Move healingStats, predictiveHealingEnabled, autoRecoveryEnabled state
- Resource actions (optimizeMemoryUsage, throttleOperations, etc.) stay on ConsoleManager (host interface)
- **Verify:** unit tests for HealthOrchestrator decision logic with mocked host

### Phase C: Delete Redundant Classes

- Delete MonitoringSystem.ts, AlertManager.ts, AnomalyDetector.ts, PerformanceProfiler.ts
- Remove MonitoringSystem import/usage from ConsoleManager
- Keep AuditLogger.ts and AzureMonitoring.ts
- **Verify:** build + existing tests pass

## Impact

- ConsoleManager: **-820 lines** removed
- New HealthOrchestrator: **~900 lines**
- Deleted classes: **-2,568 lines**
- **Net: ~2,500 lines removed**
- Class count: 14 monitoring classes → 10 (7 internal to HealthOrchestrator + AuditLogger + AzureMonitoring + DiagnosticsManager)
