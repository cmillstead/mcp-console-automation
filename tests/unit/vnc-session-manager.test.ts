import { VNCSessionManager, VNCSessionHost } from '../../src/core/VNCSessionManager';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockVNCProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'vnc' as const,
    capabilities: { supportsStreaming: false },
    createSession: jest.fn().mockResolvedValue({
      connectionId: 'conn-1',
      serverName: 'Test VNC Server',
      supportedEncodings: ['raw', 'zrle'],
      serverCapabilities: {
        cursorShapeUpdates: true,
        richCursor: false,
        desktopResize: true,
        continuousUpdates: false,
        fence: false,
        fileTransfer: false,
        clipboardTransfer: true,
        audio: false,
      },
    }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockProtocolFactory(mockProtocol: any) {
  return {
    createProtocol: jest.fn().mockResolvedValue(mockProtocol),
  };
}

function createMockHost(mockProtocol: any): VNCSessionHost {
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
    getStreamManager: jest.fn().mockReturnValue(undefined),
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
    getNextSequenceNumber: jest.fn().mockReturnValue(0),
    getLogger: jest.fn().mockReturnValue(new Logger('test')),
    handleSessionError: jest.fn().mockResolvedValue(false),
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

function makeSession(sessionId = 'vnc-1') {
  return {
    id: sessionId,
    sessionId,
    status: 'starting' as const,
    type: 'vnc' as const,
    createdAt: new Date(),
    lastActivity: new Date(),
    command: 'vnc',
  } as any;
}

function makeVNCOptions(host = '192.168.1.100') {
  return {
    consoleType: 'vnc',
    vncOptions: {
      host,
      port: 5900,
      rfbProtocolVersion: '3.8',
      authMethod: 'vnc',
      encoding: ['zrle', 'raw'],
      compressionLevel: 6,
      sharedConnection: false,
      viewOnly: false,
      monitors: [{ id: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080 }],
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VNCSessionManager', () => {
  let manager: VNCSessionManager;
  let host: VNCSessionHost;
  let mockProtocol: ReturnType<typeof createMockVNCProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockVNCProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new VNCSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(VNCSessionManager);
    });

    it('should start with zero sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should start with no tracked VNC sessions', () => {
      expect(manager.getVNCSession('nonexistent')).toBeUndefined();
    });

    it('should start with no framebuffers', () => {
      expect(manager.getFramebuffer('nonexistent')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('createSession', () => {
    it('should throw when vncOptions is missing', async () => {
      await expect(
        manager.createSession('vnc-fail', makeSession('vnc-fail'), {} as any)
      ).rejects.toThrow('VNC options are required for VNC session');
    });

    it('should create a protocol via protocolFactory', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(host.getProtocolFactory).toHaveBeenCalled();
      const factory = (host.getProtocolFactory as jest.Mock).mock.results[0].value;
      expect(factory.createProtocol).toHaveBeenCalledWith('vnc');
    });

    it('should call createSession on the protocol', async () => {
      const options = makeVNCOptions();
      await manager.createSession('vnc-1', makeSession(), options);

      expect(mockProtocol.createSession).toHaveBeenCalledWith(options);
    });

    it('should store the protocol instance', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(manager.getVNCProtocol('vnc-1')).toBe(mockProtocol);
    });

    it('should increment session count', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(manager.getSessionCount()).toBe(1);
    });

    it('should build VNCSession state with defaults', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-1');
      expect(vncSession).toBeDefined();
      expect(vncSession!.sessionId).toBe('vnc-1');
      expect(vncSession!.host).toBe('192.168.1.100');
      expect(vncSession!.port).toBe(5900);
      expect(vncSession!.status).toBe('connected');
      expect(vncSession!.serverName).toBe('Test VNC Server');
    });

    it('should use protocol response for connectionId', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-1');
      expect(vncSession!.connectionId).toBe('conn-1');
    });

    it('should fall back to sessionId when connectionId not in response', async () => {
      mockProtocol.createSession.mockResolvedValueOnce({});
      await manager.createSession('vnc-fallback', makeSession('vnc-fallback'), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-fallback');
      expect(vncSession!.connectionId).toBe('vnc-fallback');
    });

    it('should populate serverCapabilities from protocol response', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-1');
      expect(vncSession!.serverCapabilities.clipboardTransfer).toBe(true);
    });

    it('should use default serverCapabilities when missing from response', async () => {
      mockProtocol.createSession.mockResolvedValueOnce({});
      await manager.createSession('vnc-def', makeSession('vnc-def'), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-def');
      expect(vncSession!.serverCapabilities.clipboardTransfer).toBe(false);
    });

    it('should use default port 5900 when not specified', async () => {
      const options = { consoleType: 'vnc', vncOptions: { host: 'host', authMethod: 'vnc' } } as any;
      await manager.createSession('vnc-port', makeSession('vnc-port'), options);

      expect(manager.getVNCSession('vnc-port')!.port).toBe(5900);
    });

    it('should initialise framebuffer', async () => {
      const options = makeVNCOptions();
      await manager.createSession('vnc-fb', makeSession('vnc-fb'), options);

      const fb = manager.getFramebuffer('vnc-fb');
      expect(fb).toBeDefined();
      expect(fb!.encoding).toEqual(['zrle', 'raw']);
      expect(fb!.compressionLevel).toBe(6);
      expect(fb!.data).toBeInstanceOf(Buffer);
    });

    it('should use default framebuffer encoding when not specified', async () => {
      const options = { consoleType: 'vnc', vncOptions: { host: 'host', authMethod: 'vnc' } } as any;
      await manager.createSession('vnc-fb2', makeSession('vnc-fb2'), options);

      const fb = manager.getFramebuffer('vnc-fb2');
      expect(fb!.encoding).toEqual(['raw']);
    });

    it('should set session status to running via host', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(host.setSession).toHaveBeenCalledWith(
        'vnc-1',
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should initialise output buffer via host', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(host.setOutputBuffer).toHaveBeenCalledWith('vnc-1', []);
    });

    it('should call updateSessionStatus with running', async () => {
      const options = makeVNCOptions();
      await manager.createSession('vnc-1', makeSession(), options);

      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'vnc-1',
        'running',
        expect.objectContaining({
          vncHost: '192.168.1.100',
          vncPort: 5900,
        })
      );
    });

    it('should emit started event', async () => {
      const options = makeVNCOptions();
      await manager.createSession('vnc-1', makeSession(), options);

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'vnc-1',
          type: 'started',
          data: expect.objectContaining({ vnc: true }),
        })
      );
    });

    it('should set up streaming when options.streaming is true', async () => {
      const options = { ...makeVNCOptions(), streaming: true };
      await manager.createSession('vnc-stream', makeSession('vnc-stream'), options);

      expect(host.setStreamManager).toHaveBeenCalledWith('vnc-stream', expect.anything());
    });

    it('should not set up streaming when options.streaming is false', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      expect(host.setStreamManager).not.toHaveBeenCalled();
    });

    it('should return the sessionId on success', async () => {
      const result = await manager.createSession('vnc-ret', makeSession('vnc-ret'), makeVNCOptions());

      expect(result).toBe('vnc-ret');
    });

    it('should clean up protocol on failure', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('connection refused'));

      await expect(
        manager.createSession('vnc-fail', makeSession('vnc-fail'), makeVNCOptions())
      ).rejects.toThrow('connection refused');

      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getVNCProtocol('vnc-fail')).toBeUndefined();
      expect(manager.getVNCSession('vnc-fail')).toBeUndefined();
      expect(manager.getFramebuffer('vnc-fail')).toBeUndefined();
    });

    it('should set session status to crashed on failure', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('auth failure'));

      await expect(
        manager.createSession('vnc-crash', makeSession('vnc-crash'), makeVNCOptions())
      ).rejects.toThrow('auth failure');

      expect(host.setSession).toHaveBeenCalledWith(
        'vnc-crash',
        expect.objectContaining({ status: 'crashed' })
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('setupVNCEventHandlers', () => {
    const SESSION = 'vnc-evt';

    beforeEach(async () => {
      await manager.createSession(SESSION, makeSession(SESSION), makeVNCOptions());
      // Reset call counts for cleaner assertions
      jest.clearAllMocks();
      // Restore output buffer mock after clearAllMocks
      (host.getOutputBuffer as jest.Mock).mockReturnValue([]);
    });

    it('should update framebuffer and emit event on framebuffer-update', () => {
      const update = {
        data: Buffer.from([1, 2, 3]),
        width: 1920,
        height: 1080,
        encoding: 'zrle',
      };
      mockProtocol.emit('framebuffer-update', update);

      const fb = manager.getFramebuffer(SESSION);
      expect(fb!.data).toEqual(update.data);

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION,
          type: 'vnc-framebuffer-update',
          data: expect.objectContaining({
            width: 1920,
            height: 1080,
            encoding: 'zrle',
          }),
        })
      );
    });

    it('should be a no-op for framebuffer-update when session is unknown', () => {
      // Remove framebuffer to simulate unknown session
      (manager as any).vncFramebuffers.delete(SESSION);

      expect(() =>
        mockProtocol.emit('framebuffer-update', {
          data: Buffer.alloc(0),
          width: 0,
          height: 0,
          encoding: 'raw',
        })
      ).not.toThrow();

      expect(host.emitEvent).not.toHaveBeenCalled();
    });

    it('should buffer server-message output and emit typed event', () => {
      const existingBuffer: any[] = [];
      (host.getOutputBuffer as jest.Mock).mockReturnValue(existingBuffer);

      mockProtocol.emit('server-message', { text: 'Hello from server' });

      expect(host.setOutputBuffer).toHaveBeenCalledWith(
        SESSION,
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: SESSION,
            type: 'stdout',
            data: 'Hello from server',
          }),
        ])
      );

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({ sessionId: SESSION, type: 'stdout' })
      );
    });

    it('should JSON-stringify server-message when text field is absent', () => {
      mockProtocol.emit('server-message', { foo: 'bar' });

      expect(host.setOutputBuffer).toHaveBeenCalledWith(
        SESSION,
        expect.arrayContaining([
          expect.objectContaining({ data: JSON.stringify({ foo: 'bar' }) }),
        ])
      );
    });

    it('should emit vnc-clipboard-update on clipboard-update', () => {
      mockProtocol.emit('clipboard-update', 'clipboard content');

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION,
          type: 'vnc-clipboard-update',
          data: { content: 'clipboard content' },
        })
      );
    });

    it('should call host.handleSessionError on protocol error', () => {
      const error = new Error('VNC protocol error');
      mockProtocol.emit('error', error);

      expect(host.handleSessionError).toHaveBeenCalledWith(
        SESSION,
        error,
        'vnc-connection'
      );
    });

    it('should set session status to terminated on disconnect', () => {
      const session = { id: SESSION, status: 'running' };
      (host.getSession as jest.Mock).mockReturnValue(session);

      mockProtocol.emit('disconnect');

      expect(host.setSession).toHaveBeenCalledWith(
        SESSION,
        expect.objectContaining({ status: 'terminated' })
      );
    });

    it('should emit terminated event on disconnect', () => {
      (host.getSession as jest.Mock).mockReturnValue({ id: SESSION, status: 'running' });

      mockProtocol.emit('disconnect');

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION,
          type: 'terminated',
          data: { reason: 'vnc-disconnect' },
        })
      );
    });

    it('should handle disconnect gracefully when session not in host', () => {
      (host.getSession as jest.Mock).mockReturnValue(undefined);

      expect(() => mockProtocol.emit('disconnect')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('mapAuthMethodToVNCSecurityType', () => {
    it.each([
      ['none', 'none'],
      ['vnc', 'vnc'],
      ['tight', 'tight'],
      ['ultra', 'ultra'],
      ['tls', 'tls'],
      ['vencrypt', 'vencrypt'],
      ['ra2', 'ra2'],
      ['ra2ne', 'ra2ne'],
      ['sasl', 'sasl'],
    ])('should map %s to %s', (input, expected) => {
      expect(manager.mapAuthMethodToVNCSecurityType(input)).toBe(expected);
    });

    it('should default to vnc for unknown auth method', () => {
      expect(manager.mapAuthMethodToVNCSecurityType('unknown')).toBe('vnc');
    });

    it('should default to vnc when authMethod is undefined', () => {
      expect(manager.mapAuthMethodToVNCSecurityType(undefined)).toBe('vnc');
    });
  });

  // -------------------------------------------------------------------------
  describe('getVNCSession', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getVNCSession('nonexistent')).toBeUndefined();
    });

    it('should return the VNCSession after creation', async () => {
      await manager.createSession('vnc-1', makeSession(), makeVNCOptions());

      const vncSession = manager.getVNCSession('vnc-1');
      expect(vncSession).toBeDefined();
      expect(vncSession!.sessionId).toBe('vnc-1');
    });
  });

  // -------------------------------------------------------------------------
  describe('getFramebuffer', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getFramebuffer('nonexistent')).toBeUndefined();
    });

    it('should return the framebuffer after session creation', async () => {
      await manager.createSession('vnc-fb', makeSession('vnc-fb'), makeVNCOptions());

      const fb = manager.getFramebuffer('vnc-fb');
      expect(fb).toBeDefined();
      expect(fb!.data).toBeInstanceOf(Buffer);
    });
  });

  // -------------------------------------------------------------------------
  describe('cleanupSession', () => {
    it('should disconnect the protocol and remove all tracking', async () => {
      await manager.createSession('vnc-cl', makeSession('vnc-cl'), makeVNCOptions());
      expect(manager.getVNCProtocol('vnc-cl')).toBeDefined();

      await manager.cleanupSession('vnc-cl');

      expect(mockProtocol.disconnect).toHaveBeenCalled();
      expect(manager.getVNCProtocol('vnc-cl')).toBeUndefined();
      expect(manager.getVNCSession('vnc-cl')).toBeUndefined();
      expect(manager.getFramebuffer('vnc-cl')).toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be a no-op for unknown sessions', async () => {
      await expect(manager.cleanupSession('nonexistent')).resolves.toBeUndefined();
    });

    it('should handle disconnect errors gracefully', async () => {
      await manager.createSession('vnc-cl2', makeSession('vnc-cl2'), makeVNCOptions());
      mockProtocol.disconnect.mockRejectedValue(new Error('already closed'));

      await expect(manager.cleanupSession('vnc-cl2')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('destroy', () => {
    it('should disconnect all active protocols', async () => {
      const proto1 = createMockVNCProtocol();
      const proto2 = createMockVNCProtocol();

      (host.getProtocolFactory as jest.Mock)
        .mockReturnValueOnce(createMockProtocolFactory(proto1))
        .mockReturnValueOnce(createMockProtocolFactory(proto2));

      await manager.createSession('vnc-d1', makeSession('vnc-d1'), makeVNCOptions());
      await manager.createSession('vnc-d2', makeSession('vnc-d2'), makeVNCOptions());
      expect(manager.getSessionCount()).toBe(2);

      await manager.destroy();

      expect(proto1.disconnect).toHaveBeenCalled();
      expect(proto2.disconnect).toHaveBeenCalled();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should clear all tracking maps', async () => {
      await manager.createSession('vnc-d3', makeSession('vnc-d3'), makeVNCOptions());

      await manager.destroy();

      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getVNCSession('vnc-d3')).toBeUndefined();
      expect(manager.getFramebuffer('vnc-d3')).toBeUndefined();
    });

    it('should handle disconnect errors gracefully during destroy', async () => {
      await manager.createSession('vnc-d4', makeSession('vnc-d4'), makeVNCOptions());
      mockProtocol.disconnect.mockRejectedValue(new Error('already gone'));

      await expect(manager.destroy()).resolves.toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be safe to call on empty manager', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
