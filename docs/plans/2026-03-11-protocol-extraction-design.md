# Protocol Extraction + Cleanup Design Document

**Date**: 2026-03-11
**Status**: Design Complete
**Target**: Reduce `src/core/ConsoleManager.ts` from ~11,015 lines by extracting 7 protocol session managers + 1 cross-cutting manager

---

## 1. Executive Summary

Extract 7 protocol-specific session managers and 1 TimeoutRecoveryManager from ConsoleManager.ts, eliminating all 7 legacy protocol fields and their associated session Maps. Each manager follows the established Host callback pattern (as used by CommandQueueManager, HealthOrchestrator). Expected line reduction: ~3,500 lines.

---

## 2. Architecture Overview

### 2.1 Extraction Inventory

| Manager | Est. Lines | Legacy Fields Eliminated | Session Maps Moved |
|---|---|---|---|
| KubernetesSessionManager | ~652 | `kubernetesProtocol` | (none — uses `sessions` via Host) |
| SerialSessionManager | ~387 | `serialProtocol` | (none — uses `sessions` via Host) |
| AWSSSMSessionManager | ~503 | `awsSSMProtocol` | (none — uses `sessions` via Host) |
| WindowsRemoteSessionManager | ~660 | `rdpProtocol` | `rdpSessions`, `winrmProtocols`, `winrmSessions`, `vncProtocols`, `vncSessions`, `vncFramebuffers` |
| AzureSessionManager | ~375 | `azureProtocol` | (none — `azureMonitoring` stays in CM) |
| WebSocketTerminalSessionManager | ~312 | `webSocketTerminalProtocol` | `webSocketTerminalSessions` |
| TimeoutRecoveryManager | ~607 | (none — cross-cutting) | `timeoutRecoveryAttempts`, `recoveryMetrics` |
| **dockerProtocol deletion** | -2 refs | `dockerProtocol` field | (none) |
| **Total** | **~3,496** | **7 legacy fields** | **8 Maps moved** |

### 2.2 Dependency Graph

```
ConsoleManager
  |
  |-- HealthOrchestrator (existing)
  |-- CommandQueueManager (existing)
  |-- NetworkMetricsManager (existing)
  |-- SessionPersistenceManager (existing)
  |
  |-- TimeoutRecoveryManager (NEW - cross-cutting)
  |     depends on: sshClients/sshChannels (via Host), RetryManager,
  |                 ErrorRecovery, SessionRecovery (via HealthOrchestrator),
  |                 persistenceManager, networkMetricsManager
  |
  |-- KubernetesSessionManager (NEW)
  |-- SerialSessionManager (NEW)
  |-- AWSSSMSessionManager (NEW)
  |-- WindowsRemoteSessionManager (NEW)
  |-- AzureSessionManager (NEW)
  |-- WebSocketTerminalSessionManager (NEW)
       All 6 protocol managers depend on:
         ProtocolFactory, Logger, and their *Host callback interface
```

No new manager depends on another new manager. All inter-manager communication goes through ConsoleManager as the Host.

### 2.3 Initialization Order (in ConsoleManager constructor)

```
1. Logger, ErrorRecovery, RetryManager          (already exist, no change)
2. NetworkMetricsManager                         (already exists)
3. SessionPersistenceManager                     (already exists)
4. HealthOrchestrator                            (already exists)
5. CommandQueueManager                           (already exists)
6. TimeoutRecoveryManager                        (NEW - needs ErrorRecovery, RetryManager,
                                                  SessionRecovery via HealthOrchestrator)
7. Protocol session managers                     (NEW - lazy init on first use, no constructor work)
8. ProtocolFactory, AzureMonitoring              (already exist)
```

Protocol session managers are created eagerly in the constructor but do NOT initialize their protocol instances eagerly. Protocol instances are created lazily on first `createSession()` call (matching the existing pattern where `this.kubernetesProtocol` is initialized only when `createKubernetesSession` is first called).

---

## 3. Host Interface Design

### 3.1 Design Principle: Interface Segregation

Each manager gets its own `*Host` interface. ConsoleManager implements all of them. This is consistent with the existing pattern where ConsoleManager `implements CommandQueueHost` explicitly and duck-types HealthOrchestratorHost via `buildHealthOrchestratorHost()`.

**Recommendation**: Use the `buildXxxHost()` pattern (like `buildHealthOrchestratorHost()`) rather than adding more `implements` clauses to the class declaration. This keeps the class signature manageable and allows selective exposure of ConsoleManager internals.

### 3.2 Common Protocol Session Host Interface

All 6 protocol session managers share a common set of Host callbacks. Define a base interface:

```typescript
export interface ProtocolSessionHost {
  // Session state access
  getSession(sessionId: string): ConsoleSession | undefined;
  setSession(sessionId: string, session: ConsoleSession): void;
  deleteSession(sessionId: string): void;

  // Output buffer management
  getOutputBuffer(sessionId: string): ConsoleOutput[];
  setOutputBuffer(sessionId: string, buffer: ConsoleOutput[]): void;
  getMaxBufferSize(): number;

  // Stream management
  createStreamManager(sessionId: string, options: StreamManagerOptions): void;
  deleteStreamManager(sessionId: string): void;

  // Session manager integration
  updateSessionStatus(sessionId: string, status: string, metadata?: Record<string, unknown>): Promise<void>;
  registerSessionWithHealthMonitoring(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<void>;

  // Event emission
  emitEvent(event: ConsoleEvent): void;
  emitTypedEvent(eventName: string, data: Record<string, unknown>): void;

  // Protocol factory access
  getProtocolFactory(): ProtocolFactory;
  getOrCreateProtocol(type: ConsoleType): Promise<IProtocol>;

  // Error detection
  getErrorDetector(): ErrorDetector;
  addErrorPatterns(patterns: ExtendedErrorPattern[]): void;

  // Self-healing
  isSelfHealingEnabled(): boolean;

  // Command queue integration
  getNextSequenceNumber(sessionId: string): number;

  // Logger access
  getLogger(): Logger;
}
```

### 3.3 Per-Manager Host Extensions

Each manager extends ProtocolSessionHost with its specific needs:

```typescript
// KubernetesSessionManager — no extra Host methods needed
export type KubernetesSessionHost = ProtocolSessionHost;

// SerialSessionManager — no extra Host methods needed
export type SerialSessionHost = ProtocolSessionHost;

// AWSSSMSessionManager — needs SSM monitoring setup
export interface AWSSSMSessionHost extends ProtocolSessionHost {
  setupSSMSessionMonitoring(sessionId: string, ssmSessionId: string): void;
}

// AzureSessionManager — needs AzureMonitoring access
export interface AzureSessionHost extends ProtocolSessionHost {
  getAzureMonitoring(): AzureMonitoring;
}

// WindowsRemoteSessionManager — no extra beyond base
export type WindowsRemoteSessionHost = ProtocolSessionHost;

// WebSocketTerminalSessionManager — needs SessionManager activity tracking
export interface WebSocketTerminalSessionHost extends ProtocolSessionHost {
  updateSessionActivity(sessionId: string, activity: Record<string, unknown>): Promise<void>;
}
```

### 3.4 TimeoutRecoveryManager Host Interface

This is a cross-cutting concern, not a protocol session manager. It needs deeper access:

```typescript
export interface TimeoutRecoveryHost {
  // SSH connection access
  getSSHClient(sessionId: string): SSHClient | undefined;
  getSSHChannel(sessionId: string): ClientChannel | undefined;

  // Recovery actions
  attemptSSHReconnection(sessionId: string): Promise<TimeoutRecoveryResult>;
  sendInput(sessionId: string, input: string): Promise<void>;

  // State access
  getSession(sessionId: string): ConsoleSession | undefined;
  getOutputBuffer(sessionId: string): ConsoleOutput[];
  setOutputBuffer(sessionId: string, buffer: ConsoleOutput[]): void;

  // Session recovery (from HealthOrchestrator)
  getSessionRecovery(): SessionRecovery;

  // Persistence
  getPersistenceManager(): SessionPersistenceManager;

  // Event emission
  emitEvent(event: ConsoleEvent): void;

  // Command queue
  clearQueueOutputBuffer(sessionId: string): void;

  // Self-healing
  isSelfHealingEnabled(): boolean;

  // Delay utility
  delay(ms: number): Promise<void>;
}
```

---

## 4. Data Ownership

### 4.1 State That Moves to New Managers

| From ConsoleManager | To Manager | Type |
|---|---|---|
| `kubernetesProtocol?: any` | KubernetesSessionManager.`protocol` | `IProtocol \| null` |
| `serialProtocol?: any` | SerialSessionManager.`protocol` | `IProtocol \| null` |
| `awsSSMProtocol?: any` | AWSSSMSessionManager.`protocol` | `IProtocol \| null` |
| `rdpProtocol?: any` | WindowsRemoteSessionManager.`rdpProtocol` | `IProtocol \| null` |
| `webSocketTerminalProtocol?: any` | WebSocketTerminalSessionManager.`protocol` | `IProtocol \| null` |
| `azureProtocol?: any` | AzureSessionManager.`protocol` | `IProtocol \| null` |
| `rdpSessions` | WindowsRemoteSessionManager.`rdpSessions` | `Map<string, RDPSession>` |
| `winrmProtocols` | WindowsRemoteSessionManager.`winrmProtocols` | `Map<string, IProtocol>` |
| `winrmSessions` | WindowsRemoteSessionManager.`winrmSessions` | `Map<string, WinRMSessionState>` |
| `vncProtocols` | WindowsRemoteSessionManager.`vncProtocols` | `Map<string, IProtocol>` |
| `vncSessions` | WindowsRemoteSessionManager.`vncSessions` | `Map<string, VNCSession>` |
| `vncFramebuffers` | WindowsRemoteSessionManager.`vncFramebuffers` | `Map<string, VNCFramebuffer>` |
| `webSocketTerminalSessions` | WebSocketTerminalSessionManager.`sessions` | `Map<string, WebSocketTerminalSessionState>` |
| `timeoutRecoveryAttempts` | TimeoutRecoveryManager.`recoveryAttempts` | `Map<string, number>` |
| `recoveryMetrics` | TimeoutRecoveryManager.`metrics` | (structured object) |
| `TIMEOUT_ERROR_PATTERNS` | TimeoutRecoveryManager (static) | (static readonly) |

### 4.2 State That Stays in ConsoleManager

- `sessions: Map<string, ConsoleSession>` — shared by all managers via Host
- `outputBuffers: Map<string, ConsoleOutput[]>` — shared via Host
- `streamManagers: Map<string, StreamManager>` — shared via Host
- `sshClients`, `sshChannels`, `sshConnectionPool` — accessed by TimeoutRecoveryManager via Host
- `protocolFactory`, `protocolInstances`, `protocolSessions`, `protocolSessionIdMap` — accessed by protocol managers via Host
- `protocolCache` — stays, exposed via `getOrCreateProtocol()` Host method
- `ipmiProtocols`, `ipmiSessions`, `ipmiMonitoringIntervals` — NOT extracted (IPMI uses per-session protocol instances, different pattern)
- `ipcProtocols`, `ipcSessions` — NOT extracted (IPC uses per-session protocol instances)
- `dockerProtocol` — DELETE (only 2 refs: constructor init at line 361-422 + destroy cleanup at line 7795)

### 4.3 Delete dockerProtocol

The `dockerProtocol` field is dead:
- Initialized in constructor (line 361) but Docker sessions use the unified `createSessionInternal()` path via `protocolFactory.createProtocol('docker')` (line 3288-3294)
- Only other ref is destroy cleanup (line 7795)
- Action: Delete the field, the constructor initialization (lines 361-422), and the destroy entry

---

## 5. Method Signatures and `any` Reduction

### 5.1 Protocol Session Manager Base Pattern

```typescript
export abstract class ProtocolSessionManagerBase {
  protected protocol: IProtocol | null = null;
  protected host: ProtocolSessionHost;
  protected logger: Logger;
  protected protocolType: ConsoleType;

  constructor(host: ProtocolSessionHost, logger: Logger, protocolType: ConsoleType) {
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
    if (this.protocol && typeof this.protocol.cleanup === 'function') {
      try {
        await this.protocol.cleanup();
      } catch (e) {
        this.logger.warn(`Error cleaning up ${this.protocolType} protocol:`,
          e instanceof Error ? e.message : String(e));
      }
    }
    this.protocol = null;
  }
}
```

**Decision**: Use an abstract base class rather than just an interface, because all 6 protocol session managers share: lazy protocol init, event handler setup, and destroy/cleanup logic. This avoids ~50 lines of duplicated boilerplate per manager.

### 5.2 Concrete Manager Signatures

#### KubernetesSessionManager

```typescript
export class KubernetesSessionManager extends ProtocolSessionManagerBase {
  constructor(host: KubernetesSessionHost, logger: Logger);

  async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string>;
  private parseKubernetesOptions(options: SessionOptions): KubernetesExecOptions;
  private parseKubernetesLogOptions(options: SessionOptions): KubernetesLogOptions;
  private parsePortForwardOptions(options: SessionOptions): PortForwardOptions;
  private setupKubernetesExecHandlers(sessionId: string): void;
  private setupKubernetesLogHandlers(sessionId: string): void;
  private setupKubernetesPortForwardHandlers(sessionId: string): void;
  private handleKubernetesOutput(output: ConsoleOutput): void;
  private handleKubernetesError(sessionId: string, error: Error): void;
  private handleKubernetesLogStreamEnded(sessionId: string): void;
  private handleKubernetesPortForwardStopped(sessionId: string): void;
  protected setupEventHandlers(): void;
  async destroy(): Promise<void>;
}
```

#### SerialSessionManager

```typescript
export class SerialSessionManager extends ProtocolSessionManagerBase {
  constructor(host: SerialSessionHost, logger: Logger);

  async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string>;
  private handleSerialOutput(output: ConsoleOutput): void;
  private handleSerialLine(output: ConsoleOutput): void;
  private handleSerialBinaryData(output: ConsoleOutput): void;
  private getDefaultSerialErrorPatterns(): ExtendedErrorPattern[];
  async cleanupSession(sessionId: string): Promise<void>;
  protected setupEventHandlers(): void;
  async destroy(): Promise<void>;
}
```

#### AWSSSMSessionManager

```typescript
export class AWSSSMSessionManager extends ProtocolSessionManagerBase {
  constructor(host: AWSSSMSessionHost, logger: Logger);

  async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string>;
  private determineSSMSessionType(options: SessionOptions): 'interactive' | 'port-forwarding' | 'command';
  private handleSSMOutput(output: ConsoleOutput): void;
  private handleSSMSessionTermination(sessionId: string): void;
  private handleSSMSessionError(sessionId: string, error: Error): void;
  protected setupEventHandlers(): void;
  async destroy(): Promise<void>;
}
```

#### WindowsRemoteSessionManager

```typescript
export class WindowsRemoteSessionManager extends ProtocolSessionManagerBase {
  private rdpSessions: Map<string, RDPSession> = new Map();
  private winrmProtocols: Map<string, IProtocol> = new Map();
  private winrmSessions: Map<string, WinRMSessionState> = new Map();
  private vncProtocols: Map<string, IProtocol> = new Map();
  private vncSessions: Map<string, VNCSession> = new Map();
  private vncFramebuffers: Map<string, VNCFramebuffer> = new Map();

  constructor(host: WindowsRemoteSessionHost, logger: Logger);

  // RDP
  async createRDPSession(sessionId: string, options: SessionOptions): Promise<string>;
  private setupRDPIntegration(): void;
  private handleRDPOutput(output: ConsoleOutput): void;

  // WinRM
  async createWinRMSession(sessionId: string, options: SessionOptions): Promise<string>;
  private handleWinRMOutput(sessionId: string, output: ConsoleOutput): void;

  // VNC
  async createVNCSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string>;
  private setupVNCEventHandlers(sessionId: string, vncProtocol: IProtocol): void;
  private mapAuthMethodToVNCSecurityType(method?: string): VNCSecurityType;

  // Lifecycle
  protected setupEventHandlers(): void;  // Sets up RDP event handlers (the "main" protocol)
  async destroy(): Promise<void>;  // Clears all 6 Maps + cleans up all protocol instances
}
```

Note: WindowsRemoteSessionManager overrides `protocolType` to `'rdp'` but also creates WinRM and VNC protocols independently. The base class `ensureProtocol()` handles RDP; WinRM and VNC are per-session instances created via `host.getOrCreateProtocol()`.

#### AzureSessionManager

```typescript
export class AzureSessionManager extends ProtocolSessionManagerBase {
  constructor(host: AzureSessionHost, logger: Logger);

  async createCloudShellSession(sessionId: string, options: SessionOptions): Promise<string>;
  async createBastionSession(sessionId: string, options: SessionOptions): Promise<string>;
  async createArcSession(sessionId: string, options: SessionOptions): Promise<string>;
  async performHealthCheck(): Promise<unknown>;
  updateCostEstimate(sessionId: string, costEstimate: number): void;
  protected setupEventHandlers(): void;  // setupAzureIntegration
  async destroy(): Promise<void>;
}
```

#### WebSocketTerminalSessionManager

```typescript
export class WebSocketTerminalSessionManager extends ProtocolSessionManagerBase {
  private wsSessions: Map<string, WebSocketTerminalSessionState> = new Map();

  constructor(host: WebSocketTerminalSessionHost, logger: Logger);

  async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string>;
  async sendInput(sessionId: string, input: string): Promise<void>;
  private handleOutput(sessionId: string, data: string | Buffer): void;
  private async attemptRecovery(sessionId: string, error: Error): Promise<void>;
  protected setupEventHandlers(): void;
  async destroy(): Promise<void>;
}
```

#### TimeoutRecoveryManager (not a ProtocolSessionManagerBase)

```typescript
export class TimeoutRecoveryManager {
  private recoveryAttempts: Map<string, number> = new Map();
  private readonly maxRecoveryAttempts = 3;
  private metrics: RecoveryMetrics;
  private host: TimeoutRecoveryHost;
  private logger: Logger;
  private errorRecovery: ErrorRecovery;
  private retryManager: RetryManager;

  private static readonly TIMEOUT_ERROR_PATTERNS = { ... };

  constructor(
    host: TimeoutRecoveryHost,
    logger: Logger,
    errorRecovery: ErrorRecovery,
    retryManager: RetryManager
  );

  async attemptTimeoutRecovery(sessionId: string, command: QueuedCommand): Promise<TimeoutRecoveryResult>;
  private classifyTimeoutError(error: Error): TimeoutClassification;
  private determineTimeoutSeverity(category: string, errorMsg: string): { severity: string; recoverable: boolean };
  private recordRecoveryAttempt(sessionId: string, category: string, success: boolean, durationMs: number, error?: string): void;
  private async testSSHResponsiveness(sessionId: string, channel: ClientChannel): Promise<{ responsive: boolean; details: string }>;
  private async validateSessionRecovery(sessionId: string, channel: ClientChannel): Promise<{ valid: boolean; error?: string }>;
  private async clearStaleOutput(sessionId: string): Promise<void>;
  getTimeoutRecoveryMetrics(): RecoveryMetricsReport;
  private logRecoveryMetrics(): void;
  private async createSessionBookmark(sessionId: string, reason: string): Promise<void>;

  dispose(): void;  // Clear maps
}
```

### 5.3 `any` Reduction Strategy

| Current `any` | Replacement | Location |
|---|---|---|
| `kubernetesProtocol?: any` | `IProtocol \| null` inside KubernetesSessionManager | Field type |
| `serialProtocol?: any` | `IProtocol \| null` inside SerialSessionManager | Field type |
| `awsSSMProtocol?: any` | `IProtocol \| null` inside AWSSSMSessionManager | Field type |
| `azureProtocol?: any` | `IProtocol \| null` inside AzureSessionManager | Field type |
| `webSocketTerminalProtocol?: any` | `IProtocol \| null` inside WebSocketTerminalSessionManager | Field type |
| `rdpProtocol?: any` | `IProtocol \| null` inside WindowsRemoteSessionManager | Field type |
| `winrmProtocols: Map<string, any>` | `Map<string, IProtocol>` | WindowsRemoteSessionManager |
| `vncProtocols: Map<string, any>` | `Map<string, IProtocol>` | WindowsRemoteSessionManager |
| `sftpProtocols: Map<string, any>` | `Map<string, IProtocol>` (stays in CM but fix type) | ConsoleManager |
| Host interface `getSession(): any` | `ConsoleSession \| undefined` | All Host interfaces |
| Host `emitEvent(event: any)` | `ConsoleEvent` | All Host interfaces |
| Host `createSession(options: any)` | `SessionOptions` | HealthOrchestratorHost |
| `(connectedSession as any).connectionId` | Define `ProtocolSessionResult` interface | VNC session creation |

**Expected reduction**: ~25-30 explicit `any` removed from ConsoleManager (moved to properly typed manager fields), plus ~10 more from Host interface improvements. Total: ~35-40 `any` eliminated.

---

## 6. Error Handling Pattern

### 6.1 Consistent Error Wrapping

All protocol session managers follow this pattern:

```typescript
async createSession(sessionId: string, session: ConsoleSession, options: SessionOptions): Promise<string> {
  try {
    const protocol = await this.ensureProtocol();
    // ... session creation logic ...
    return sessionId;
  } catch (error) {
    this.logger.error(`${this.protocolType} session creation failed for ${sessionId}:`, error);
    // Clean up partial state
    await this.cleanupFailedSession(sessionId);
    throw error;  // Re-throw — ConsoleManager handles status update + error recovery
  }
}
```

**Key principle**: Managers clean up their own internal state on failure, then re-throw. ConsoleManager's `createSessionInternal()` already handles session status updates and error recovery for all protocol types.

### 6.2 Error Propagation Flow

```
Protocol instance error
  -> Manager catches, logs, cleans up internal state
  -> Re-throws to ConsoleManager
  -> ConsoleManager updates session status to 'crashed'
  -> ConsoleManager invokes handleSessionError() for recovery
  -> If recovery fails, error propagates to MCP server caller
```

### 6.3 Event Handler Errors

Protocol event handler errors (data, disconnection, etc.) are caught within the manager and logged. They do NOT propagate — they emit error events via Host instead:

```typescript
this.protocol.on('error', (sessionId: string, error: Error) => {
  this.logger.error(`${this.protocolType} session error: ${sessionId}`, error);
  this.host.emitTypedEvent(`${this.protocolType}-error`, { sessionId, error });
});
```

---

## 7. ConsoleManager Integration Points

### 7.1 Routing in createSessionInternal()

After extraction, `createSessionInternal()` delegates to protocol session managers based on detected protocol type. The existing switch/if-chain (currently calling `createKubernetesSession()`, `createSerialSession()`, etc.) changes to delegate to the appropriate manager:

```typescript
// In createSessionInternal(), after protocol detection:
switch (protocolType) {
  case 'kubectl':
  case 'k8s-logs':
  case 'k8s-port-forward':
    return await this.kubernetesSessionManager.createSession(sessionId, session, resolvedOptions);
  case 'serial':
  case 'com':
  case 'uart':
    return await this.serialSessionManager.createSession(sessionId, session, resolvedOptions);
  case 'aws-ssm':
  case 'ssm-session':
  case 'ssm-tunnel':
    return await this.awsSSMSessionManager.createSession(sessionId, session, resolvedOptions);
  case 'rdp':
    return await this.windowsRemoteSessionManager.createRDPSession(sessionId, resolvedOptions);
  case 'winrm':
    return await this.windowsRemoteSessionManager.createWinRMSession(sessionId, resolvedOptions);
  case 'vnc':
    return await this.windowsRemoteSessionManager.createVNCSession(sessionId, session, resolvedOptions);
  case 'azure-shell':
  case 'azure-bastion':
  case 'azure-arc':
    return await this.azureSessionManager.createCloudShellSession(sessionId, resolvedOptions);
    // (or createBastionSession/createArcSession based on sub-type)
  case 'websocket-term':
    return await this.webSocketTerminalSessionManager.createSession(sessionId, session, resolvedOptions);
  // ... existing paths for ssh, docker, local, etc. remain in ConsoleManager
}
```

### 7.2 Routing in sendInput()

`sendInputToWebSocketTerminal()` is currently called from the main `sendInput()` method. After extraction:

```typescript
// In sendInput():
if (session.type === 'websocket-term') {
  return await this.webSocketTerminalSessionManager.sendInput(sessionId, input);
}
```

### 7.3 Routing in destroy()

ConsoleManager's `destroy()` method delegates cleanup to each manager:

```typescript
// In destroy():
await this.kubernetesSessionManager.destroy();
await this.serialSessionManager.destroy();
await this.awsSSMSessionManager.destroy();
await this.windowsRemoteSessionManager.destroy();
await this.azureSessionManager.destroy();
await this.webSocketTerminalSessionManager.destroy();
this.timeoutRecoveryManager.dispose();
```

### 7.4 TimeoutRecoveryManager Integration

ConsoleManager currently implements `CommandQueueHost.attemptTimeoutRecovery()`. After extraction, it delegates:

```typescript
// ConsoleManager method (still implements CommandQueueHost):
async attemptTimeoutRecovery(sessionId: string, command: QueuedCommand): Promise<TimeoutRecoveryResult> {
  return this.timeoutRecoveryManager.attemptTimeoutRecovery(sessionId, command);
}
```

---

## 8. Testing Strategy

### 8.1 Existing Test Impact

| Test File | Impact | Action |
|---|---|---|
| `tests/protocols/ConsoleManager.test.ts` | LOW | Add mocks for new managers; existing public API unchanged |
| `tests/unit/health-orchestrator.test.ts` | NONE | No changes needed |
| `tests/unit/protocol-conformance.test.ts` | NONE | Tests protocol classes, not session managers |
| `tests/unit/*-conformance.test.ts` | NONE | Tests protocol classes, not session managers |
| `tests/integration/protocols/*.test.ts` | NONE | Tests protocol classes directly, require real infra |

### 8.2 New Unit Tests Required

Each new manager needs its own test file following the `health-orchestrator.test.ts` pattern:

| Test File | Tests | Key Scenarios |
|---|---|---|
| `tests/unit/kubernetes-session-manager.test.ts` | ~15 | Create exec/logs/port-forward sessions, parse options, event handler setup, cleanup, error propagation |
| `tests/unit/serial-session-manager.test.ts` | ~12 | Create session, device discovery fallback, binary data handling, error patterns, cleanup |
| `tests/unit/aws-ssm-session-manager.test.ts` | ~14 | Create interactive/port-forwarding/command sessions, SSM type determination, event handlers, monitoring |
| `tests/unit/windows-remote-session-manager.test.ts` | ~18 | Create RDP/WinRM/VNC sessions, per-session protocol instances, output handling, VNC framebuffer init, cleanup |
| `tests/unit/azure-session-manager.test.ts` | ~12 | Create CloudShell/Bastion/Arc sessions, monitoring integration, health check, cost estimates |
| `tests/unit/websocket-terminal-session-manager.test.ts` | ~14 | Create session, send input, output handling, reconnection recovery, error handling |
| `tests/unit/timeout-recovery-manager.test.ts` | ~20 | Timeout classification (all 6 categories), recovery attempts (success/failure), max attempts exceeded, SSH responsiveness test, metrics tracking, circuit breaker integration, session bookmark creation |
| **Total** | **~105** | |

### 8.3 Mock Pattern (standardized)

```typescript
// Standard mock host factory — example for KubernetesSessionManager
function createMockHost(): KubernetesSessionHost {
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
    getProtocolFactory: jest.fn().mockReturnValue(mockProtocolFactory),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue(mockErrorDetector),
    addErrorPatterns: jest.fn(),
    isSelfHealingEnabled: jest.fn().mockReturnValue(true),
    getNextSequenceNumber: jest.fn().mockReturnValue(1),
    getLogger: jest.fn().mockReturnValue(mockLogger),
  };
}

// Standard mock protocol factory
function createMockProtocol(): jest.Mocked<IProtocol> {
  return {
    createSession: jest.fn().mockResolvedValue({ id: 'mock-session' }),
    cleanup: jest.fn().mockResolvedValue(undefined),
    on: jest.fn().mockReturnThis(),
    removeAllListeners: jest.fn(),
    // ... other IProtocol methods
  } as any;
}
```

### 8.4 Protocol Mock Strategy

Protocol instances require external dependencies (AWS SDK, kubectl, serial ports). Tests mock at the `IProtocol` interface level via `host.getOrCreateProtocol()`, never instantiating real protocol classes.

### 8.5 Coverage Targets

- New manager files: 80% line coverage, 70% branch coverage
- Overall project thresholds: Raise after extraction (currently branches 7%, funcs 18%, lines 14%, stmts 14%)
- Recommended post-extraction thresholds: branches 8%, funcs 20%, lines 16%, stmts 16%

### 8.6 Regression Verification

1. All 1,012 existing tests must pass (no regressions)
2. Run `npm run typecheck` — zero errors
3. Run `npm run lint` — no new warnings
4. ConsoleManager.test.ts must still pass with mock updates for new managers
5. Integration tests (when Docker is available) must still pass

### 8.7 Key Edge Cases to Test

- **Protocol lazy init failure**: `getOrCreateProtocol()` throws — manager should propagate error, not leave partial state
- **Session creation race conditions**: Two concurrent `createSession()` calls for same sessionId
- **Cleanup during active sessions**: `destroy()` called while sessions are running
- **Event handler after destroy**: Protocol emits event after manager's `destroy()` is called
- **Recovery exhaustion**: TimeoutRecoveryManager reaches max attempts, then interactive recovery also fails
- **Circuit breaker open**: Recovery attempted while circuit breaker is open
- **WinRM/VNC per-session cleanup**: Ensure all per-session protocol instances are cleaned up on session close, not just on manager destroy

---

## 9. Extraction Order (Implementation Sequence)

Execute extractions in this order, validating tests after each:

| Phase | Manager | Rationale |
|---|---|---|
| 0 | Delete `dockerProtocol` field | Trivial, removes dead code, validates nothing breaks |
| 1 | TimeoutRecoveryManager | Cross-cutting, no protocol dependency, clears ~607 lines and simplifies ConsoleManager |
| 2 | SerialSessionManager | Smallest protocol manager (~387 lines), good pattern validation |
| 3 | WebSocketTerminalSessionManager | Small (~312 lines), has recovery logic that validates error handling pattern |
| 4 | AzureSessionManager | Medium (~375 lines), validates AzureMonitoring integration pattern |
| 5 | AWSSSMSessionManager | Medium (~503 lines), validates monitoring setup Host callback |
| 6 | KubernetesSessionManager | Large (~652 lines), multiple session types (exec/logs/port-forward) |
| 7 | WindowsRemoteSessionManager | Largest (~660 lines), most complex (3 sub-protocols, 6 Maps) |

Each phase: extract -> write tests -> run full suite -> commit.

---

## 10. File Layout

```
src/core/
  ConsoleManager.ts           (reduced by ~3,500 lines)
  CommandQueueManager.ts      (existing)
  HealthOrchestrator.ts       (existing)
  NetworkMetricsManager.ts    (existing)
  SessionPersistenceManager.ts (existing)
  TimeoutRecoveryManager.ts   (NEW)
  ProtocolSessionManagerBase.ts (NEW - abstract base class)
  KubernetesSessionManager.ts (NEW)
  SerialSessionManager.ts     (NEW)
  AWSSSMSessionManager.ts     (NEW)
  WindowsRemoteSessionManager.ts (NEW)
  AzureSessionManager.ts      (NEW)
  WebSocketTerminalSessionManager.ts (NEW)

tests/unit/
  timeout-recovery-manager.test.ts (NEW)
  kubernetes-session-manager.test.ts (NEW)
  serial-session-manager.test.ts (NEW)
  aws-ssm-session-manager.test.ts (NEW)
  windows-remote-session-manager.test.ts (NEW)
  azure-session-manager.test.ts (NEW)
  websocket-terminal-session-manager.test.ts (NEW)
```

---

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Subtle behavior change from method extraction | Each extraction is a pure move; no logic changes. Test before/after. |
| Host interface too large / too many callbacks | ProtocolSessionHost base covers 90% of needs; extensions are minimal |
| Breaking existing ConsoleManager.test.ts | Mocks for new managers auto-created by jest.mock(); minimal manual updates |
| Race conditions from shared `sessions` Map | No change in concurrency model; Map access already synchronized via PQueue |
| Timer/interval leaks in new managers | Each manager's `destroy()` clears its own timers; follow HealthOrchestrator pattern |
| `any` types in protocol `.on()` event callbacks | Accept `unknown` at event boundary, narrow with type guards inside handlers |

---

## 12. Success Criteria

1. ConsoleManager.ts reduced from ~11,015 to ~7,500 lines
2. All 7 legacy protocol fields eliminated
3. `dockerProtocol` field deleted
4. 8 new files created (7 managers + 1 base class)
5. ~105 new unit tests, all passing
6. Existing 1,012 tests still passing
7. ~35-40 explicit `any` usages eliminated
8. `npm run typecheck` and `npm run lint` pass clean
