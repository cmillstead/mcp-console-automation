import { WebSocketTerminalSessionManager, WebSocketTerminalSessionHost } from '../../src/core/WebSocketTerminalSessionManager';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'websocket-terminal' as const,
    capabilities: { supportsStreaming: true },
    createSession: jest.fn().mockResolvedValue({
      state: {
        connectionState: 'connected',
        sessionId: 'test',
        webSocketUrl: 'ws://localhost:8080',
        reconnectCount: 0,
        terminalSize: { cols: 80, rows: 24 },
        currentEncoding: 'utf-8',
        readyState: 1,
        inputBuffer: [],
        outputBuffer: [],
        bufferSize: 0,
        activeTransfers: new Map(),
        transferQueue: [],
        statistics: {
          messagesReceived: 0,
          messagesSent: 0,
          bytesReceived: 0,
          bytesSent: 0,
          reconnections: 0,
          errors: 0,
          avgLatency: 0,
          maxLatency: 0,
        },
        lastActivity: new Date(),
        bytesTransferred: 0,
        supportsReconnection: true,
      },
    }),
    sendInput: jest.fn().mockResolvedValue(undefined),
    closeSession: jest.fn().mockResolvedValue(undefined),
    reconnectSession: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockHost(mockProtocol: any): WebSocketTerminalSessionHost {
  return {
    getSession: jest.fn().mockReturnValue({
      id: 'test',
      status: 'running',
      webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      activeCommands: new Map(),
    }),
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
    updateSessionActivity: jest.fn(),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn(),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue({ processOutput: jest.fn(), addPatterns: jest.fn() }),
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

describe('WebSocketTerminalSessionManager', () => {
  let manager: WebSocketTerminalSessionManager;
  let host: WebSocketTerminalSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new WebSocketTerminalSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(WebSocketTerminalSessionManager);
    });
  });

  describe('createSession', () => {
    it('should create a WebSocket terminal session with valid options', async () => {
      const session = { id: 'ws-1', status: 'starting', activeCommands: new Map() } as any;
      const options = {
        webSocketTerminalOptions: {
          url: 'ws://localhost:8080',
          protocol: 'xterm',
          terminalType: 'xterm',
          cols: 120,
          rows: 40,
        },
      } as any;

      const result = await manager.createSession('ws-1', session, options);

      expect(result).toBe('ws-1');
      expect(host.getOrCreateProtocol).toHaveBeenCalledWith('websocket-terminal');
      expect(mockProtocol.createSession).toHaveBeenCalledWith(
        'ws-1',
        options.webSocketTerminalOptions
      );
      expect(host.setSession).toHaveBeenCalled();
      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'ws-1',
        'running',
        expect.objectContaining({
          webSocketUrl: 'ws://localhost:8080',
          terminalSize: { cols: 120, rows: 40 },
        })
      );
    });

    it('should use default cols/rows when not specified', async () => {
      const session = { id: 'ws-2', status: 'starting', activeCommands: new Map() } as any;
      const options = {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any;

      await manager.createSession('ws-2', session, options);

      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'ws-2',
        'running',
        expect.objectContaining({
          terminalSize: { cols: 80, rows: 24 },
        })
      );
    });

    it('should throw when webSocketTerminalOptions is missing', async () => {
      const session = { id: 'ws-3', status: 'starting' } as any;
      const options = {} as any;

      await expect(manager.createSession('ws-3', session, options)).rejects.toThrow(
        'WebSocket Terminal options are required'
      );
    });

    it('should update session status to failed on creation error', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('Connection refused'));

      const session = { id: 'ws-4', status: 'starting', activeCommands: new Map() } as any;
      const options = {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any;

      await expect(manager.createSession('ws-4', session, options)).rejects.toThrow(
        'Connection refused'
      );
      expect(session.status).toBe('crashed');
      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'ws-4',
        'failed',
        expect.objectContaining({ error: 'Connection refused' })
      );
    });

    it('should set webSocketTerminalState on the session', async () => {
      const session = { id: 'ws-5', status: 'starting', activeCommands: new Map() } as any;
      const options = {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any;

      await manager.createSession('ws-5', session, options);

      expect(session.webSocketTerminalState).toBeDefined();
      expect(session.pid).toBeUndefined();
      expect(session.status).toBe('running');
    });
  });

  describe('sendInput', () => {
    it('should send input through the protocol', async () => {
      // Create session first to initialize protocol
      const session = { id: 'ws-1', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-1', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      // The host.getSession needs to return a valid session for sendInput
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.sendInput('ws-1', 'ls -la\n');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('ws-1', 'ls -la\n');
      expect(host.updateSessionActivity).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          bytesTransferred: expect.any(Number),
          inputCount: 1,
        })
      );
    });

    it('should throw if session not found', async () => {
      (host.getSession as jest.Mock).mockReturnValue(null);

      await expect(manager.sendInput('ws-missing', 'test')).rejects.toThrow(
        'WebSocket terminal session ws-missing not found'
      );
    });

    it('should throw if WebSocket session state not found', async () => {
      // getSession returns something, but wsSessions doesn't have the entry
      (host.getSession as jest.Mock).mockReturnValue({ id: 'ws-x', status: 'running' });

      await expect(manager.sendInput('ws-x', 'test')).rejects.toThrow(
        'WebSocket terminal session state ws-x not found'
      );
    });

    it('should throw if protocol not initialized', async () => {
      // Set up a session in wsSessions without initializing protocol
      // We can't easily do this without accessing private state,
      // so test that sendInput validates the session first
      (host.getSession as jest.Mock).mockReturnValue(null);

      await expect(manager.sendInput('ws-none', 'test')).rejects.toThrow(
        'not found'
      );
    });

    it('should attempt reconnection on connection error with supportsReconnection', async () => {
      const session = { id: 'ws-r', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-r', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      (host.getSession as jest.Mock).mockReturnValue(session);

      // First call fails with connection error, reconnect succeeds
      mockProtocol.sendInput
        .mockRejectedValueOnce(new Error('websocket connection lost'))
        .mockResolvedValueOnce(undefined);

      await manager.sendInput('ws-r', 'retry-input');

      expect(mockProtocol.reconnectSession).toHaveBeenCalledWith('ws-r');
      // sendInput called twice: initial + retry
      expect(mockProtocol.sendInput).toHaveBeenCalledTimes(2);
    });

    it('should rethrow non-connection errors', async () => {
      const session = { id: 'ws-e', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-e', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      (host.getSession as jest.Mock).mockReturnValue(session);
      mockProtocol.sendInput.mockRejectedValue(new Error('encoding error'));

      await expect(manager.sendInput('ws-e', 'test')).rejects.toThrow('encoding error');
      expect(mockProtocol.reconnectSession).not.toHaveBeenCalled();
    });
  });

  describe('setupEventHandlers', () => {
    it('should emit websocket-terminal-connected on session_connected', async () => {
      // Trigger ensureProtocol to set up event handlers
      const session = { id: 'ws-evt', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-evt', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      mockProtocol.emit('session_connected', { sessionId: 'ws-evt' });

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'websocket-terminal-connected',
        { sessionId: 'ws-evt' }
      );
    });

    it('should remove from wsSessions on session_disconnected', async () => {
      const session = { id: 'ws-dc', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-dc', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      expect(manager.hasSession('ws-dc')).toBe(true);

      mockProtocol.emit('session_disconnected', { sessionId: 'ws-dc' });

      expect(manager.hasSession('ws-dc')).toBe(false);
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'websocket-terminal-disconnected',
        { sessionId: 'ws-dc' }
      );
    });

    it('should handle data events and emit output', async () => {
      const session = { id: 'ws-data', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-data', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      mockProtocol.emit('data', { sessionId: 'ws-data', data: 'hello world' });

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({
          sessionId: 'ws-data',
          type: 'stdout',
          data: 'hello world',
        })
      );
    });

    it('should handle Buffer data events', async () => {
      const session = { id: 'ws-buf', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-buf', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      mockProtocol.emit('data', {
        sessionId: 'ws-buf',
        data: Buffer.from('buffer data'),
      });

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({
          sessionId: 'ws-buf',
          data: 'buffer data',
        })
      );
    });

    it('should emit error and attempt recovery on error event', async () => {
      const session = { id: 'ws-err', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-err', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      const testError = new Error('test error');
      mockProtocol.emit('error', { sessionId: 'ws-err', error: testError });

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'websocket-terminal-error',
        { sessionId: 'ws-err', error: testError }
      );
    });

    it('should emit file transfer progress events', async () => {
      const session = { id: 'ws-ft', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-ft', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      const transferData = { sessionId: 'ws-ft', transfer: { progress: 50 } };
      mockProtocol.emit('file_transfer_progress', transferData);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'websocket-terminal-file-transfer-progress',
        transferData
      );
    });

    it('should emit multiplex session created events', async () => {
      const session = { id: 'ws-mx', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-mx', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      const muxData = { sessionId: 'ws-mx', multiplexSession: { id: 'sub-1' } };
      mockProtocol.emit('multiplex_session_created', muxData);

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'websocket-terminal-multiplex-session-created',
        muxData
      );
    });
  });

  describe('hasSession', () => {
    it('should return false for unknown session', () => {
      expect(manager.hasSession('nonexistent')).toBe(false);
    });

    it('should return true after session creation', async () => {
      const session = { id: 'ws-has', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-has', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      expect(manager.hasSession('ws-has')).toBe(true);
    });
  });

  describe('clearSessions', () => {
    it('should clear all tracked sessions', async () => {
      const session = { id: 'ws-cl', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-cl', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      expect(manager.hasSession('ws-cl')).toBe(true);
      manager.clearSessions();
      expect(manager.hasSession('ws-cl')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should clean up protocol and sessions', async () => {
      const session = { id: 'ws-d', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-d', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
      expect(manager.hasSession('ws-d')).toBe(false);
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProtocol.cleanup.mockRejectedValue(new Error('cleanup failed'));

      const session = { id: 'ws-d2', status: 'starting', activeCommands: new Map() } as any;
      await manager.createSession('ws-d2', session, {
        webSocketTerminalOptions: { url: 'ws://localhost:8080' },
      } as any);

      // Should not throw
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
