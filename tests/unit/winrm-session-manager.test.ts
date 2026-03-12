import { WinRMSessionManager } from '../../src/core/WinRMSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockWinRMProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'winrm' as const,
    capabilities: { supportsStreaming: false },
    createSession: jest.fn().mockResolvedValue({ sessionId: 'winrm-1' }),
    executeCommand: jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    closeSession: jest.fn().mockResolvedValue(undefined),
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
    getNextSequenceNumber: jest.fn().mockReturnValue(42),
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

function makeWinRMOptions(overrides?: Record<string, unknown>) {
  return {
    winrmOptions: {
      host: '10.0.0.1',
      port: 5985,
      username: 'admin',
      authType: 'negotiate',
      protocol: 'http',
      ...overrides,
    },
  } as any;
}

describe('WinRMSessionManager', () => {
  let manager: WinRMSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockWinRMProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockWinRMProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new WinRMSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(WinRMSessionManager);
    });

    it('should start with zero sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe('createSession', () => {
    it('should throw when winrmOptions is missing', async () => {
      await expect(manager.createSession('winrm-no', {} as any)).rejects.toThrow(
        'WinRM options are required for WinRM session'
      );
    });

    it('should create a protocol via protocolFactory', async () => {
      await manager.createSession('winrm-1', makeWinRMOptions());

      expect(host.getProtocolFactory).toHaveBeenCalled();
      const factory = (host.getProtocolFactory as jest.Mock).mock.results[0].value;
      expect(factory.createProtocol).toHaveBeenCalledWith('winrm');
    });

    it('should call createSession on the protocol', async () => {
      const options = makeWinRMOptions();
      await manager.createSession('winrm-1', options);

      expect(mockProtocol.createSession).toHaveBeenCalledWith(options);
    });

    it('should track the session count', async () => {
      await manager.createSession('winrm-1', makeWinRMOptions());
      expect(manager.getSessionCount()).toBe(1);
    });

    it('should default port to 5986 for https protocol', async () => {
      await manager.createSession(
        'winrm-https',
        makeWinRMOptions({ protocol: 'https', port: undefined })
      );

      const state = manager.getSession('winrm-https');
      expect(state).toBeDefined();
      expect(state!.port).toBe(5986);
    });

    it('should default port to 5985 for http protocol', async () => {
      await manager.createSession(
        'winrm-http',
        makeWinRMOptions({ protocol: 'http', port: undefined })
      );

      const state = manager.getSession('winrm-http');
      expect(state!.port).toBe(5985);
    });

    it('should default authType to negotiate when not provided', async () => {
      await manager.createSession(
        'winrm-auth',
        makeWinRMOptions({ authType: undefined })
      );

      const state = manager.getSession('winrm-auth');
      expect(state!.authType).toBe('negotiate');
    });

    it('should default protocol to https when not provided', async () => {
      await manager.createSession(
        'winrm-proto',
        makeWinRMOptions({ protocol: undefined, port: undefined })
      );

      const state = manager.getSession('winrm-proto');
      // Protocol field defaults to 'https' in session state
      expect(state!.protocol).toBe('https');
      // Port defaults based on options.winrmOptions.protocol (which is undefined here),
      // so the fallback is 5985 (http default) since undefined !== 'https'
      expect(state!.port).toBe(5985);
    });

    it('should track WinRM session state with correct fields', async () => {
      const options = makeWinRMOptions({
        host: '192.168.1.1',
        port: 5985,
        username: 'testuser',
        authType: 'kerberos',
        protocol: 'http',
      });

      await manager.createSession('winrm-state', options);

      const state = manager.getSession('winrm-state');
      expect(state).toBeDefined();
      expect(state!.sessionId).toBe('winrm-state');
      expect(state!.host).toBe('192.168.1.1');
      expect(state!.port).toBe(5985);
      expect(state!.username).toBe('testuser');
      expect(state!.authType).toBe('kerberos');
      expect(state!.protocol).toBe('http');
      expect(state!.isConnected).toBe(true);
      expect(state!.status).toBe('running');
      expect(state!.performanceCounters).toEqual({
        commandsExecuted: 0,
        bytesTransferred: 0,
        averageResponseTime: 0,
        errorCount: 0,
        reconnections: 0,
      });
    });

    it('should update host session status to running', async () => {
      const session = { id: 'winrm-2', status: 'starting' };
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.createSession('winrm-2', makeWinRMOptions());

      expect(session.status).toBe('running');
      expect(host.setSession).toHaveBeenCalledWith('winrm-2', session);
    });

    it('should call updateSessionStatus with metadata', async () => {
      const options = makeWinRMOptions({
        host: '10.0.0.2',
        port: 5986,
        protocol: 'https',
        authType: 'ntlm',
      });

      await manager.createSession('winrm-meta', options);

      expect(host.updateSessionStatus).toHaveBeenCalledWith('winrm-meta', 'running', {
        winrmHost: '10.0.0.2',
        winrmPort: 5986,
        protocol: 'https',
        authType: 'ntlm',
      });
    });

    it('should return the sessionId on success', async () => {
      const result = await manager.createSession('winrm-ret', makeWinRMOptions());
      expect(result).toBe('winrm-ret');
    });

    it('should clean up on failure — remove protocol and session state', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('auth failed'));

      await expect(
        manager.createSession('winrm-fail', makeWinRMOptions())
      ).rejects.toThrow('auth failed');

      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getSession('winrm-fail')).toBeUndefined();
    });

    it('should mark host session as crashed on failure', async () => {
      const session = { id: 'winrm-crash', status: 'starting' };
      (host.getSession as jest.Mock).mockReturnValue(session);
      mockProtocol.createSession.mockRejectedValue(new Error('connection refused'));

      await expect(
        manager.createSession('winrm-crash', makeWinRMOptions())
      ).rejects.toThrow('connection refused');

      expect(session.status).toBe('crashed');
    });
  });

  // -----------------------------------------------------------------------
  describe('sendInput', () => {
    beforeEach(async () => {
      await manager.createSession('winrm-si', makeWinRMOptions());
    });

    it('should throw when protocol not found', async () => {
      await expect(manager.sendInput('nonexistent', 'ls')).rejects.toThrow(
        'WinRM protocol not found for session nonexistent'
      );
    });

    it('should throw when host session not found', async () => {
      (host.getSession as jest.Mock).mockReturnValue(undefined);

      await expect(manager.sendInput('winrm-si', 'ls')).rejects.toThrow(
        'Session winrm-si not found'
      );
    });

    it('should throw when WinRM session state not found', async () => {
      // Remove the session state by cleaning up first
      await manager.cleanupSession('winrm-si');

      await expect(manager.sendInput('winrm-si', 'ls')).rejects.toThrow(
        'WinRM protocol not found for session winrm-si'
      );
    });

    it('should execute PowerShell commands via protocol', async () => {
      await manager.sendInput('winrm-si', 'Get-Process');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith('winrm-si', 'Get-Process');
    });

    it('should detect PowerShell commands with $ prefix', async () => {
      await manager.sendInput('winrm-si', '$env:USERNAME');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith('winrm-si', '$env:USERNAME');
    });

    it('should execute regular commands via protocol', async () => {
      await manager.sendInput('winrm-si', 'dir C:\\');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith('winrm-si', 'dir C:\\');
    });

    it('should increment commandsExecuted counter', async () => {
      const stateBefore = manager.getSession('winrm-si');
      expect(stateBefore!.performanceCounters!.commandsExecuted).toBe(0);

      await manager.sendInput('winrm-si', 'ls');

      const stateAfter = manager.getSession('winrm-si');
      expect(stateAfter!.performanceCounters!.commandsExecuted).toBe(1);
    });

    it('should update lastActivity on sendInput', async () => {
      const before = new Date(Date.now() - 1000);
      const state = manager.getSession('winrm-si');
      state!.lastActivity = before;

      await manager.sendInput('winrm-si', 'ls');

      const stateAfter = manager.getSession('winrm-si');
      expect(stateAfter!.lastActivity!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('should emit an input event via host', async () => {
      await manager.sendInput('winrm-si', 'Get-Service');

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'winrm-si',
          type: 'input',
          data: expect.objectContaining({ input: 'Get-Service' }),
        })
      );
    });

    it('should increment errorCount on failure', async () => {
      mockProtocol.executeCommand.mockRejectedValue(new Error('timeout'));

      await expect(manager.sendInput('winrm-si', 'ls')).rejects.toThrow('timeout');

      const state = manager.getSession('winrm-si');
      expect(state!.performanceCounters!.errorCount).toBe(1);
    });

    it('should propagate errors from protocol', async () => {
      mockProtocol.executeCommand.mockRejectedValue(new Error('connection lost'));

      await expect(manager.sendInput('winrm-si', 'ls')).rejects.toThrow('connection lost');
    });
  });

  // -----------------------------------------------------------------------
  describe('handleOutput', () => {
    beforeEach(async () => {
      await manager.createSession('winrm-out', makeWinRMOptions());
    });

    it('should push output to the host output buffer', () => {
      const buffer: any[] = [];
      (host.getOutputBuffer as jest.Mock).mockReturnValue(buffer);

      const output = { sessionId: 'winrm-out', type: 'stdout', data: 'hello' } as any;
      manager.handleOutput('winrm-out', output);

      expect(host.setOutputBuffer).toHaveBeenCalledWith('winrm-out', expect.arrayContaining([output]));
    });

    it('should assign a sequence number via host', () => {
      (host.getNextSequenceNumber as jest.Mock).mockReturnValue(7);
      const output = { sessionId: 'winrm-out', type: 'stdout', data: 'hello' } as any;
      manager.handleOutput('winrm-out', output);

      expect(output.sequence).toBe(7);
    });

    it('should emit an output event via host', () => {
      const output = { sessionId: 'winrm-out', type: 'stdout', data: 'world' } as any;
      manager.handleOutput('winrm-out', output);

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'winrm-out',
          type: 'output',
          data: output,
        })
      );
    });

    it('should update lastActivity in WinRM session state', () => {
      const state = manager.getSession('winrm-out');
      const before = new Date(Date.now() - 1000);
      state!.lastActivity = before;

      const output = { sessionId: 'winrm-out', type: 'stdout', data: 'x' } as any;
      manager.handleOutput('winrm-out', output);

      const stateAfter = manager.getSession('winrm-out');
      expect(stateAfter!.lastActivity!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('should add data length to bytesTransferred', () => {
      const output = { sessionId: 'winrm-out', type: 'stdout', data: 'hello' } as any;
      manager.handleOutput('winrm-out', output);

      const state = manager.getSession('winrm-out');
      expect(state!.performanceCounters!.bytesTransferred).toBe(5); // 'hello'.length
    });

    it('should not increment bytesTransferred when data is undefined', () => {
      const output = { sessionId: 'winrm-out', type: 'stdout', data: undefined } as any;
      manager.handleOutput('winrm-out', output);

      const state = manager.getSession('winrm-out');
      expect(state!.performanceCounters!.bytesTransferred).toBe(0);
    });

    it('should be a no-op for unknown sessionId in WinRM state', () => {
      const output = { sessionId: 'unknown-session', type: 'stdout', data: 'x' } as any;
      // Should not throw even if the WinRM session state is not tracked
      expect(() => manager.handleOutput('unknown-session', output)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  describe('cleanupSession', () => {
    it('should call closeSession and remove the protocol', async () => {
      await manager.createSession('winrm-cl', makeWinRMOptions());
      expect(manager.getSessionCount()).toBe(1);

      await manager.cleanupSession('winrm-cl');

      expect(mockProtocol.closeSession).toHaveBeenCalledWith('winrm-cl');
      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getSession('winrm-cl')).toBeUndefined();
    });

    it('should be a no-op for unknown sessions', async () => {
      await expect(manager.cleanupSession('nonexistent')).resolves.toBeUndefined();
    });

    it('should handle closeSession errors gracefully', async () => {
      await manager.createSession('winrm-cl2', makeWinRMOptions());
      mockProtocol.closeSession.mockRejectedValue(new Error('already closed'));

      await expect(manager.cleanupSession('winrm-cl2')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe('getSession', () => {
    it('should return undefined for unknown session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });

    it('should return session state after createSession', async () => {
      await manager.createSession('winrm-get', makeWinRMOptions());

      const state = manager.getSession('winrm-get');
      expect(state).toBeDefined();
      expect(state!.sessionId).toBe('winrm-get');
    });

    it('should return undefined after cleanupSession', async () => {
      await manager.createSession('winrm-get2', makeWinRMOptions());
      await manager.cleanupSession('winrm-get2');

      expect(manager.getSession('winrm-get2')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe('destroy', () => {
    it('should close all active protocols and clear maps', async () => {
      const proto1 = createMockWinRMProtocol();
      const proto2 = createMockWinRMProtocol();

      (host.getProtocolFactory as jest.Mock)
        .mockReturnValueOnce(createMockProtocolFactory(proto1))
        .mockReturnValueOnce(createMockProtocolFactory(proto2));

      await manager.createSession('winrm-d1', makeWinRMOptions());
      await manager.createSession('winrm-d2', makeWinRMOptions());

      expect(manager.getSessionCount()).toBe(2);

      await manager.destroy();

      expect(proto1.closeSession).toHaveBeenCalledWith('winrm-d1');
      expect(proto2.closeSession).toHaveBeenCalledWith('winrm-d2');
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should clear WinRM session state map', async () => {
      await manager.createSession('winrm-d3', makeWinRMOptions());

      await manager.destroy();

      expect(manager.getSession('winrm-d3')).toBeUndefined();
    });

    it('should handle closeSession errors gracefully during destroy', async () => {
      await manager.createSession('winrm-d4', makeWinRMOptions());
      mockProtocol.closeSession.mockRejectedValue(new Error('already gone'));

      await expect(manager.destroy()).resolves.toBeUndefined();
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should be safe to call on an empty manager', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });

    it('should fall back to cleanup() when closeSession is not defined', async () => {
      // Replace closeSession with a non-function to force cleanup() path
      const protoNoClose = createMockWinRMProtocol();
      (protoNoClose as any).closeSession = undefined;

      (host.getProtocolFactory as jest.Mock).mockReturnValueOnce(
        createMockProtocolFactory(protoNoClose)
      );

      await manager.createSession('winrm-d5', makeWinRMOptions());
      await manager.destroy();

      expect(protoNoClose.cleanup).toHaveBeenCalled();
      expect(manager.getSessionCount()).toBe(0);
    });
  });
});
