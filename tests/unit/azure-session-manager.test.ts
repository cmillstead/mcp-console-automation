import { AzureSessionManager } from '../../src/core/AzureSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockAzureMonitoring(): any {
  return {
    registerSession: jest.fn(),
    unregisterSession: jest.fn(),
    recordConnectionEvent: jest.fn(),
    recordErrorEvent: jest.fn(),
    recordAuthenticationEvent: jest.fn(),
    getMetrics: jest.fn().mockReturnValue({ sessionCount: { total: 0 } }),
    performHealthCheck: jest.fn().mockResolvedValue({ overall: 'healthy' }),
    updateCostEstimates: jest.fn(),
    removeAllListeners: jest.fn(),
  };
}

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'azure' as const,
    capabilities: { supportsStreaming: true },
    createCloudShellSession: jest.fn().mockResolvedValue({ id: 'azure-cs', type: 'cloud-shell' }),
    createBastionSession: jest.fn().mockResolvedValue({ id: 'azure-bs', type: 'bastion' }),
    createArcSession: jest.fn().mockResolvedValue({ id: 'azure-arc', type: 'arc' }),
    sendInput: jest.fn().mockResolvedValue(undefined),
    closeSession: jest.fn().mockResolvedValue(undefined),
    getSessionMetrics: jest.fn().mockReturnValue({ latency: 50 }),
    healthCheck: jest.fn().mockResolvedValue(true),
    resizeTerminal: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockHost(mockProtocol: any): ProtocolSessionHost {
  return {
    getSession: jest.fn().mockReturnValue({ id: 'test', status: 'starting' }),
    setSession: jest.fn(),
    deleteSession: jest.fn(),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getMaxBufferSize: jest.fn().mockReturnValue(10000),
    createStreamManager: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    setStreamManager: jest.fn(),
    getStreamManager: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    deleteStreamManager: jest.fn(),
    updateSessionStatus: jest.fn().mockResolvedValue(undefined),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn(),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    addErrorPatterns: jest.fn(),
    getPromptDetector: jest.fn().mockReturnValue(null),
    getPaginationManager: jest.fn().mockReturnValue({ removeSession: jest.fn() }),
    isSelfHealingEnabled: jest.fn().mockReturnValue(false),
    getNextSequenceNumber: jest.fn().mockReturnValue(1),
    getLogger: jest.fn().mockReturnValue(new Logger('test')),
  };
}

function createMockLogger(): Logger {
  const logger = new Logger('test');
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  // getWinstonLogger returns the underlying winston logger
  jest.spyOn(logger, 'getWinstonLogger').mockReturnValue({} as any);
  return logger;
}

describe('AzureSessionManager', () => {
  let manager: AzureSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let mockMonitoring: ReturnType<typeof createMockAzureMonitoring>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    mockMonitoring = createMockAzureMonitoring();
    manager = new AzureSessionManager(host, logger, mockMonitoring);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(AzureSessionManager);
    });
  });

  describe('createSession (router)', () => {
    it('should route azure-shell to createCloudShellSession', async () => {
      const options = {
        consoleType: 'azure-shell',
        azureOptions: { subscriptionId: 'sub-1' },
      } as any;

      const result = await manager.createSession('az-1', options);

      expect(result).toBe('az-1');
      expect(mockProtocol.createCloudShellSession).toHaveBeenCalledWith('az-1', options.azureOptions);
    });

    it('should route azure-bastion to createBastionSession', async () => {
      const options = {
        consoleType: 'azure-bastion',
        azureOptions: { subscriptionId: 'sub-1' },
      } as any;

      const result = await manager.createSession('az-2', options);

      expect(result).toBe('az-2');
      expect(mockProtocol.createBastionSession).toHaveBeenCalledWith('az-2', options.azureOptions);
    });

    it('should route azure-ssh to createArcSession', async () => {
      const options = {
        consoleType: 'azure-ssh',
        azureOptions: { subscriptionId: 'sub-1' },
      } as any;

      const result = await manager.createSession('az-3', options);

      expect(result).toBe('az-3');
      expect(mockProtocol.createArcSession).toHaveBeenCalledWith('az-3', options.azureOptions);
    });

    it('should default to Cloud Shell when consoleType is unset', async () => {
      const options = {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any;

      await manager.createSession('az-4', options);

      expect(mockProtocol.createCloudShellSession).toHaveBeenCalled();
    });

    it('should default to Cloud Shell for unknown consoleType', async () => {
      const options = {
        consoleType: 'azure-unknown',
        azureOptions: { subscriptionId: 'sub-1' },
      } as any;

      await manager.createSession('az-5', options);

      expect(mockProtocol.createCloudShellSession).toHaveBeenCalled();
    });
  });

  describe('createCloudShellSession', () => {
    it('should throw when azureOptions is missing', async () => {
      await expect(manager.createCloudShellSession('az-no', {} as any)).rejects.toThrow(
        'Azure options are required for Azure Cloud Shell session'
      );
    });

    it('should register session with monitoring and health', async () => {
      const options = { azureOptions: { subscriptionId: 'sub-1' } } as any;

      await manager.createCloudShellSession('az-cs', options);

      expect(host.registerSessionWithHealthMonitoring).toHaveBeenCalledWith(
        'az-cs',
        expect.anything(),
        options
      );
      expect(host.getOrCreateProtocol).toHaveBeenCalledWith('azure');
    });

    it('should update session status to running', async () => {
      const session = { id: 'az-cs2', status: 'starting' };
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.createCloudShellSession('az-cs2', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      expect(session.status).toBe('running');
      expect(host.setSession).toHaveBeenCalledWith('az-cs2', session);
    });

    it('should propagate errors from protocol', async () => {
      mockProtocol.createCloudShellSession.mockRejectedValue(new Error('auth failed'));

      await expect(
        manager.createCloudShellSession('az-fail', {
          azureOptions: { subscriptionId: 'sub-1' },
        } as any)
      ).rejects.toThrow('auth failed');
    });
  });

  describe('createBastionSession', () => {
    it('should throw when azureOptions is missing', async () => {
      await expect(manager.createBastionSession('az-no', {} as any)).rejects.toThrow(
        'Azure options are required for Azure Bastion session'
      );
    });

    it('should create a bastion session', async () => {
      await manager.createBastionSession('az-bs', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      expect(mockProtocol.createBastionSession).toHaveBeenCalledWith(
        'az-bs',
        { subscriptionId: 'sub-1' }
      );
    });
  });

  describe('createArcSession', () => {
    it('should throw when azureOptions is missing', async () => {
      await expect(manager.createArcSession('az-no', {} as any)).rejects.toThrow(
        'Azure options are required for Azure Arc session'
      );
    });

    it('should create an arc session', async () => {
      await manager.createArcSession('az-arc', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      expect(mockProtocol.createArcSession).toHaveBeenCalledWith(
        'az-arc',
        { subscriptionId: 'sub-1' }
      );
    });
  });

  describe('sendInput', () => {
    it('should send input through the protocol', async () => {
      await manager.sendInput('az-in', 'ls -la\n');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('az-in', 'ls -la\n');
    });

    it('should propagate errors', async () => {
      mockProtocol.sendInput.mockRejectedValue(new Error('timeout'));

      await expect(manager.sendInput('az-in', 'test')).rejects.toThrow('timeout');
    });
  });

  describe('cleanupSession', () => {
    it('should close session through the protocol', async () => {
      await manager.cleanupSession('az-cl');

      expect(mockProtocol.closeSession).toHaveBeenCalledWith('az-cl');
    });

    it('should not throw on cleanup error', async () => {
      mockProtocol.closeSession.mockRejectedValue(new Error('already closed'));

      // Should not throw
      await expect(manager.cleanupSession('az-cl')).resolves.toBeUndefined();
    });
  });

  describe('getSessionMetrics', () => {
    it('should return empty object when protocol not initialized', () => {
      const result = manager.getSessionMetrics('az-m');
      expect(result).toEqual({});
    });

    it('should return metrics from protocol', async () => {
      // Initialize protocol first
      await manager.sendInput('az-m', 'test');

      const result = manager.getSessionMetrics('az-m');
      expect(result).toEqual({ latency: 50 });
    });
  });

  describe('checkSessionHealth', () => {
    it('should return false when protocol not initialized', async () => {
      const result = await manager.checkSessionHealth('az-h');
      expect(result).toBe(false);
    });

    it('should delegate to protocol healthCheck', async () => {
      // Initialize protocol first
      await manager.sendInput('az-h', 'test');

      const result = await manager.checkSessionHealth('az-h');
      expect(result).toBe(true);
      expect(mockProtocol.healthCheck).toHaveBeenCalledWith('az-h');
    });
  });

  describe('resizeSession', () => {
    it('should resize the terminal through the protocol', async () => {
      await manager.resizeSession('az-rs', 40, 120);

      expect(mockProtocol.resizeTerminal).toHaveBeenCalledWith('az-rs', 40, 120);
    });

    it('should propagate errors', async () => {
      mockProtocol.resizeTerminal.mockRejectedValue(new Error('not supported'));

      await expect(manager.resizeSession('az-rs', 40, 120)).rejects.toThrow('not supported');
    });
  });

  describe('monitoring methods', () => {
    it('should return monitoring metrics', () => {
      const result = manager.getMonitoringMetrics();
      expect(result).toEqual({ sessionCount: { total: 0 } });
    });

    it('should perform health check', async () => {
      const result = await manager.performHealthCheck();
      expect(result).toEqual({ overall: 'healthy' });
    });

    it('should update cost estimate', () => {
      // Should not throw
      manager.updateCostEstimate('az-cost', 1.50);
    });
  });

  describe('setupEventHandlers', () => {
    it('should emit azure-connected on connected event', async () => {
      // Initialize protocol to set up handlers
      await manager.createSession('az-evt', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      mockProtocol.emit('connected', 'az-evt');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-connected', {
        sessionId: 'az-evt',
      });
    });

    it('should emit azure-disconnected on disconnected event', async () => {
      await manager.createSession('az-dc', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      mockProtocol.emit('disconnected', 'az-dc');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-disconnected', {
        sessionId: 'az-dc',
      });
    });

    it('should classify and record error events', async () => {
      await manager.createSession('az-err', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      const authError = new Error('auth token expired');
      mockProtocol.emit('error', 'az-err', authError);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-error', {
        sessionId: 'az-err',
        error: authError,
      });
    });

    it('should handle output events and buffer them', async () => {
      await manager.createSession('az-out', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      const output = { type: 'stdout', data: 'hello' };
      mockProtocol.emit('output', 'az-out', output);

      expect(host.setOutputBuffer).toHaveBeenCalled();
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'az-out',
          type: 'output',
          data: output,
        })
      );
    });

    it('should emit token-refreshed events', async () => {
      await manager.createSession('az-tok', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      const tokenInfo = { accessToken: 'abc', expiresOn: new Date(), tokenType: 'Bearer', resource: 'https://management.azure.com' };
      mockProtocol.emit('token-refreshed', 'az-tok', tokenInfo);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-token-refreshed', {
        sessionId: 'az-tok',
        tokenInfo,
      });
    });

    it('should emit session-ready events', async () => {
      await manager.createSession('az-rdy', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      mockProtocol.emit('session-ready', 'az-rdy');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-session-ready', {
        sessionId: 'az-rdy',
      });
    });

    it('should emit reconnecting events', async () => {
      await manager.createSession('az-rc', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      mockProtocol.emit('reconnecting', 'az-rc', 3);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('azure-reconnecting', {
        sessionId: 'az-rc',
        attempt: 3,
      });
    });
  });

  describe('destroy', () => {
    it('should clean up protocol and monitoring', async () => {
      // Initialize protocol first
      await manager.createSession('az-d', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProtocol.cleanup.mockRejectedValue(new Error('cleanup failed'));

      await manager.createSession('az-d2', {
        azureOptions: { subscriptionId: 'sub-1' },
      } as any);

      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
