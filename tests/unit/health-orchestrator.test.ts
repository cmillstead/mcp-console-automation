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
});
