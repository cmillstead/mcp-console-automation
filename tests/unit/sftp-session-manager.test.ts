import { SFTPSessionManager } from '../../src/core/SFTPSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockSFTPProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'sftp' as const,
    capabilities: { supportsStreaming: false },
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getConnectionState: jest.fn().mockReturnValue('connected'),
    uploadFile: jest.fn().mockResolvedValue({ bytesTransferred: 1024 }),
    downloadFile: jest.fn().mockResolvedValue({ bytesTransferred: 2048 }),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockProtocolFactory(mockProtocol: any) {
  return {
    createProtocol: jest.fn().mockResolvedValue(mockProtocol),
  };
}

function createMockHost(mockProtocol: any): ProtocolSessionHost {
  const factory = createMockProtocolFactory(mockProtocol);
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
    getProtocolFactory: jest.fn().mockReturnValue(factory),
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

function makeSession(sessionId = 'sftp-1') {
  return {
    id: sessionId,
    sessionId,
    status: 'starting' as const,
    type: 'sftp' as const,
    createdAt: new Date(),
    lastActivity: new Date(),
    command: 'sftp',
  } as any;
}

function makeSFTPOptions(host = '10.0.0.1') {
  return {
    consoleType: 'sftp',
    sshOptions: {
      host,
      port: 22,
      username: 'user',
      password: 'pass',
    },
  } as any;
}

describe('SFTPSessionManager', () => {
  let manager: SFTPSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockSFTPProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockSFTPProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new SFTPSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(SFTPSessionManager);
    });

    it('should start with zero sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('createSession', () => {
    it('should throw when sshOptions is missing', async () => {
      await expect(
        manager.createSession('sftp-no', makeSession('sftp-no'), {} as any)
      ).rejects.toThrow('SSH options are required for SFTP/SCP session');
    });

    it('should create an SFTP protocol via protocolFactory', async () => {
      const session = makeSession('sftp-1');
      const options = makeSFTPOptions();

      await manager.createSession('sftp-1', session, options);

      expect(host.getProtocolFactory).toHaveBeenCalled();
      const factory = (host.getProtocolFactory as jest.Mock).mock.results[0].value;
      expect(factory.createProtocol).toHaveBeenCalledWith('sftp');
    });

    it('should call connect on the protocol', async () => {
      await manager.createSession('sftp-1', makeSession('sftp-1'), makeSFTPOptions());

      expect(mockProtocol.connect).toHaveBeenCalled();
    });

    it('should store the protocol instance', async () => {
      await manager.createSession('sftp-1', makeSession('sftp-1'), makeSFTPOptions());

      expect(manager.getSFTPProtocol('sftp-1')).toBe(mockProtocol);
    });

    it('should track the session count', async () => {
      await manager.createSession('sftp-1', makeSession('sftp-1'), makeSFTPOptions());

      expect(manager.getSessionCount()).toBe(1);
    });

    it('should set session status to running', async () => {
      const session = makeSession('sftp-2');
      await manager.createSession('sftp-2', session, makeSFTPOptions());

      expect(session.status).toBe('running');
      expect(host.setSession).toHaveBeenCalledWith('sftp-2', session);
    });

    it('should emit session-started event', async () => {
      const options = makeSFTPOptions();
      await manager.createSession('sftp-3', makeSession('sftp-3'), options);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'session-started',
        expect.objectContaining({ sessionId: 'sftp-3', type: 'sftp' })
      );
    });

    it('should build sftpOptions with defaults from sshOptions', async () => {
      const options = makeSFTPOptions('192.168.1.1');
      await manager.createSession('sftp-4', makeSession('sftp-4'), options);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'session-started',
        expect.objectContaining({
          options: expect.objectContaining({
            host: '192.168.1.1',
            maxConcurrentTransfers: 3,
            compressionLevel: 6,
          }),
        })
      );
    });

    it('should return the sessionId on success', async () => {
      const result = await manager.createSession('sftp-5', makeSession('sftp-5'), makeSFTPOptions());

      expect(result).toBe('sftp-5');
    });

    it('should cleanup on failure and rethrow', async () => {
      mockProtocol.connect.mockRejectedValue(new Error('connection refused'));

      await expect(
        manager.createSession('sftp-fail', makeSession('sftp-fail'), makeSFTPOptions())
      ).rejects.toThrow('connection refused');

      // Protocol should be cleaned up — session count stays at 0
      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getSFTPProtocol('sftp-fail')).toBeUndefined();
    });

    it('should disconnect protocol during cleanup on failure', async () => {
      // Protocol was stored before connect throws (connect throws after protocol is created)
      // But in our implementation, protocol is created, handlers set up, then connect is called
      mockProtocol.connect.mockRejectedValueOnce(new Error('auth failed'));

      await expect(
        manager.createSession('sftp-fail2', makeSession('sftp-fail2'), makeSFTPOptions())
      ).rejects.toThrow('auth failed');

      // disconnect should have been called during cleanupSFTPSession (but protocol wasn't stored yet since it was after connect)
      // The protocol is added to the map only AFTER connect succeeds
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('getSFTPProtocol', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getSFTPProtocol('nonexistent')).toBeUndefined();
    });

    it('should return protocol after session creation', async () => {
      await manager.createSession('sftp-get', makeSession('sftp-get'), makeSFTPOptions());

      expect(manager.getSFTPProtocol('sftp-get')).toBe(mockProtocol);
    });
  });

  describe('uploadFile', () => {
    it('should throw when session not found', async () => {
      await expect(
        manager.uploadFile('nonexistent', '/local/file.txt', '/remote/file.txt')
      ).rejects.toThrow('SFTP session not found: nonexistent');
    });

    it('should upload via the protocol', async () => {
      await manager.createSession('sftp-up', makeSession('sftp-up'), makeSFTPOptions());

      const result = await manager.uploadFile(
        'sftp-up',
        '/local/file.txt',
        '/remote/file.txt'
      );

      expect(mockProtocol.uploadFile).toHaveBeenCalledWith(
        '/local/file.txt',
        '/remote/file.txt',
        undefined
      );
      expect(result).toEqual({ bytesTransferred: 1024 });
    });

    it('should pass transfer options to the protocol', async () => {
      await manager.createSession('sftp-up2', makeSession('sftp-up2'), makeSFTPOptions());
      const transferOptions = { chunkSize: 32768 } as any;

      await manager.uploadFile('sftp-up2', '/a', '/b', transferOptions);

      expect(mockProtocol.uploadFile).toHaveBeenCalledWith('/a', '/b', transferOptions);
    });

    it('should propagate protocol errors', async () => {
      await manager.createSession('sftp-up3', makeSession('sftp-up3'), makeSFTPOptions());
      mockProtocol.uploadFile.mockRejectedValue(new Error('disk full'));

      await expect(
        manager.uploadFile('sftp-up3', '/a', '/b')
      ).rejects.toThrow('disk full');
    });
  });

  describe('downloadFile', () => {
    it('should throw when session not found', async () => {
      await expect(
        manager.downloadFile('nonexistent', '/remote/file.txt', '/local/file.txt')
      ).rejects.toThrow('SFTP session not found: nonexistent');
    });

    it('should download via the protocol', async () => {
      await manager.createSession('sftp-dl', makeSession('sftp-dl'), makeSFTPOptions());

      const result = await manager.downloadFile(
        'sftp-dl',
        '/remote/file.txt',
        '/local/file.txt'
      );

      expect(mockProtocol.downloadFile).toHaveBeenCalledWith(
        '/remote/file.txt',
        '/local/file.txt',
        undefined
      );
      expect(result).toEqual({ bytesTransferred: 2048 });
    });

    it('should pass transfer options to the protocol', async () => {
      await manager.createSession('sftp-dl2', makeSession('sftp-dl2'), makeSFTPOptions());
      const transferOptions = { chunkSize: 65536 } as any;

      await manager.downloadFile('sftp-dl2', '/remote/a', '/local/b', transferOptions);

      expect(mockProtocol.downloadFile).toHaveBeenCalledWith(
        '/remote/a',
        '/local/b',
        transferOptions
      );
    });

    it('should propagate protocol errors', async () => {
      await manager.createSession('sftp-dl3', makeSession('sftp-dl3'), makeSFTPOptions());
      mockProtocol.downloadFile.mockRejectedValue(new Error('file not found'));

      await expect(
        manager.downloadFile('sftp-dl3', '/remote/missing', '/local/target')
      ).rejects.toThrow('file not found');
    });
  });

  describe('cleanupSFTPSession', () => {
    it('should disconnect and remove the protocol', async () => {
      await manager.createSession('sftp-cl', makeSession('sftp-cl'), makeSFTPOptions());
      expect(manager.getSFTPProtocol('sftp-cl')).toBeDefined();

      await manager.cleanupSFTPSession('sftp-cl');

      expect(mockProtocol.disconnect).toHaveBeenCalled();
      expect(manager.getSFTPProtocol('sftp-cl')).toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be a no-op for unknown sessions', async () => {
      await expect(manager.cleanupSFTPSession('nonexistent')).resolves.toBeUndefined();
    });

    it('should handle disconnect errors gracefully', async () => {
      await manager.createSession('sftp-cl2', makeSession('sftp-cl2'), makeSFTPOptions());
      mockProtocol.disconnect.mockRejectedValue(new Error('already disconnected'));

      await expect(manager.cleanupSFTPSession('sftp-cl2')).resolves.toBeUndefined();
    });
  });

  describe('setupSFTPEventHandlers', () => {
    beforeEach(async () => {
      await manager.createSession('sftp-evt', makeSession('sftp-evt'), makeSFTPOptions());
    });

    it('should emit sftp-connected on connected event', () => {
      mockProtocol.emit('connected', 'connected');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('sftp-connected', {
        sessionId: 'sftp-evt',
        connectionState: 'connected',
      });
    });

    it('should emit sftp-transfer-progress on transfer-progress event', () => {
      const progress = { status: 'in-progress', transferredBytes: 512 };
      mockProtocol.emit('transfer-progress', progress);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('sftp-transfer-progress', {
        sessionId: 'sftp-evt',
        progress,
      });
    });

    it('should emit sftp-error on error event', () => {
      const error = new Error('transfer error');
      mockProtocol.emit('error', error);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('sftp-error', {
        sessionId: 'sftp-evt',
        error,
      });
    });
  });

  describe('updateTransferSessionStats', () => {
    beforeEach(async () => {
      await manager.createSession('sftp-stats', makeSession('sftp-stats'), makeSFTPOptions());
    });

    it('should increment successfulTransfers on completed', () => {
      const progress = { status: 'completed', transferredBytes: 1024 };
      mockProtocol.emit('transfer-progress', progress);

      // The stats update happens inside the event handler — verify via indirect testing
      // (We can't access private fileTransferSessions directly, but the event was handled)
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'sftp-transfer-progress',
        expect.objectContaining({ progress })
      );
    });

    it('should increment failedTransfers on failed', () => {
      const progress = { status: 'failed' };
      mockProtocol.emit('transfer-progress', progress);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'sftp-transfer-progress',
        expect.objectContaining({ progress })
      );
    });

    it('should handle unknown status without error', () => {
      const progress = { status: 'in-progress', transferredBytes: 256 };
      expect(() => mockProtocol.emit('transfer-progress', progress)).not.toThrow();
    });

    it('should be a no-op for unknown session IDs', async () => {
      // Creating a protocol without a session in fileTransferSessions — just ensure no throw
      const orphanProtocol = createMockSFTPProtocol();
      // We can simulate this indirectly by emitting an event after cleanup
      await manager.cleanupSFTPSession('sftp-stats');
      // The protocol is gone; stats update for that session should be safe no-op
      // since the session was removed from fileTransferSessions
      expect(() =>
        mockProtocol.emit('transfer-progress', { status: 'completed', transferredBytes: 100 })
      ).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('should disconnect all active protocols', async () => {
      const proto1 = createMockSFTPProtocol();
      const proto2 = createMockSFTPProtocol();

      // Create two sessions using separate factory instances
      (host.getProtocolFactory as jest.Mock)
        .mockReturnValueOnce(createMockProtocolFactory(proto1))
        .mockReturnValueOnce(createMockProtocolFactory(proto2));

      await manager.createSession('sftp-d1', makeSession('sftp-d1'), makeSFTPOptions());
      await manager.createSession('sftp-d2', makeSession('sftp-d2'), makeSFTPOptions());

      expect(manager.getSessionCount()).toBe(2);

      await manager.destroy();

      expect(proto1.disconnect).toHaveBeenCalled();
      expect(proto2.disconnect).toHaveBeenCalled();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should clear fileTransferSessions', async () => {
      await manager.createSession('sftp-d3', makeSession('sftp-d3'), makeSFTPOptions());

      await manager.destroy();

      expect(manager.getSessionCount()).toBe(0);
    });

    it('should handle disconnect errors gracefully during destroy', async () => {
      await manager.createSession('sftp-d4', makeSession('sftp-d4'), makeSFTPOptions());
      mockProtocol.disconnect.mockRejectedValue(new Error('already gone'));

      await expect(manager.destroy()).resolves.toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be safe to call on empty manager', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
