import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { HealthMonitor } from './HealthMonitor.js';
import { HeartbeatMonitor } from './HeartbeatMonitor.js';
import { SessionRecovery } from './SessionRecovery.js';
import { MetricsCollector } from './MetricsCollector.js';
import { SSHConnectionKeepAlive } from './SSHConnectionKeepAlive.js';
import { NetworkMetricsManager } from './NetworkMetricsManager.js';
import { SessionPersistenceManager } from './SessionPersistenceManager.js';

/**
 * Callback interface that ConsoleManager implements to provide
 * the HealthOrchestrator access to session lifecycle, resource
 * management, and self-healing operations.
 */
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

/**
 * Configuration for the HealthOrchestrator and all its sub-components.
 */
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

/**
 * Orchestrates all health-related subsystems: health monitoring, heartbeat
 * monitoring, session recovery, metrics collection, and SSH keep-alive.
 *
 * Follows the same host-callback pattern as CommandQueueManager/CommandQueueHost.
 */
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

  getNetworkMetricsManager(): NetworkMetricsManager {
    return this.networkMetricsManager;
  }

  getSessionPersistenceManager(): SessionPersistenceManager {
    return this.sessionPersistenceManager;
  }

  // Placeholders — filled in Tasks 2-3
  start(): void {}
  async stop(): Promise<void> {}
  onSessionCreated(sessionId: string, _sessionData: any): void {
    void sessionId;
  }
  onSessionDestroyed(sessionId: string): void {
    void sessionId;
  }
}
