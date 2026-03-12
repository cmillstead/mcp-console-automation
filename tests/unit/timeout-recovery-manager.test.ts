import { TimeoutRecoveryManager, TimeoutRecoveryHost } from '../../src/core/TimeoutRecoveryManager';
import { Logger } from '../../src/utils/logger';

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
      getPersistenceData: jest.fn().mockReturnValue(null),
      restoreSessionStateFromBookmark: jest.fn().mockResolvedValue(undefined),
    }),
    getCommandQueueManager: jest.fn().mockReturnValue({
      clearQueueOutputBuffer: jest.fn(),
      restoreCommandQueueFromPersistence: jest.fn().mockReturnValue(0),
    }),
    emitEvent: jest.fn(),
    isSelfHealingEnabled: jest.fn().mockReturnValue(true),
    delay: jest.fn().mockResolvedValue(undefined),
    createSessionBookmark: jest.fn().mockResolvedValue(undefined),
    getRetryManager: jest.fn().mockReturnValue({
      executeWithRetry: jest.fn().mockImplementation(async (fn: Function) => fn()),
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

    it('should classify SSH responsiveness timeout', () => {
      const error = new Error('SSH session unresponsive');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('ssh_responsiveness');
    });

    it('should classify command execution timeout', () => {
      const error = new Error('command execution timeout');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('command_execution');
    });

    it('should classify recovery timeout', () => {
      const error = new Error('recovery timeout');
      const result = manager.classifyTimeoutError(error);
      expect(result.category).toContain('recovery_timeout');
    });
  });

  describe('determineTimeoutSeverity', () => {
    it('should return medium severity for command acknowledgment', () => {
      const result = manager.determineTimeoutSeverity('command_acknowledgment', 'some error');
      expect(result.severity).toBe('medium');
      expect(result.recoverable).toBe(true);
    });

    it('should return high severity for SSH connection', () => {
      const result = manager.determineTimeoutSeverity('ssh_connection', 'some error');
      expect(result.severity).toBe('high');
      expect(result.recoverable).toBe(true);
    });

    it('should return critical for errors with critical indicators', () => {
      const result = manager.determineTimeoutSeverity('command_acknowledgment', 'max attempts exceeded');
      expect(result.severity).toBe('critical');
      expect(result.recoverable).toBe(false);
    });

    it('should return low severity for network latency', () => {
      const result = manager.determineTimeoutSeverity('network_latency', 'some error');
      expect(result.severity).toBe('low');
      expect(result.recoverable).toBe(true);
    });
  });

  describe('getTimeoutRecoveryMetrics', () => {
    it('should return initial empty metrics', () => {
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(0);
      expect(metrics.successfulRecoveries).toBe(0);
      expect(metrics.failedRecoveries).toBe(0);
      expect(metrics.overallSuccessRate).toBe(0);
    });
  });

  describe('recordRecoveryAttempt', () => {
    it('should track successful recovery attempts', () => {
      manager.recordRecoveryAttempt('test-session', 'timeout_command_acknowledgment', true, 100);
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(1);
      expect(metrics.successfulRecoveries).toBe(1);
      expect(metrics.overallSuccessRate).toBe(100);
    });

    it('should track failed recovery attempts', () => {
      manager.recordRecoveryAttempt('test-session', 'timeout_ssh_connection', false, 200, 'Connection refused');
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(1);
      expect(metrics.failedRecoveries).toBe(1);
      expect(metrics.overallSuccessRate).toBe(0);
    });

    it('should maintain history capped at 100', () => {
      for (let i = 0; i < 105; i++) {
        manager.recordRecoveryAttempt('test-session', 'test', true, 50);
      }
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(105);
      // recentHistory returns last 10 of the capped 100
      expect(metrics.recentHistory.length).toBe(10);
    });
  });

  describe('attemptTimeoutRecovery', () => {
    it('should fail when max attempts exceeded', async () => {
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

  describe('getRecoveryAttempts', () => {
    it('should return 0 for unknown session', () => {
      expect(manager.getRecoveryAttempts('unknown')).toBe(0);
    });

    it('should return tracked attempts', () => {
      manager['recoveryAttempts'].set('test-session', 2);
      expect(manager.getRecoveryAttempts('test-session')).toBe(2);
    });
  });

  describe('clearRecoveryAttempts', () => {
    it('should clear attempts for a session', () => {
      manager['recoveryAttempts'].set('test-session', 3);
      manager.clearRecoveryAttempts('test-session');
      expect(manager.getRecoveryAttempts('test-session')).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should clear internal state', () => {
      manager['recoveryAttempts'].set('test-session', 3);
      manager.recordRecoveryAttempt('s1', 'cat', true, 10);
      manager.dispose();
      expect(manager['recoveryAttempts'].size).toBe(0);
      const metrics = manager.getTimeoutRecoveryMetrics();
      expect(metrics.totalAttempts).toBe(0);
    });
  });
});
