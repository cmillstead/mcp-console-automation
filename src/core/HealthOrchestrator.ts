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
    exportFormats: ('json' | 'csv' | 'prometheus')[];
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

  private healingStats = {
    totalHealingAttempts: 0,
    successfulHealingAttempts: 0,
    automaticRecoveries: 0,
    preventedFailures: 0,
    proactiveReconnections: 0,
  };

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

    this.initializeComponents();
  }

  /**
   * Create all 5 self-healing components using orchestrator config.
   * Moved from ConsoleManager.initializeSelfHealingComponents().
   */
  private initializeComponents(): void {
    // Initialize HealthMonitor with comprehensive system monitoring
    this.healthMonitor = new HealthMonitor({
      checkInterval: this.config.healthMonitor.checkInterval,
      thresholds: this.config.healthMonitor.thresholds,
    });

    // Initialize HeartbeatMonitor for session health tracking with SSH proactive reconnection
    this.heartbeatMonitor = new HeartbeatMonitor({
      ...this.config.heartbeatMonitor,
      enablePredictiveFailure: this.config.predictiveHealingEnabled,
    });

    // Initialize SessionRecovery with multiple strategies
    this.sessionRecovery = new SessionRecovery(this.config.sessionRecovery);

    // Initialize MetricsCollector for comprehensive monitoring
    this.metricsCollector = new MetricsCollector({
      ...this.config.metricsCollector,
      enablePredictiveMetrics: this.config.predictiveHealingEnabled,
    });

    // Initialize SSH KeepAlive for connection maintenance
    this.sshKeepAlive = new SSHConnectionKeepAlive({
      ...this.config.sshKeepAlive,
      enablePredictiveReconnect: this.config.predictiveHealingEnabled,
    });

    // Start proactive health monitoring based on environment
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.ENABLE_PROACTIVE_MONITORING === 'true'
    ) {
      this.sshKeepAlive.startProactiveMonitoring(3); // Every 3 minutes in production
      this.logger.info(
        'Proactive health monitoring enabled (3-minute intervals)'
      );
    } else {
      this.sshKeepAlive.startProactiveMonitoring(10); // Every 10 minutes in development
      this.logger.info(
        'Proactive health monitoring enabled (10-minute intervals)'
      );
    }

    this.logger.info('Self-healing components initialized successfully');
  }

  getNetworkMetricsManager(): NetworkMetricsManager {
    return this.networkMetricsManager;
  }

  getSessionPersistenceManager(): SessionPersistenceManager {
    return this.sessionPersistenceManager;
  }

  getHealingStats(): typeof this.healingStats {
    return { ...this.healingStats };
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  getHeartbeatMonitor(): HeartbeatMonitor {
    return this.heartbeatMonitor;
  }

  getSessionRecovery(): SessionRecovery {
    return this.sessionRecovery;
  }

  getMetricsCollector(): MetricsCollector {
    return this.metricsCollector;
  }

  getSSHKeepAlive(): SSHConnectionKeepAlive {
    return this.sshKeepAlive;
  }

  /**
   * Start all health monitoring: wire events, start monitors,
   * begin network metrics collection.
   */
  start(): void {
    if (!this.host.isSelfHealingEnabled()) {
      this.logger.info('Self-healing disabled, skipping integration setup');
      return;
    }

    this.setupEventWiring();

    // Start all monitoring services
    this.healthMonitor.start();
    this.heartbeatMonitor.start();
    this.metricsCollector.start();

    // Start network metrics monitoring with known hosts
    this.networkMetricsManager.startMonitoring(() =>
      this.host.getKnownHosts()
    );

    this.logger.info('Self-healing integration setup completed');
  }

  /**
   * Shutdown all self-healing components cleanly.
   * Moved from ConsoleManager.shutdownSelfHealingComponents().
   */
  async stop(): Promise<void> {
    try {
      this.logger.info('Shutting down self-healing components...');

      if (this.healthMonitor) {
        await this.healthMonitor.stop();
      }

      if (this.heartbeatMonitor) {
        await this.heartbeatMonitor.stop();
      }

      if (this.metricsCollector) {
        await this.metricsCollector.stop();
      }

      if (this.sshKeepAlive) {
        await this.sshKeepAlive.stop();
      }

      if (this.sessionRecovery) {
        await this.sessionRecovery.stop();
      }

      this.logger.info('Self-healing components shutdown complete');
    } catch (error) {
      this.logger.error(
        'Error during self-healing components shutdown:',
        error
      );
    }
  }

  /**
   * Register a newly created session with all health monitoring components.
   * Moved from ConsoleManager.registerSessionWithHealthMonitoring().
   */
  async onSessionCreated(
    sessionId: string,
    sessionData: {
      createdAt: Date;
      status: string;
      type: string;
      pid?: number;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      sshOptions?: {
        host: string;
        port?: number;
        username?: string;
      };
      streaming?: boolean;
    },
    options: any
  ): Promise<void> {
    try {
      const sessionInfo = {
        id: sessionId,
        createdAt: sessionData.createdAt,
        lastActivity: new Date(),
        status:
          sessionData.status === 'crashed'
            ? ('failed' as const)
            : (sessionData.status as
                | 'running'
                | 'failed'
                | 'paused'
                | 'stopped'
                | 'initializing'
                | 'recovering'),
        type: sessionData.sshOptions ? ('ssh' as const) : ('local' as const),
        pid: sessionData.pid,
        healthScore: 100,
        recoveryAttempts: 0,
        maxRecoveryAttempts: 3,
        metadata: {
          command: sessionData.command,
          args: sessionData.args || [],
        },
      };

      // Register with heartbeat monitor
      this.heartbeatMonitor.addSession(
        sessionId,
        sessionInfo,
        sessionData.sshOptions
          ? {
              hostname: sessionData.sshOptions.host,
              port: sessionData.sshOptions.port || 22,
              username: sessionData.sshOptions.username || 'unknown',
            }
          : undefined
      );

      // Record session creation metrics
      this.metricsCollector.recordSessionLifecycle(
        'created',
        sessionId,
        sessionData.type
      );

      // Register with session recovery
      await this.sessionRecovery.registerSession(
        sessionId,
        sessionInfo,
        options
      );

      this.logger.debug(
        `Session ${sessionId} registered with health monitoring components`
      );
    } catch (error) {
      this.logger.warn(
        `Failed to register session ${sessionId} with health monitoring:`,
        error
      );
    }
  }

  /**
   * Unregister a session from all health monitoring components.
   * Moved from ConsoleManager.unregisterSessionFromHealthMonitoring().
   */
  async onSessionDestroyed(
    sessionId: string,
    sessionType?: string,
    sessionCreatedAt?: Date,
    reason: string = 'session-terminated'
  ): Promise<void> {
    try {
      this.heartbeatMonitor.removeSession(sessionId);

      const duration = sessionCreatedAt
        ? Date.now() - sessionCreatedAt.getTime()
        : undefined;
      this.metricsCollector.recordSessionLifecycle(
        'terminated',
        sessionId,
        sessionType || 'unknown',
        duration
      );

      await this.sessionRecovery.unregisterSession(sessionId);

      this.logger.debug(
        `Session ${sessionId} unregistered from health monitoring (reason: ${reason})`
      );
    } catch (error) {
      this.logger.warn(
        `Failed to unregister session ${sessionId} from health monitoring:`,
        error
      );
    }
  }

  /**
   * Wire all sub-component events to appropriate handlers.
   * Moved from ConsoleManager.setupSelfHealingIntegration().
   *
   * Phase A: Decision logic stays in event handlers (same as ConsoleManager had).
   * Callbacks route through host interface. Phase B will move decision logic
   * into HealthOrchestrator proper.
   */
  private setupEventWiring(): void {
    // --- Health Monitor Integration ---
    this.healthMonitor.on('healthCheck', (result) => {
      this.host.emitEvent('system-health-check', result);

      this.metricsCollector.recordHealthCheck(
        result.overall > 0.5,
        'system-health',
        0
      );

      if (result.overall < 0.7 && this.config.predictiveHealingEnabled) {
        this.host.emitEvent('predictive-healing-triggered', {
          trigger: 'system-health-degradation',
          data: result,
          timestamp: new Date(),
        });
      }
    });

    this.healthMonitor.on('criticalIssue', async (issue: { type: string }) => {
      this.logger.warn('Critical system issue detected:', issue);
      this.healingStats.totalHealingAttempts++;

      if (this.config.autoRecoveryEnabled) {
        try {
          // Route to host for action dispatch (Phase A)
          switch (issue.type) {
            case 'high-memory-usage':
              await this.host.optimizeMemoryUsage();
              break;
            case 'high-cpu-usage':
              await this.host.throttleOperations();
              break;
            case 'disk-space-low':
              await this.host.cleanupTemporaryFiles();
              break;
            case 'network-degradation':
              await this.host.optimizeNetworkConnections();
              break;
            default:
              this.logger.warn(
                `No specific handler for issue type: ${issue.type}`
              );
          }
          this.healingStats.successfulHealingAttempts++;
        } catch (error) {
          this.logger.error(
            'Failed to auto-recover from critical issue:',
            error
          );
        }
      }

      this.host.emitEvent('critical-system-issue', issue);
    });

    // --- Heartbeat Monitor Integration ---
    this.heartbeatMonitor.on(
      'heartbeatMissed',
      async ({
        sessionId,
        missedCount,
        lastHeartbeat,
      }: {
        sessionId: string;
        missedCount: number;
        lastHeartbeat: number;
      }) => {
        this.logger.warn(
          `Heartbeat missed for session ${sessionId}: ${missedCount} missed, last: ${lastHeartbeat}`
        );

        if (missedCount >= 3) {
          const session = this.host.getSession(sessionId);
          if (session) {
            await this.sessionRecovery.recoverSession(
              sessionId,
              'heartbeat-failure'
            );
          }
        }
      }
    );

    this.heartbeatMonitor.on(
      'sessionUnhealthy',
      async ({
        sessionId,
        healthScore,
        issues,
      }: {
        sessionId: string;
        healthScore: number;
        issues: string[];
      }) => {
        this.logger.warn(
          `Session ${sessionId} unhealthy (score: ${healthScore}):`,
          issues
        );

        if (this.config.autoRecoveryEnabled && healthScore < 0.3) {
          const session = this.host.getSession(sessionId);
          if (session) {
            await this.sessionRecovery.recoverSession(
              sessionId,
              'health-degradation'
            );
          }
        }
      }
    );

    // SSH Proactive Reconnection
    this.heartbeatMonitor.on(
      'ssh-proactive-reconnect',
      async ({
        sessionId,
        failureRisk,
        heartbeat,
        timestamp,
        reason,
        urgency,
      }: {
        sessionId: string;
        failureRisk: number;
        heartbeat: any;
        timestamp: Date;
        reason: string;
        urgency: string;
      }) => {
        this.logger.warn(
          `SSH proactive reconnection triggered for session ${sessionId} (risk: ${(failureRisk * 100).toFixed(1)}%, urgency: ${urgency})`
        );

        try {
          const session = this.host.getSession(sessionId);
          if (!session) {
            this.logger.error(
              `Cannot find session ${sessionId} for proactive reconnection`
            );
            return;
          }

          this.healingStats.totalHealingAttempts++;
          this.healingStats.proactiveReconnections++;

          this.metricsCollector.recordRecoveryAttempt(
            false,
            'ssh-proactive-reconnect',
            0,
            sessionId
          );

          this.host.emitEvent('ssh-proactive-reconnect-triggered', {
            sessionId,
            failureRisk,
            urgency,
            timestamp,
            reason,
            sessionMetadata: {
              hostname: heartbeat.sshHealthData?.hostname,
              port: heartbeat.sshHealthData?.port,
              connectionUptime: heartbeat.sshHealthData
                ? Date.now() - heartbeat.lastBeat.getTime()
                : 0,
            },
          });

          if (session.sshOptions) {
            this.logger.info(
              `Initiating proactive SSH reconnection for ${session.sshOptions.host}:${session.sshOptions.port}`
            );

            await this.host.stopSession(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            let newSessionResult: {
              success: boolean;
              sessionId?: string;
              error?: string;
            };
            try {
              const newSessionId = await this.host.createSession({
                command: session.command,
                args: session.args,
                cwd: session.cwd,
                env: session.env,
                sshOptions: session.sshOptions,
                streaming: session.streaming,
                timeout: session.timeout || 120000,
                monitoring: {
                  enableMetrics: true,
                  enableTracing: false,
                  enableProfiling: false,
                  enableAuditing: false,
                },
              });
              newSessionResult = {
                success: true,
                sessionId: newSessionId,
                error: undefined,
              };
            } catch (error) {
              newSessionResult = {
                success: false,
                sessionId: undefined,
                error: error instanceof Error ? error.message : String(error),
              };
            }

            if (newSessionResult.success) {
              this.logger.info(
                `Successfully reconnected SSH session ${sessionId} -> ${newSessionResult.sessionId} (risk prevention)`
              );
              this.healingStats.successfulHealingAttempts++;
              this.healingStats.automaticRecoveries++;

              this.metricsCollector.recordRecoveryAttempt(
                true,
                'ssh-proactive-reconnect',
                Date.now() - timestamp.getTime(),
                newSessionResult.sessionId
              );

              this.host.emitEvent('ssh-proactive-reconnect-success', {
                oldSessionId: sessionId,
                newSessionId: newSessionResult.sessionId,
                failureRisk,
                reconnectionTime: Date.now() - timestamp.getTime(),
              });
            } else {
              this.logger.error(
                `Failed to proactively reconnect SSH session ${sessionId}: ${newSessionResult.error}`
              );
              this.host.emitEvent('ssh-proactive-reconnect-failed', {
                sessionId,
                failureRisk,
                error: newSessionResult.error,
                reconnectionTime: Date.now() - timestamp.getTime(),
              });
            }
          } else {
            this.logger.warn(
              `Session ${sessionId} flagged for proactive reconnection but has no SSH options`
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Error during SSH proactive reconnection for session ${sessionId}: ${errorMessage}`
          );

          this.host.emitEvent('ssh-proactive-reconnect-failed', {
            sessionId,
            failureRisk,
            error: errorMessage,
            reconnectionTime: Date.now() - timestamp.getTime(),
          });
        }
      }
    );

    // --- Session Recovery Integration ---
    this.sessionRecovery.on(
      'recoveryAttempted',
      ({
        sessionId,
        strategy,
        success,
        duration,
        metadata,
      }: {
        sessionId: string;
        strategy: string;
        success: boolean;
        duration: number;
        metadata: any;
      }) => {
        this.logger.info(
          `Session recovery attempted: ${sessionId}, strategy: ${strategy}, success: ${success}`
        );

        if (success) {
          this.healingStats.successfulHealingAttempts++;
          this.healingStats.automaticRecoveries++;
        }
        this.healingStats.totalHealingAttempts++;

        this.metricsCollector.recordRecoveryAttempt(
          success,
          strategy,
          duration,
          sessionId
        );

        this.host.emitEvent('session-recovery-attempted', {
          sessionId,
          strategy,
          success,
          duration,
          metadata,
        });
      }
    );

    this.sessionRecovery.on(
      'recoveryFailed',
      ({
        sessionId,
        strategy,
        error,
        attempts,
      }: {
        sessionId: string;
        strategy: string;
        error: Error;
        attempts: number;
      }) => {
        this.logger.error(
          `Session recovery failed: ${sessionId}, strategy: ${strategy}, attempts: ${attempts}`,
          error
        );

        if (attempts < 3) {
          setTimeout(
            () => {
              this.sessionRecovery.recoverSession(sessionId, 'recovery-retry');
            },
            Math.pow(2, attempts) * 1000
          );
        }

        this.host.emitEvent('session-recovery-failed', {
          sessionId,
          strategy,
          error,
          attempts,
        });
      }
    );

    // Interactive prompt recovery events — route to host
    this.sessionRecovery.on(
      'session-interrupt-request',
      (data: any) => this.host.handleSessionInterruptRequest(data)
    );
    this.sessionRecovery.on(
      'session-prompt-reset-request',
      (data: any) => this.host.handlePromptResetRequest(data)
    );
    this.sessionRecovery.on(
      'session-refresh-request',
      (data: any) => this.host.handleSessionRefreshRequest(data)
    );
    this.sessionRecovery.on(
      'session-command-retry-request',
      (data: any) => this.host.handleCommandRetryRequest(data)
    );
    this.sessionRecovery.on(
      'interactive-state-updated',
      (data: any) => this.host.handleInteractiveStateUpdate(data)
    );

    // --- Metrics Collector Integration ---
    this.metricsCollector.on(
      'alertThresholdExceeded',
      (alert: { metric: string; value: number }) => {
        this.logger.warn('Metrics alert triggered:', alert);

        if (alert.metric === 'errorRate' && alert.value > 0.1) {
          this.logger.warn('System healing mode activated: high-error-rate');
          this.host.emitEvent('system-healing-mode-activated', {
            reason: 'high-error-rate',
            timestamp: new Date(),
          });
        } else if (
          alert.metric === 'sessionFailureRate' &&
          alert.value > 0.05
        ) {
          this.logger.info('Enhanced session monitoring activated');
        }

        this.host.emitEvent('metrics-alert', alert);
      }
    );

    this.metricsCollector.on(
      'trendPrediction',
      (prediction: { confidence: number }) => {
        if (
          this.config.predictiveHealingEnabled &&
          prediction.confidence > 0.8
        ) {
          this.logger.info('Predictive trend detected:', prediction);
          this.host.emitEvent('predictive-healing-triggered', {
            trigger: 'trend-prediction',
            data: prediction,
            timestamp: new Date(),
          });
          this.healingStats.preventedFailures++;
        }
      }
    );

    // --- SSH KeepAlive Integration ---
    this.sshKeepAlive.on(
      'keepAliveSuccess',
      ({
        responseTime,
      }: {
        connectionId: string;
        responseTime: number;
      }) => {
        this.metricsCollector.recordConnectionMetrics(
          true,
          responseTime,
          'ssh'
        );
      }
    );

    this.sshKeepAlive.on(
      'keepAliveFailed',
      async ({
        connectionId,
        error,
        consecutiveFailures,
      }: {
        connectionId: string;
        error: Error;
        consecutiveFailures: number;
      }) => {
        this.logger.warn(
          `SSH keep-alive failed for ${connectionId}: ${consecutiveFailures} consecutive failures`,
          error
        );

        this.metricsCollector.recordConnectionMetrics(false, 0, 'ssh');

        if (consecutiveFailures >= 3) {
          this.logger.info(
            `Handling SSH connection failure: ${connectionId}`
          );
          try {
            this.logger.info(
              `Connection failure handled for ${connectionId}: ${error.message}`
            );
            this.host.emitEvent('ssh-connection-failure-detected', {
              connectionId,
              error,
            });
          } catch (poolError) {
            this.logger.error(
              'Connection pool failed to handle SSH connection failure:',
              poolError
            );
            this.host.emitEvent('ssh-connection-recovery-failed', {
              connectionId,
              originalError: error,
              poolError,
            });
          }
        }
      }
    );

    this.sshKeepAlive.on(
      'connectionDegraded',
      ({
        connectionId,
        responseTime,
        trend,
      }: {
        connectionId: string;
        responseTime: number;
        trend: number;
      }) => {
        this.logger.info(
          `SSH connection ${connectionId} showing degradation: ${responseTime}ms (trend: ${trend})`
        );

        if (this.config.predictiveHealingEnabled && trend > 0.3) {
          this.logger.info(
            `Preparing backup SSH connection for ${connectionId}`
          );
          this.host.emitEvent('backup-connection-preparing', {
            connectionId,
            timestamp: new Date(),
          });
        }
      }
    );

    // Server Alive Monitoring
    this.sshKeepAlive.on(
      'server-alive-success',
      ({
        connectionId,
        responseTime,
      }: {
        connectionId: string;
        responseTime: number;
        timestamp: Date;
      }) => {
        this.logger.debug(
          `Server alive check successful for ${connectionId}: ${responseTime}ms`
        );
        this.metricsCollector.recordConnectionMetrics(
          true,
          responseTime,
          'ssh-server-alive'
        );
      }
    );

    this.sshKeepAlive.on(
      'server-alive-failed',
      async ({
        connectionId,
        error,
        timestamp,
      }: {
        connectionId: string;
        error: string;
        timestamp: Date;
      }) => {
        this.logger.warn(
          `Server alive check failed for ${connectionId}: ${error}`
        );
        this.metricsCollector.recordConnectionMetrics(
          false,
          0,
          'ssh-server-alive'
        );

        this.host.emitEvent('ssh-server-unresponsive', {
          connectionId,
          error,
          timestamp,
        });
      }
    );

    // Proactive Health Monitoring
    this.sshKeepAlive.on(
      'proactive-health-check-completed',
      (results: {
        totalConnections: number;
        healthyConnections: number;
        degradedConnections: number;
        criticalConnections: number;
        recommendations: string[];
      }) => {
        this.logger.info('Proactive health check results:', {
          total: results.totalConnections,
          healthy: results.healthyConnections,
          degraded: results.degradedConnections,
          critical: results.criticalConnections,
          recommendations: results.recommendations.length,
        });

        if (results.recommendations.length > 0) {
          this.logger.warn(
            'Health check recommendations:',
            results.recommendations
          );
        }

        this.host.emitEvent('proactive-health-check-completed', results);
      }
    );
  }
}
