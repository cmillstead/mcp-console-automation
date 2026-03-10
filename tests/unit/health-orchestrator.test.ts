import {
  HealthOrchestrator,
  HealthOrchestratorHost,
  HealthOrchestratorConfig,
} from '../../src/core/HealthOrchestrator';
import { Logger } from '../../src/utils/logger';
import { NetworkMetricsManager } from '../../src/core/NetworkMetricsManager';
import { SessionPersistenceManager } from '../../src/core/SessionPersistenceManager';

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

function createDefaultConfig(): HealthOrchestratorConfig {
  return {
    selfHealingEnabled: true,
    predictiveHealingEnabled: true,
    autoRecoveryEnabled: true,
    healthMonitor: {
      checkInterval: 30000,
      thresholds: {
        cpu: 80,
        memory: 85,
        disk: 90,
        networkLatency: 5000,
        processResponseTime: 5000,
        sshConnectionLatency: 2000,
        sshHealthScore: 70,
      },
    },
    heartbeatMonitor: {
      interval: 60000,
      timeout: 10000,
      maxMissedBeats: 3,
      enableAdaptiveInterval: true,
      retryAttempts: 3,
      retryDelay: 2000,
      gracePeriod: 5000,
      sshHeartbeatInterval: 30000,
      sshTimeoutThreshold: 15000,
      enableSSHProactiveReconnect: true,
      sshFailureRiskThreshold: 0.65,
    },
    sessionRecovery: {
      enabled: true,
      maxRecoveryAttempts: 3,
      recoveryDelay: 5000,
      backoffMultiplier: 2,
      maxBackoffDelay: 60000,
      persistenceEnabled: true,
      persistencePath: './data/session-snapshots',
      enableSmartRecovery: true,
      snapshotInterval: 300000,
      recoveryTimeout: 120000,
    },
    metricsCollector: {
      enabled: true,
      collectionInterval: 10000,
      retentionPeriod: 86400000,
      aggregationWindow: 60000,
      enableRealTimeMetrics: true,
      enableHistoricalMetrics: true,
      persistenceEnabled: true,
      persistencePath: './data/metrics',
      exportFormats: ['json', 'csv', 'prometheus'],
      alertThresholds: {
        errorRate: 0.05,
        responseTime: 5000,
        throughput: 10,
        availability: 0.99,
      },
    },
    sshKeepAlive: {
      enabled: true,
      keepAliveInterval: 15000,
      keepAliveCountMax: 6,
      serverAliveInterval: 30000,
      serverAliveCountMax: 5,
      connectionTimeout: 20000,
      reconnectOnFailure: true,
      maxReconnectAttempts: 8,
      reconnectDelay: 3000,
      backoffMultiplier: 1.5,
      maxReconnectDelay: 45000,
      enableAdaptiveKeepAlive: true,
      connectionHealthThreshold: 65,
    },
  };
}

describe('HealthOrchestrator', () => {
  let host: HealthOrchestratorHost;
  let logger: Logger;
  let networkMetrics: NetworkMetricsManager;
  let persistence: SessionPersistenceManager;
  let orchestrator: HealthOrchestrator;

  beforeEach(() => {
    host = createMockHost();
    logger = new Logger('HealthOrchestratorTest');
    networkMetrics = new NetworkMetricsManager(logger);
    persistence = new SessionPersistenceManager(logger);
    orchestrator = new HealthOrchestrator(
      logger,
      host,
      createDefaultConfig(),
      networkMetrics,
      persistence
    );
  });

  afterEach(async () => {
    await orchestrator.stop();
  });

  it('can be instantiated', () => {
    expect(orchestrator).toBeDefined();
  });

  it('start() initializes and starts components without throwing', () => {
    expect(() => orchestrator.start()).not.toThrow();
  });

  it('stop() shuts down cleanly', async () => {
    orchestrator.start();
    await orchestrator.stop();
  });

  it('exposes NetworkMetricsManager', () => {
    expect(orchestrator.getNetworkMetricsManager()).toBeDefined();
  });

  it('exposes SessionPersistenceManager', () => {
    expect(orchestrator.getSessionPersistenceManager()).toBeDefined();
  });

  it('getHealingStats() returns stats', () => {
    const stats = orchestrator.getHealingStats();
    expect(stats).toHaveProperty('totalHealingAttempts');
    expect(stats).toHaveProperty('successfulHealingAttempts');
    expect(stats).toHaveProperty('automaticRecoveries');
    expect(stats).toHaveProperty('preventedFailures');
    expect(stats).toHaveProperty('proactiveReconnections');
  });

  it('exposes sub-components via getters', () => {
    expect(orchestrator.getHealthMonitor()).toBeDefined();
    expect(orchestrator.getHeartbeatMonitor()).toBeDefined();
    expect(orchestrator.getSessionRecovery()).toBeDefined();
    expect(orchestrator.getMetricsCollector()).toBeDefined();
    expect(orchestrator.getSSHKeepAlive()).toBeDefined();
  });

  it('getSelfHealingConfig() returns config state', () => {
    const config = orchestrator.getSelfHealingConfig();
    expect(config.selfHealingEnabled).toBe(true);
    expect(config.autoRecoveryEnabled).toBe(true);
    expect(config.predictiveHealingEnabled).toBe(true);
    expect(config.healingStats).toBeDefined();
  });

  it('setPredictiveHealingEnabled() updates config', () => {
    orchestrator.setPredictiveHealingEnabled(false);
    expect(orchestrator.getSelfHealingConfig().predictiveHealingEnabled).toBe(false);
  });

  it('setAutoRecoveryEnabled() updates config', () => {
    orchestrator.setAutoRecoveryEnabled(false);
    expect(orchestrator.getSelfHealingConfig().autoRecoveryEnabled).toBe(false);
  });

  describe('decision logic (event wiring)', () => {
    beforeEach(() => {
      orchestrator.start();
    });

    it('critical issue with high-memory-usage calls host.optimizeMemoryUsage', async () => {
      orchestrator.getHealthMonitor().emit('criticalIssue', { type: 'high-memory-usage' });
      // Allow async handler to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(host.optimizeMemoryUsage).toHaveBeenCalled();
    });

    it('critical issue with high-cpu-usage calls host.throttleOperations', async () => {
      orchestrator.getHealthMonitor().emit('criticalIssue', { type: 'high-cpu-usage' });
      await new Promise((r) => setTimeout(r, 50));
      expect(host.throttleOperations).toHaveBeenCalled();
    });

    it('critical issue increments totalHealingAttempts', async () => {
      orchestrator.getHealthMonitor().emit('criticalIssue', { type: 'high-memory-usage' });
      await new Promise((r) => setTimeout(r, 50));
      expect(orchestrator.getHealingStats().totalHealingAttempts).toBe(1);
      expect(orchestrator.getHealingStats().successfulHealingAttempts).toBe(1);
    });

    it('healthCheck emits system-health-check via host', () => {
      orchestrator.getHealthMonitor().emit('healthCheck', { overall: 0.9 });
      expect(host.emitEvent).toHaveBeenCalledWith(
        'system-health-check',
        expect.objectContaining({ overall: 0.9 })
      );
    });

    it('low healthCheck triggers predictive healing when enabled', () => {
      orchestrator.getHealthMonitor().emit('healthCheck', { overall: 0.5 });
      expect(host.emitEvent).toHaveBeenCalledWith(
        'predictive-healing-triggered',
        expect.objectContaining({ trigger: 'system-health-degradation' })
      );
    });

    it('alertThresholdExceeded with high errorRate triggers system healing mode', () => {
      orchestrator.getMetricsCollector().emit('alertThresholdExceeded', {
        metric: 'errorRate',
        value: 0.2,
      });
      expect(host.emitEvent).toHaveBeenCalledWith(
        'system-healing-mode-activated',
        expect.objectContaining({ reason: 'high-error-rate' })
      );
    });

    it('trendPrediction with high confidence triggers predictive healing', () => {
      orchestrator.getMetricsCollector().emit('trendPrediction', {
        confidence: 0.9,
      });
      expect(host.emitEvent).toHaveBeenCalledWith(
        'predictive-healing-triggered',
        expect.objectContaining({ trigger: 'trend-prediction' })
      );
      expect(orchestrator.getHealingStats().preventedFailures).toBe(1);
    });

    it('keepAliveSuccess records connection metrics', () => {
      orchestrator.getSSHKeepAlive().emit('keepAliveSuccess', {
        connectionId: 'conn-1',
        responseTime: 42,
      });
      // No error means metrics were recorded successfully
    });

    it('keepAliveFailed with >= 3 failures emits ssh-connection-failure-detected', async () => {
      orchestrator.getSSHKeepAlive().emit('keepAliveFailed', {
        connectionId: 'conn-1',
        error: new Error('timeout'),
        consecutiveFailures: 3,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(host.emitEvent).toHaveBeenCalledWith(
        'ssh-connection-failure-detected',
        expect.objectContaining({ connectionId: 'conn-1' })
      );
    });

    it('connectionDegraded with high trend emits backup-connection-preparing', () => {
      orchestrator.getSSHKeepAlive().emit('connectionDegraded', {
        connectionId: 'conn-1',
        responseTime: 500,
        trend: 0.5,
      });
      expect(host.emitEvent).toHaveBeenCalledWith(
        'backup-connection-preparing',
        expect.objectContaining({ connectionId: 'conn-1' })
      );
    });
  });
});
