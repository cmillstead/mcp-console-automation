import { RDPSessionManager } from '../../src/core/RDPSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'rdp' as const,
    capabilities: { supportsStreaming: false },
    createSession: jest.fn().mockResolvedValue({ sessionId: 'rdp-1' }),
    sendInput: jest.fn().mockResolvedValue(undefined),
    sendClipboardData: jest.fn().mockResolvedValue(undefined),
    startFileTransfer: jest.fn().mockResolvedValue('transfer-123'),
    getCapabilities: jest.fn().mockReturnValue({ supportsClipboard: true }),
    disconnectSession: jest.fn().mockResolvedValue(undefined),
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
  return logger;
}

describe('RDPSessionManager', () => {
  let manager: RDPSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new RDPSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(RDPSessionManager);
    });
  });

  describe('createSession', () => {
    it('should throw when rdpOptions is missing', async () => {
      await expect(manager.createSession('rdp-no', {} as any)).rejects.toThrow(
        'RDP options are required for RDP session'
      );
    });

    it('should create an RDP session through the protocol', async () => {
      const options = {
        rdpOptions: {
          host: '10.0.0.1',
          port: 3389,
          username: 'admin',
          protocol: 'rdp',
        },
      } as any;

      const result = await manager.createSession('rdp-1', options);

      expect(result).toBe('rdp-1');
      expect(mockProtocol.createSession).toHaveBeenCalledWith({
        command: 'rdp',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
      });
      expect(host.getOrCreateProtocol).toHaveBeenCalledWith('rdp');
    });

    it('should update session status to running', async () => {
      const session = { id: 'rdp-2', status: 'starting' };
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.createSession('rdp-2', {
        rdpOptions: { host: '10.0.0.1', port: 3389, username: 'admin' },
      } as any);

      expect(session.status).toBe('running');
      expect(host.setSession).toHaveBeenCalledWith('rdp-2', session);
    });

    it('should update session status via host', async () => {
      await manager.createSession('rdp-3', {
        rdpOptions: { host: '10.0.0.1', port: 3389, username: 'admin', protocol: 'rdp' },
      } as any);

      expect(host.updateSessionStatus).toHaveBeenCalledWith('rdp-3', 'running', {
        rdpHost: '10.0.0.1',
        rdpPort: 3389,
        protocol: 'rdp',
      });
    });

    it('should mark session as crashed on error', async () => {
      const session = { id: 'rdp-fail', status: 'starting' };
      (host.getSession as jest.Mock).mockReturnValue(session);
      mockProtocol.createSession.mockRejectedValue(new Error('connection refused'));

      await expect(
        manager.createSession('rdp-fail', {
          rdpOptions: { host: '10.0.0.1', port: 3389, username: 'admin' },
        } as any)
      ).rejects.toThrow('connection refused');

      expect(session.status).toBe('crashed');
    });

    it('should propagate errors from protocol', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('auth failed'));

      await expect(
        manager.createSession('rdp-fail', {
          rdpOptions: { host: '10.0.0.1', port: 3389, username: 'admin' },
        } as any)
      ).rejects.toThrow('auth failed');
    });
  });

  describe('sendInput', () => {
    it('should send input through the protocol', async () => {
      await manager.sendInput('rdp-in', 'hello');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('rdp-in', 'hello');
    });

    it('should propagate errors', async () => {
      mockProtocol.sendInput.mockRejectedValue(new Error('timeout'));

      await expect(manager.sendInput('rdp-in', 'test')).rejects.toThrow('timeout');
    });
  });

  describe('sendClipboardData', () => {
    it('should send clipboard data through the protocol', async () => {
      await manager.sendClipboardData('rdp-clip', 'paste-text', 'text');

      expect(mockProtocol.sendClipboardData).toHaveBeenCalledWith(
        'rdp-clip',
        'paste-text',
        'text'
      );
    });

    it('should default format to text', async () => {
      await manager.sendClipboardData('rdp-clip', 'paste-text');

      expect(mockProtocol.sendClipboardData).toHaveBeenCalledWith(
        'rdp-clip',
        'paste-text',
        'text'
      );
    });

    it('should propagate errors', async () => {
      mockProtocol.sendClipboardData.mockRejectedValue(new Error('clipboard error'));

      await expect(
        manager.sendClipboardData('rdp-clip', 'data', 'text')
      ).rejects.toThrow('clipboard error');
    });
  });

  describe('startFileTransfer', () => {
    it('should start a file transfer through the protocol', async () => {
      const result = await manager.startFileTransfer(
        'rdp-ft',
        '/local/file.txt',
        'C:\\remote\\file.txt',
        'upload'
      );

      expect(result).toBe('transfer-123');
      expect(mockProtocol.startFileTransfer).toHaveBeenCalledWith(
        'rdp-ft',
        '/local/file.txt',
        'C:\\remote\\file.txt',
        'upload'
      );
    });

    it('should propagate errors', async () => {
      mockProtocol.startFileTransfer.mockRejectedValue(new Error('transfer failed'));

      await expect(
        manager.startFileTransfer('rdp-ft', '/a', '/b', 'download')
      ).rejects.toThrow('transfer failed');
    });
  });

  describe('getSession', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });

    it('should return session after connected event', async () => {
      // Initialize protocol to set up handlers
      await manager.sendInput('rdp-init', 'test');

      const rdpSession = {
        sessionId: 'rdp-s1',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date(),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);

      expect(manager.getSession('rdp-s1')).toBe(rdpSession);
    });
  });

  describe('getCapabilities', () => {
    it('should return capabilities from the protocol', async () => {
      const result = await manager.getCapabilities();
      expect(result).toEqual({ supportsClipboard: true });
    });
  });

  describe('disconnectSession', () => {
    it('should disconnect through the protocol', async () => {
      await manager.disconnectSession('rdp-dc');

      expect(mockProtocol.disconnectSession).toHaveBeenCalledWith('rdp-dc');
    });

    it('should remove session from tracking after disconnect', async () => {
      // Initialize and add session via connected event
      await manager.sendInput('rdp-init', 'test');
      const rdpSession = {
        sessionId: 'rdp-dc2',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date(),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);
      expect(manager.getSession('rdp-dc2')).toBeDefined();

      await manager.disconnectSession('rdp-dc2');
      expect(manager.getSession('rdp-dc2')).toBeUndefined();
    });

    it('should propagate errors', async () => {
      mockProtocol.disconnectSession.mockRejectedValue(new Error('already disconnected'));

      await expect(manager.disconnectSession('rdp-dc')).rejects.toThrow(
        'already disconnected'
      );
    });
  });

  describe('setupEventHandlers', () => {
    it('should emit rdp-connected on connected event', async () => {
      await manager.createSession('rdp-evt', {
        rdpOptions: { host: '10.0.0.1', port: 3389, username: 'admin' },
      } as any);

      const rdpSession = {
        sessionId: 'rdp-evt',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date(),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('rdp-connected', {
        sessionId: 'rdp-evt',
        session: rdpSession,
      });
    });

    it('should emit rdp-disconnected on disconnected event', async () => {
      await manager.sendInput('rdp-init', 'test');

      mockProtocol.emit('disconnected', 'rdp-dc', 'user requested');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('rdp-disconnected', {
        sessionId: 'rdp-dc',
        reason: 'user requested',
      });
    });

    it('should remove session from tracking on disconnected event', async () => {
      await manager.sendInput('rdp-init', 'test');

      const rdpSession = {
        sessionId: 'rdp-rm',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date(),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);
      expect(manager.getSession('rdp-rm')).toBeDefined();

      mockProtocol.emit('disconnected', 'rdp-rm', 'timeout');
      expect(manager.getSession('rdp-rm')).toBeUndefined();
    });

    it('should emit rdp-error on error event', async () => {
      await manager.sendInput('rdp-init', 'test');

      const error = new Error('protocol error');
      mockProtocol.emit('error', 'rdp-err', error);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('rdp-error', {
        sessionId: 'rdp-err',
        error,
      });
    });

    it('should handle output events and buffer them', async () => {
      await manager.sendInput('rdp-init', 'test');

      const output = { sessionId: 'rdp-out', type: 'stdout', data: 'hello' };
      mockProtocol.emit('output', output);

      expect(host.setOutputBuffer).toHaveBeenCalled();
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'rdp-out',
          type: 'output',
          data: output,
        })
      );
    });

    it('should update lastActivity on output for tracked sessions', async () => {
      await manager.sendInput('rdp-init', 'test');

      const rdpSession = {
        sessionId: 'rdp-act',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date('2020-01-01'),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);

      const output = { sessionId: 'rdp-act', type: 'stdout', data: 'data' };
      mockProtocol.emit('output', output);

      const updatedSession = manager.getSession('rdp-act');
      expect(updatedSession!.lastActivity.getTime()).toBeGreaterThan(
        new Date('2020-01-01').getTime()
      );
    });

    it('should emit rdp-screen-update on screen-update event', async () => {
      await manager.sendInput('rdp-init', 'test');

      const imageData = Buffer.from('screenshot-data');
      mockProtocol.emit('screen-update', 'rdp-scr', imageData);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('rdp-screen-update', {
        sessionId: 'rdp-scr',
        imageData,
      });
    });

    it('should emit rdp-clipboard-data on clipboard-data event', async () => {
      await manager.sendInput('rdp-init', 'test');

      mockProtocol.emit('clipboard-data', 'rdp-cb', 'pasted', 'text');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('rdp-clipboard-data', {
        sessionId: 'rdp-cb',
        data: 'pasted',
        format: 'text',
      });
    });

    it('should emit rdp-file-transfer-progress on file-transfer-progress event', async () => {
      await manager.sendInput('rdp-init', 'test');

      const progress = { percent: 50, bytesTransferred: 1024 };
      mockProtocol.emit('file-transfer-progress', 'rdp-ftp', progress);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'rdp-file-transfer-progress',
        { sessionId: 'rdp-ftp', progress }
      );
    });

    it('should emit rdp-performance-metrics on performance-metrics event', async () => {
      await manager.sendInput('rdp-init', 'test');

      const metrics = { latency: 15, fps: 30 };
      mockProtocol.emit('performance-metrics', 'rdp-perf', metrics);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'rdp-performance-metrics',
        { sessionId: 'rdp-perf', metrics }
      );
    });
  });

  describe('destroy', () => {
    it('should clean up protocol and session tracking', async () => {
      // Initialize protocol and add a session
      await manager.sendInput('rdp-d', 'test');
      const rdpSession = {
        sessionId: 'rdp-d',
        connectionId: 'conn-1',
        host: '10.0.0.1',
        port: 3389,
        username: 'admin',
        protocol: 'rdp',
        connectionTime: new Date(),
        lastActivity: new Date(),
        status: 'connected' as const,
      };
      mockProtocol.emit('connected', rdpSession);
      expect(manager.getSession('rdp-d')).toBeDefined();

      await manager.destroy();

      expect(manager.getSession('rdp-d')).toBeUndefined();
      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProtocol.cleanup.mockRejectedValue(new Error('cleanup failed'));

      await manager.sendInput('rdp-d2', 'test');

      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
