# ConsoleManager Decomposition Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract NetworkMetricsManager and SessionPersistenceManager from the 13,634-line ConsoleManager god class.

**Architecture:** Move self-contained field groups and their methods into dedicated manager classes. ConsoleManager delegates to them. Each manager owns its own timers and cleanup.

**Tech Stack:** TypeScript, Jest

---

### Task 1: Extract NetworkMetricsManager

**Files:**
- Create: `src/core/NetworkMetricsManager.ts`
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Create NetworkMetricsManager class**

Create `src/core/NetworkMetricsManager.ts` containing:
- Move interfaces: `NetworkMetrics`, `AdaptiveTimeoutConfig`, `ConnectionHealthCheck` (lines 190-220)
- Move fields: `networkMetrics`, `latencyMeasurements`, `adaptiveTimeoutConfig`, `connectionHealthChecks`, `networkMonitoringTimer`
- Move methods: `measureNetworkLatency()` (line 2977), `updateNetworkMetrics()` (line 3022), `calculateAdaptiveTimeout()` (line 3078), `performConnectionHealthCheck()` (line 3125), `startNetworkPerformanceMonitoring()` (line 7553), `cleanupOldNetworkMetrics()` (line 7587), `calculateAdaptiveMaxRetries()` (line 7513), `calculateAdaptiveBaseDelay()` (line 7533), `getNetworkPerformanceSummary()` (line 7604)
- Add `dispose()` method that clears `networkMonitoringTimer`
- Constructor takes `Logger` instance
- Make `measureNetworkLatency`, `performConnectionHealthCheck`, `updateNetworkMetrics`, `calculateAdaptiveTimeout`, `getNetworkPerformanceSummary`, `calculateAdaptiveMaxRetries`, `calculateAdaptiveBaseDelay` public
- `testSSHResponsiveness()` stays in ConsoleManager (it takes a ClientChannel — SSH-coupled)
- Import `Client as SSHClient` from `ssh2` for `measureNetworkLatency`

**Step 2: Update ConsoleManager to delegate**

In `ConsoleManager.ts`:
- Remove moved interfaces, fields, and methods
- Add `private networkMetricsManager: NetworkMetricsManager` field
- Instantiate in constructor
- Replace all `this.networkMetrics`, `this.calculateAdaptiveTimeout(host)` etc. with `this.networkMetricsManager.*`
- In `destroy()`, call `this.networkMetricsManager.dispose()` (and remove the timer cleanup we added earlier — now owned by the manager)
- In `startNetworkPerformanceMonitoring()` call site, replace with `this.networkMetricsManager.startMonitoring(hostProvider)` where `hostProvider` is a callback that returns the current known hosts

**Step 3: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: Clean

**Step 4: Run tests**

Run: `./node_modules/.bin/jest tests/protocols/ tests/ErrorDetector.test.ts --ci --maxWorkers=2 --forceExit`
Expected: Same pass/fail as before (39 pass in ProtocolFactory+LocalProtocol, 13 pass ErrorDetector, ConsoleManager pre-existing failures)

**Step 5: Commit**

```
git add src/core/NetworkMetricsManager.ts src/core/ConsoleManager.ts
git commit -m "refactor: extract NetworkMetricsManager from ConsoleManager"
```

---

### Task 2: Extract SessionPersistenceManager

**Files:**
- Create: `src/core/SessionPersistenceManager.ts`
- Modify: `src/core/ConsoleManager.ts`

**Step 1: Create SessionPersistenceManager class**

Create `src/core/SessionPersistenceManager.ts` containing:
- Move interfaces: `SessionPersistentData`, `SerializedQueuedCommand`, `SessionBookmark`, `SessionContinuityConfig` (lines 123-178)
- Move fields: `sessionPersistenceData`, `sessionBookmarks`, `continuityConfig`, `persistenceTimer`, `bookmarkTimers`
- Move methods: `initializeSessionContinuity()` (line 785), `initializeSessionPersistence()` (line 845), `initializeBookmarkStrategy()` (line 883), `createSessionBookmark()` (line 899), `restoreSessionStateFromBookmark()` (line 2655), `restoreCommandQueueFromPersistence()` (line 2685), `attemptSSHReconnectionWithPersistence()` (line 2718), `persistAllSessionData()` (line 2788), `persistSessionData()` (line 2828), `loadPersistedSessionData()` (line 2840)
- Add `dispose()` method that clears `persistenceTimer` and all `bookmarkTimers`
- Constructor takes `Logger` instance
- Methods that read session/queue/buffer state accept data as parameters rather than reaching into ConsoleManager internals

**Step 2: Update ConsoleManager to delegate**

In `ConsoleManager.ts`:
- Remove moved interfaces, fields, and methods
- Add `private persistenceManager: SessionPersistenceManager` field
- Instantiate in constructor
- Replace all `this.sessionPersistenceData`, `this.persistAllSessionData()` etc. with `this.persistenceManager.*`
- In `destroy()`, call `this.persistenceManager.dispose()` (and remove the persistence/bookmark timer cleanup — now owned by the manager)

**Step 3: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: Clean

**Step 4: Run tests**

Run: `./node_modules/.bin/jest tests/protocols/ tests/ErrorDetector.test.ts --ci --maxWorkers=2 --forceExit`
Expected: Same pass/fail as before

**Step 5: Commit**

```
git add src/core/SessionPersistenceManager.ts src/core/ConsoleManager.ts
git commit -m "refactor: extract SessionPersistenceManager from ConsoleManager"
```
