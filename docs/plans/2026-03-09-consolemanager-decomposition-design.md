# ConsoleManager Decomposition Design — 2026-03-09

**Finding**: CODE-CRIT-1 — ConsoleManager.ts is 13,634 lines with ~325 methods
**Approach**: Incremental extraction of self-contained concerns

## Phase A: Extract 2 loosely-coupled concerns

### 1. NetworkMetricsManager (`src/core/NetworkMetricsManager.ts`)

**Responsibility**: Network latency measurement, adaptive timeout calculation, connection health checks, metrics cleanup.

**Fields to extract**:
- `networkMetrics: Map<string, NetworkMetrics>`
- `latencyMeasurements: Map<string, number[]>`
- `adaptiveTimeoutConfig: AdaptiveTimeoutConfig`
- `networkMonitoringTimer: NodeJS.Timeout | null`

**Methods to extract** (~10):
- `measureNetworkLatency()`, `updateNetworkMetrics()`, `calculateAdaptiveTimeout()`
- `performConnectionHealthCheck()`, `testSSHResponsiveness()`
- `startNetworkPerformanceMonitoring()`, `cleanupOldNetworkMetrics()`
- `calculateAdaptiveMaxRetries()`, `calculateAdaptiveBaseDelay()`

**Interface**: ConsoleManager holds `networkMetricsManager` instance. Recovery/retry code calls `networkMetricsManager.getAdaptiveTimeout(host)`. Manager owns its monitoring timer and cleanup.

### 2. SessionPersistenceManager (`src/core/SessionPersistenceManager.ts`)

**Responsibility**: Session state persistence, bookmarks, continuity config, periodic save, restore.

**Fields to extract**:
- `sessionPersistenceData: Map<string, SessionPersistentData>`
- `sessionBookmarks: Map<string, SessionBookmark[]>`
- `continuityConfig: SessionContinuityConfig`
- `persistenceTimer: NodeJS.Timeout | null`
- `bookmarkTimers: Map<string, NodeJS.Timeout>`

**Methods to extract** (~10):
- `initializeSessionPersistence()`, `initializeSessionContinuity()`, `initializeBookmarkStrategy()`
- `createSessionBookmark()`, `restoreSessionStateFromBookmark()`
- `persistAllSessionData()`, `persistSessionData()`, `loadPersistedSessionData()`
- `restoreCommandQueueFromPersistence()`

**Interface**: ConsoleManager passes session/queue/buffer data to `persistenceManager.persistSession(sessionId, data)`. Restore calls return persisted state for ConsoleManager to apply. Manager owns its timers.

### Pattern for both managers
- Instantiated in ConsoleManager constructor
- Have `dispose()` called from ConsoleManager `destroy()`
- Receive a `Logger` instance
- Don't extend EventEmitter (synchronous delegation)

## Phase B: Extract CommandQueueManager (follow-up)

**Responsibility**: Per-session command queuing, execution tracking, completion detection, queue serialization.

**Fields**: `commandQueues`, `commandExecutions`, `sessionCommandQueue`, `outputSequenceCounters`, `promptPatterns`, `commandProcessingIntervals`, `queueConfig`

**~21 methods** — tighter coupling to SSH/output/persistence, requires careful interface design.

Deferred to after Phase A establishes the extraction pattern.
