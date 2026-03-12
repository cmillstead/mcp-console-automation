import { WSLSessionManager } from '../../src/core/WSLSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockWSLProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'wsl' as const,
    capabilities: { supportsStreaming: true },
    initialize: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue({ status: 'running', pid: undefined }),
    executeCommand: jest.fn().mockResolvedValue({ stdout: 'hello', stderr: '' }),
    closeSession: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    getInstalledDistributions: jest.fn().mockResolvedValue([]),
    getSystemInfo: jest.fn().mockResolvedValue({ wslVersion: '2.0', installedDistributions: [] }),
    startDistribution: jest.fn().mockResolvedValue(undefined),
    stopDistribution: jest.fn().mockResolvedValue(undefined),
    getHealthStatus: jest.fn().mockResolvedValue({ status: 'healthy' }),
    translatePath: jest.fn().mockResolvedValue('/mnt/c/Users/test'),
    checkWSLAvailability: jest.fn().mockResolvedValue(true),
    getWSLConfig: jest.fn().mockResolvedValue({ global: {}, distributions: {} }),
    resizeTerminal: jest.fn().mockResolvedValue(undefined),
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
    getStreamManager: jest.fn().mockReturnValue(undefined),
    deleteStreamManager: jest.fn(),
    updateSessionStatus: jest.fn().mockResolvedValue(undefined),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn().mockReturnValue({
      createProtocol: jest.fn().mockResolvedValue(mockProtocol),
    }),
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
  return logger;
}

function makeWSLOptions(overrides?: Record<string, unknown>) {
  return {
    wslOptions: {
      distribution: 'Ubuntu',
      wslVersion: 2 as const,
      ...overrides,
    },
  } as any;
}

describe('WSLSessionManager', () => {
  let manager: WSLSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockWSLProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockWSLProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new WSLSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(WSLSessionManager);
    });

    it('should not initialize protocol eagerly', () => {
      expect(host.getOrCreateProtocol).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  describe('setupWSLIntegration', () => {
    it('should call getOrCreateProtocol and initialize the protocol', async () => {
      await manager.setupWSLIntegration();

      expect(host.getOrCreateProtocol).toHaveBeenCalledWith('wsl');
      expect(mockProtocol.initialize).toHaveBeenCalled();
    });

    it('should be idempotent — protocol initialized only once', async () => {
      await manager.setupWSLIntegration();
      await manager.setupWSLIntegration();

      expect(host.getOrCreateProtocol).toHaveBeenCalledTimes(1);
    });

    it('should swallow errors gracefully', async () => {
      (host.getOrCreateProtocol as jest.Mock).mockRejectedValueOnce(new Error('WSL not found'));

      await expect(manager.setupWSLIntegration()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should swallow initialize() errors gracefully', async () => {
      mockProtocol.initialize.mockRejectedValueOnce(new Error('init failed'));

      await expect(manager.setupWSLIntegration()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  describe('createSession', () => {
    it('should throw when wslOptions is missing', async () => {
      await expect(
        manager.createSession('wsl-1', {} as any, {})
      ).rejects.toThrow('WSL options are required for WSL session');
    });

    it('should call createSession on the protocol', async () => {
      const options = makeWSLOptions();
      await manager.createSession('wsl-1', {} as any, options);

      expect(mockProtocol.createSession).toHaveBeenCalledWith(options);
    });

    it('should call host.setSession with merged session data', async () => {
      const session = { id: 'wsl-1', status: 'starting' } as any;
      const options = makeWSLOptions();
      await manager.createSession('wsl-1', session, options);

      expect(host.setSession).toHaveBeenCalledWith(
        'wsl-1',
        expect.objectContaining({ id: 'wsl-1' })
      );
    });

    it('should initialize the output buffer', async () => {
      const options = makeWSLOptions();
      await manager.createSession('wsl-1', {} as any, options);

      expect(host.setOutputBuffer).toHaveBeenCalledWith('wsl-1', []);
    });

    it('should create a StreamManager when streaming is enabled', async () => {
      const options = { ...makeWSLOptions(), streaming: true };
      await manager.createSession('wsl-stream', {} as any, options);

      expect(host.createStreamManager).toHaveBeenCalledWith('wsl-stream', options);
      expect(host.setStreamManager).toHaveBeenCalled();
    });

    it('should not create a StreamManager when streaming is disabled', async () => {
      const options = { ...makeWSLOptions(), streaming: false };
      await manager.createSession('wsl-no-stream', {} as any, options);

      expect(host.createStreamManager).not.toHaveBeenCalled();
    });

    it('should emit a started event via host', async () => {
      const options = makeWSLOptions({ distribution: 'Ubuntu' });
      await manager.createSession('wsl-evt', {} as any, options);

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'wsl-evt',
          type: 'started',
          data: expect.objectContaining({ distribution: 'Ubuntu', wsl: true }),
        })
      );
    });

    it('should return the sessionId on success', async () => {
      const result = await manager.createSession('wsl-ret', {} as any, makeWSLOptions());
      expect(result).toBe('wsl-ret');
    });

    it('should propagate errors from the protocol', async () => {
      mockProtocol.createSession.mockRejectedValueOnce(new Error('distribution not found'));

      await expect(
        manager.createSession('wsl-fail', {} as any, makeWSLOptions())
      ).rejects.toThrow('distribution not found');
    });
  });

  // -----------------------------------------------------------------------
  describe('sendInput', () => {
    beforeEach(async () => {
      await manager.createSession('wsl-si', {} as any, makeWSLOptions());
    });

    it('should throw when session not found in host', async () => {
      (host.getSession as jest.Mock).mockReturnValueOnce(undefined);

      await expect(manager.sendInput('wsl-si', 'ls')).rejects.toThrow(
        'WSL session wsl-si not found'
      );
    });

    it('should throw when protocol not initialized', async () => {
      // Destroy protocol to simulate uninitialized state
      await manager.destroy();
      // Re-create without calling ensureProtocol
      manager = new WSLSessionManager(host, logger);

      await expect(manager.sendInput('wsl-si', 'ls')).rejects.toThrow(
        'WSL protocol not initialized'
      );
    });

    it('should call executeCommand on the protocol', async () => {
      await manager.sendInput('wsl-si', 'echo hello');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith('wsl-si', 'echo hello');
    });

    it('should buffer stdout output', async () => {
      mockProtocol.executeCommand.mockResolvedValueOnce({ stdout: 'output text', stderr: '' });
      const buffer: any[] = [];
      (host.getOutputBuffer as jest.Mock).mockReturnValue(buffer);

      await manager.sendInput('wsl-si', 'ls');

      expect(host.setOutputBuffer).toHaveBeenCalledWith(
        'wsl-si',
        expect.arrayContaining([
          expect.objectContaining({ type: 'stdout', data: 'output text' }),
        ])
      );
    });

    it('should buffer stderr output', async () => {
      mockProtocol.executeCommand.mockResolvedValueOnce({ stdout: '', stderr: 'error text' });
      const buffer: any[] = [];
      (host.getOutputBuffer as jest.Mock).mockReturnValue(buffer);

      await manager.sendInput('wsl-si', 'ls');

      expect(host.setOutputBuffer).toHaveBeenCalledWith(
        'wsl-si',
        expect.arrayContaining([
          expect.objectContaining({ type: 'stderr', data: 'error text' }),
        ])
      );
    });

    it('should emit output events for stdout', async () => {
      mockProtocol.executeCommand.mockResolvedValueOnce({ stdout: 'hello', stderr: '' });

      await manager.sendInput('wsl-si', 'echo hello');

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({ type: 'stdout', data: 'hello' })
      );
    });

    it('should emit output events for stderr', async () => {
      mockProtocol.executeCommand.mockResolvedValueOnce({ stdout: '', stderr: 'err' });

      await manager.sendInput('wsl-si', 'bad-cmd');

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({ type: 'stderr', data: 'err' })
      );
    });

    it('should skip stdout event when stdout is empty', async () => {
      mockProtocol.executeCommand.mockResolvedValueOnce({ stdout: '', stderr: 'err' });

      await manager.sendInput('wsl-si', 'bad-cmd');

      const calls = (host.emitTypedEvent as jest.Mock).mock.calls;
      const stdoutCalls = calls.filter(
        ([, data]) => data && data.type === 'stdout'
      );
      expect(stdoutCalls).toHaveLength(0);
    });

    it('should propagate errors from the protocol', async () => {
      mockProtocol.executeCommand.mockRejectedValueOnce(new Error('exec failed'));

      await expect(manager.sendInput('wsl-si', 'ls')).rejects.toThrow('exec failed');
    });
  });

  // -----------------------------------------------------------------------
  describe('resizeTerminal', () => {
    it('should call protocol.resizeTerminal when protocol is initialized', async () => {
      await manager.setupWSLIntegration();
      await manager.resizeTerminal('wsl-resize', 100, 30);

      expect(mockProtocol.resizeTerminal).toHaveBeenCalledWith('wsl-resize', 100, 30);
    });

    it('should be a no-op when protocol is not initialized', async () => {
      // No prior call to ensureProtocol
      await expect(manager.resizeTerminal('wsl-1', 80, 24)).resolves.toBeUndefined();
    });

    it('should be a no-op when protocol lacks resizeTerminal', async () => {
      (host.getOrCreateProtocol as jest.Mock).mockResolvedValueOnce({
        type: 'wsl',
        initialize: jest.fn().mockResolvedValue(undefined),
        // No resizeTerminal method
      });
      await manager.setupWSLIntegration();

      await expect(manager.resizeTerminal('wsl-1', 80, 24)).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe('getWSLDistributions', () => {
    it('should return distributions from protocol', async () => {
      const distros = [{ name: 'Ubuntu', version: '22.04', wslVersion: 2 }];
      mockProtocol.getInstalledDistributions.mockResolvedValueOnce(distros);

      const result = await manager.getWSLDistributions();

      expect(result).toBe(distros);
    });

    it('should propagate errors', async () => {
      mockProtocol.getInstalledDistributions.mockRejectedValueOnce(new Error('access denied'));

      await expect(manager.getWSLDistributions()).rejects.toThrow('access denied');
    });
  });

  // -----------------------------------------------------------------------
  describe('getWSLSystemInfo', () => {
    it('should return system info from protocol', async () => {
      const info = { wslVersion: '2.1', installedDistributions: [] };
      mockProtocol.getSystemInfo.mockResolvedValueOnce(info);

      const result = await manager.getWSLSystemInfo();

      expect(result).toBe(info);
    });

    it('should propagate errors', async () => {
      mockProtocol.getSystemInfo.mockRejectedValueOnce(new Error('wsl.exe not found'));

      await expect(manager.getWSLSystemInfo()).rejects.toThrow('wsl.exe not found');
    });
  });

  // -----------------------------------------------------------------------
  describe('startWSLDistribution', () => {
    it('should call startDistribution on the protocol', async () => {
      await manager.startWSLDistribution('Ubuntu');

      expect(mockProtocol.startDistribution).toHaveBeenCalledWith('Ubuntu');
    });

    it('should propagate errors', async () => {
      mockProtocol.startDistribution.mockRejectedValueOnce(new Error('already running'));

      await expect(manager.startWSLDistribution('Ubuntu')).rejects.toThrow('already running');
    });
  });

  // -----------------------------------------------------------------------
  describe('stopWSLDistribution', () => {
    it('should call stopDistribution on the protocol', async () => {
      await manager.stopWSLDistribution('Ubuntu');

      expect(mockProtocol.stopDistribution).toHaveBeenCalledWith('Ubuntu');
    });

    it('should propagate errors', async () => {
      mockProtocol.stopDistribution.mockRejectedValueOnce(new Error('not running'));

      await expect(manager.stopWSLDistribution('Ubuntu')).rejects.toThrow('not running');
    });
  });

  // -----------------------------------------------------------------------
  describe('getWSLHealthStatus', () => {
    it('should return health status from protocol', async () => {
      const status = { distribution: 'Ubuntu', status: 'healthy' };
      mockProtocol.getHealthStatus.mockResolvedValueOnce(status);

      const result = await manager.getWSLHealthStatus('Ubuntu');

      expect(result).toBe(status);
      expect(mockProtocol.getHealthStatus).toHaveBeenCalledWith('Ubuntu');
    });

    it('should propagate errors', async () => {
      mockProtocol.getHealthStatus.mockRejectedValueOnce(new Error('unreachable'));

      await expect(manager.getWSLHealthStatus('Ubuntu')).rejects.toThrow('unreachable');
    });
  });

  // -----------------------------------------------------------------------
  describe('translateWSLPath', () => {
    it('should translate windows-to-linux paths', async () => {
      mockProtocol.translatePath.mockResolvedValueOnce('/mnt/c/Users/test');

      const result = await manager.translateWSLPath('C:\\Users\\test', 'windows-to-linux');

      expect(result).toBe('/mnt/c/Users/test');
      expect(mockProtocol.translatePath).toHaveBeenCalledWith(
        'C:\\Users\\test',
        'windows-to-linux'
      );
    });

    it('should translate linux-to-windows paths', async () => {
      mockProtocol.translatePath.mockResolvedValueOnce('C:\\Users\\test');

      const result = await manager.translateWSLPath('/mnt/c/Users/test', 'linux-to-windows');

      expect(result).toBe('C:\\Users\\test');
    });

    it('should propagate errors', async () => {
      mockProtocol.translatePath.mockRejectedValueOnce(new Error('invalid path'));

      await expect(
        manager.translateWSLPath('/bad', 'linux-to-windows')
      ).rejects.toThrow('invalid path');
    });
  });

  // -----------------------------------------------------------------------
  describe('isWSLAvailable', () => {
    it('should return true when WSL is available', async () => {
      mockProtocol.checkWSLAvailability.mockResolvedValueOnce(true);

      const result = await manager.isWSLAvailable();

      expect(result).toBe(true);
    });

    it('should return false when WSL is not available', async () => {
      mockProtocol.checkWSLAvailability.mockResolvedValueOnce(false);

      const result = await manager.isWSLAvailable();

      expect(result).toBe(false);
    });

    it('should return false (not throw) on protocol error', async () => {
      (host.getOrCreateProtocol as jest.Mock).mockRejectedValueOnce(
        new Error('WSL not installed')
      );

      const result = await manager.isWSLAvailable();

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should return false when checkWSLAvailability throws', async () => {
      mockProtocol.checkWSLAvailability.mockRejectedValueOnce(new Error('wsl.exe missing'));

      const result = await manager.isWSLAvailable();

      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  describe('getWSLConfig', () => {
    it('should return config from protocol', async () => {
      const config = { global: { memory: '8GB' }, distributions: {} };
      mockProtocol.getWSLConfig.mockResolvedValueOnce(config);

      const result = await manager.getWSLConfig();

      expect(result).toBe(config);
    });

    it('should propagate errors', async () => {
      mockProtocol.getWSLConfig.mockRejectedValueOnce(new Error('config not found'));

      await expect(manager.getWSLConfig()).rejects.toThrow('config not found');
    });
  });

  // -----------------------------------------------------------------------
  describe('destroy', () => {
    it('should clean up the protocol via cleanup()', async () => {
      await manager.setupWSLIntegration();

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should be safe to call on an uninitialized manager', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });

    it('should set protocol to null after destroy', async () => {
      await manager.setupWSLIntegration();
      await manager.destroy();

      // After destroy, resizeTerminal should be a no-op (protocol is null)
      await expect(manager.resizeTerminal('wsl-1', 80, 24)).resolves.toBeUndefined();
      expect(mockProtocol.resizeTerminal).not.toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      await manager.setupWSLIntegration();
      mockProtocol.cleanup.mockRejectedValueOnce(new Error('cleanup failed'));

      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
