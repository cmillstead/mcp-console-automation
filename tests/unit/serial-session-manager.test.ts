import { SerialSessionManager } from '../../src/core/SerialSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'serial' as const,
    capabilities: { supportsStreaming: true },
    createConnection: jest.fn().mockResolvedValue(undefined),
    sendData: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    discoverDevices: jest.fn().mockResolvedValue([
      { path: '/dev/ttyUSB0', isConnected: false, deviceType: 'arduino' },
    ]),
    getConnectionStatus: jest.fn().mockReturnValue({ connected: true }),
    performDeviceReset: jest.fn().mockResolvedValue(undefined),
    getOutputBuffer: jest.fn().mockReturnValue([{ data: 'test' }]),
    clearOutputBuffer: jest.fn(),
  });
}

function createMockHost(mockProtocol: any): ProtocolSessionHost {
  return {
    getSession: jest.fn().mockReturnValue({ id: 'test', status: 'running' }),
    setSession: jest.fn(),
    deleteSession: jest.fn(),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getMaxBufferSize: jest.fn().mockReturnValue(10000),
    createStreamManager: jest.fn().mockReturnValue({
      processOutput: jest.fn(),
    }),
    setStreamManager: jest.fn(),
    getStreamManager: jest.fn().mockReturnValue({
      processOutput: jest.fn(),
    }),
    deleteStreamManager: jest.fn(),
    updateSessionStatus: jest.fn().mockResolvedValue(undefined),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn(),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue({
      processOutput: jest.fn(),
      addPatterns: jest.fn(),
    }),
    addErrorPatterns: jest.fn(),
    getPromptDetector: jest.fn().mockReturnValue(null),
    getPaginationManager: jest.fn().mockReturnValue({
      removeSession: jest.fn(),
    }),
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

describe('SerialSessionManager', () => {
  let manager: SerialSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new SerialSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(SerialSessionManager);
    });
  });

  describe('createSession', () => {
    it('should create a serial session with explicit serial options', async () => {
      const session = { id: 'sess-1', status: 'starting' } as any;
      const options = {
        serialOptions: {
          path: '/dev/ttyUSB0',
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none' as const,
        },
      } as any;

      const result = await manager.createSession('sess-1', session, options);

      expect(result).toBe('sess-1');
      expect(host.getOrCreateProtocol).toHaveBeenCalledWith('serial');
      expect(mockProtocol.createConnection).toHaveBeenCalledWith('sess-1', options.serialOptions);
      expect(host.setSession).toHaveBeenCalledWith('sess-1', session);
      expect(host.setOutputBuffer).toHaveBeenCalledWith('sess-1', []);
      expect(host.setStreamManager).toHaveBeenCalled();
    });

    it('should auto-detect serial port when only console type specified', async () => {
      const session = { id: 'sess-2', status: 'starting' } as any;
      const options = { consoleType: 'serial' } as any;

      const result = await manager.createSession('sess-2', session, options);

      expect(result).toBe('sess-2');
      expect(mockProtocol.discoverDevices).toHaveBeenCalled();
      expect(mockProtocol.createConnection).toHaveBeenCalledWith(
        'sess-2',
        expect.objectContaining({
          path: '/dev/ttyUSB0',
          resetOnConnect: true, // arduino device type
        })
      );
    });

    it('should throw when no serial options and non-serial console type', async () => {
      const session = { id: 'sess-3', status: 'starting' } as any;
      const options = { consoleType: 'ssh' } as any;

      await expect(manager.createSession('sess-3', session, options)).rejects.toThrow(
        'Serial options or serial console type required'
      );
    });

    it('should throw when no available serial devices found', async () => {
      mockProtocol.discoverDevices.mockResolvedValue([
        { path: '/dev/ttyUSB0', isConnected: true },
      ]);

      const session = { id: 'sess-4', status: 'starting' } as any;
      const options = { consoleType: 'serial' } as any;

      await expect(manager.createSession('sess-4', session, options)).rejects.toThrow(
        'No available serial devices found'
      );
    });

    it('should add error patterns when detectErrors is not false', async () => {
      const session = { id: 'sess-5', status: 'starting' } as any;
      const options = {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any;

      await manager.createSession('sess-5', session, options);

      expect(host.addErrorPatterns).toHaveBeenCalled();
    });

    it('should clean up on creation failure', async () => {
      mockProtocol.createConnection.mockRejectedValue(new Error('Connection failed'));

      const session = { id: 'sess-6', status: 'starting' } as any;
      const options = {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any;

      await expect(manager.createSession('sess-6', session, options)).rejects.toThrow(
        'Connection failed'
      );
      expect(host.deleteSession).toHaveBeenCalledWith('sess-6');
    });
  });

  describe('sendInput', () => {
    it('should delegate to protocol.sendData', async () => {
      // Initialize the protocol first
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      await manager.sendInput('sess-1', 'hello\n');

      expect(mockProtocol.sendData).toHaveBeenCalledWith('sess-1', 'hello\n');
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          type: 'input',
          data: { input: 'hello\n' },
        })
      );
    });

    it('should throw if protocol not initialized', async () => {
      await expect(manager.sendInput('sess-1', 'test')).rejects.toThrow(
        'Serial protocol not initialized'
      );
    });
  });

  describe('getDefaultSerialErrorPatterns', () => {
    it('should return an array of error patterns', () => {
      const patterns = manager.getDefaultSerialErrorPatterns();

      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toHaveProperty('pattern');
      expect(patterns[0]).toHaveProperty('type');
      expect(patterns[0]).toHaveProperty('category', 'serial');
    });
  });

  describe('destroy', () => {
    it('should clean up protocol', async () => {
      // Initialize protocol
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProtocol.cleanup.mockRejectedValue(new Error('cleanup failed'));

      // Initialize protocol
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      // Should not throw
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });

  describe('discoverSerialDevices', () => {
    it('should delegate to protocol.discoverDevices', async () => {
      const result = await manager.discoverSerialDevices();

      expect(result).toEqual([
        { path: '/dev/ttyUSB0', isConnected: false, deviceType: 'arduino' },
      ]);
      expect(mockProtocol.discoverDevices).toHaveBeenCalled();
    });
  });

  describe('getSerialConnectionStatus', () => {
    it('should return null if protocol not initialized', () => {
      const result = manager.getSerialConnectionStatus('sess-1');
      expect(result).toBeNull();
    });

    it('should delegate to protocol when initialized', async () => {
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      const result = manager.getSerialConnectionStatus('sess-1');
      expect(result).toEqual({ connected: true });
    });
  });

  describe('resetSerialDevice', () => {
    it('should throw if protocol not initialized', async () => {
      await expect(manager.resetSerialDevice('sess-1')).rejects.toThrow(
        'Serial protocol not initialized'
      );
    });

    it('should delegate to protocol when initialized', async () => {
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      await manager.resetSerialDevice('sess-1');
      expect(mockProtocol.performDeviceReset).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('getSerialOutputBuffer', () => {
    it('should return empty array if protocol not initialized', () => {
      const result = manager.getSerialOutputBuffer('sess-1');
      expect(result).toEqual([]);
    });

    it('should delegate to protocol when initialized', async () => {
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      const result = manager.getSerialOutputBuffer('sess-1', 10);
      expect(mockProtocol.getOutputBuffer).toHaveBeenCalledWith('sess-1', 10);
    });
  });

  describe('clearSerialOutputBuffer', () => {
    it('should be a no-op if protocol not initialized', () => {
      expect(() => manager.clearSerialOutputBuffer('sess-1')).not.toThrow();
    });

    it('should delegate to protocol when initialized', async () => {
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      manager.clearSerialOutputBuffer('sess-1');
      expect(mockProtocol.clearOutputBuffer).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('cleanupSession', () => {
    it('should clean up session resources', async () => {
      await manager.createSession('sess-1', { id: 'sess-1' } as any, {
        serialOptions: { path: '/dev/ttyUSB0', baudRate: 9600 },
      } as any);

      await manager.cleanupSession('sess-1');

      expect(host.deleteSession).toHaveBeenCalledWith('sess-1');
      expect(mockProtocol.closeConnection).toHaveBeenCalledWith('sess-1');
      expect(host.deleteStreamManager).toHaveBeenCalledWith('sess-1');
    });
  });
});
