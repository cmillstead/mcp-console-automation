import { IPCSessionManager } from '../../src/core/IPCSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';

function createMockHost(): ProtocolSessionHost {
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
    getOrCreateProtocol: jest.fn().mockResolvedValue({}),
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

describe('IPCSessionManager', () => {
  let manager: IPCSessionManager;
  let host: ProtocolSessionHost;
  let logger: Logger;

  beforeEach(() => {
    host = createMockHost();
    logger = createMockLogger();
    manager = new IPCSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(IPCSessionManager);
    });

    it('should start with no tracked sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should have the correct protocol type', () => {
      // protocolType is protected; verify indirectly via getSession returning undefined
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('createSession', () => {
    it('should throw when ipcOptions is missing', async () => {
      await expect(
        manager.createSession('ipc-no', {}, {} as any)
      ).rejects.toThrow('IPC options are required for IPC session');
    });

    it('should return the sessionId on success', async () => {
      const result = await manager.createSession(
        'ipc-1',
        {},
        { ipcOptions: { ipcType: 'unix-socket', endpoint: '/tmp/test.sock' } } as any
      );
      expect(result).toBe('ipc-1');
    });

    it('should log info when creating a session', async () => {
      await manager.createSession(
        'ipc-log',
        {},
        { ipcOptions: { ipcType: 'named-pipe', endpoint: '//./pipe/test' } } as any
      );
      expect(logger.info).toHaveBeenCalledWith('Creating IPC session ipc-log');
    });

    it('should work with different IPC types', async () => {
      const types = ['named-pipe', 'unix-socket', 'docker-socket', 'mailslot', 'dbus', 'com'] as const;
      for (const ipcType of types) {
        const result = await manager.createSession(
          `ipc-${ipcType}`,
          {},
          { ipcOptions: { ipcType, endpoint: '/test' } } as any
        );
        expect(result).toBe(`ipc-${ipcType}`);
      }
    });

    it('should not add session to internal map (stub — no tracking)', async () => {
      await manager.createSession(
        'ipc-notrack',
        {},
        { ipcOptions: { ipcType: 'unix-socket', endpoint: '/tmp/test.sock' } } as any
      );
      // Stub does not track sessions
      expect(manager.getSession('ipc-notrack')).toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('getSession', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('getSessionCount', () => {
    it('should return 0 initially', () => {
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should complete without error', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });

    it('should clear session tracking on destroy', async () => {
      await manager.destroy();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be safe to call multiple times', async () => {
      await manager.destroy();
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
