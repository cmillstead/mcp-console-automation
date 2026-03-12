import {
  AWSSSMSessionManager,
  AWSSSMSessionHost,
} from '../../src/core/AWSSSMSessionManager';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'aws-ssm' as const,
    capabilities: { supportsStreaming: false },
    startSession: jest.fn().mockResolvedValue('ssm-session-1'),
    startPortForwardingSession: jest.fn().mockResolvedValue('ssm-pf-1'),
    sendCommand: jest.fn().mockResolvedValue('ssm-cmd-1'),
    sendInput: jest.fn().mockResolvedValue(undefined),
    terminateSession: jest.fn().mockResolvedValue(undefined),
    isHealthy: jest.fn().mockReturnValue(true),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockHost(mockProtocol: any): AWSSSMSessionHost {
  return {
    getSession: jest.fn().mockReturnValue(null),
    setSession: jest.fn(),
    deleteSession: jest.fn(),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getMaxBufferSize: jest.fn().mockReturnValue(10000),
    createStreamManager: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    setStreamManager: jest.fn(),
    getStreamManager: jest.fn().mockReturnValue(null),
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
    getPaginationManager: jest.fn().mockReturnValue({ addOutputs: jest.fn() }),
    isSelfHealingEnabled: jest.fn().mockReturnValue(false),
    getNextSequenceNumber: jest.fn().mockReturnValue(1),
    getLogger: jest.fn().mockReturnValue(new Logger('test')),
    findSessionBySSMId: jest.fn().mockReturnValue(null),
    addToHeartbeatMonitor: jest.fn(),
    addHealthCheckInterval: jest.fn(),
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

describe('AWSSSMSessionManager', () => {
  let manager: AWSSSMSessionManager;
  let host: AWSSSMSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new AWSSSMSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(AWSSSMSessionManager);
    });
  });

  describe('determineSessionType', () => {
    it('should return port-forwarding for ssm-tunnel consoleType', () => {
      const result = manager.determineSessionType({
        consoleType: 'ssm-tunnel',
        command: '/bin/bash',
      } as any);
      expect(result).toBe('port-forwarding');
    });

    it('should return port-forwarding when portNumber is specified', () => {
      const result = manager.determineSessionType({
        consoleType: 'aws-ssm',
        awsSSMOptions: { portNumber: 8080 },
        command: '/bin/bash',
      } as any);
      expect(result).toBe('port-forwarding');
    });

    it('should return command when documentName is specified', () => {
      const result = manager.determineSessionType({
        consoleType: 'aws-ssm',
        awsSSMOptions: { documentName: 'AWS-RunShellScript' },
        command: '/bin/bash',
      } as any);
      expect(result).toBe('command');
    });

    it('should return interactive for aws-ssm without documentName', () => {
      const result = manager.determineSessionType({
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-123' },
        command: '/bin/bash',
      } as any);
      expect(result).toBe('interactive');
    });

    it('should return interactive for ssm-session without documentName', () => {
      const result = manager.determineSessionType({
        consoleType: 'ssm-session',
        command: '/bin/bash',
      } as any);
      expect(result).toBe('interactive');
    });

    it('should default to interactive for unknown consoleType', () => {
      const result = manager.determineSessionType({
        consoleType: 'unknown',
        command: '/bin/bash',
      } as any);
      expect(result).toBe('interactive');
    });
  });

  describe('createSession', () => {
    it('should throw when no SSM options and non-SSM consoleType', async () => {
      await expect(
        manager.createSession('s1', { id: 's1' }, {
          consoleType: 'bash',
          command: '/bin/bash',
        } as any)
      ).rejects.toThrow(
        'AWS SSM options or AWS SSM console type required for AWS SSM session'
      );
    });

    it('should create an interactive session', async () => {
      const session = { id: 's1' } as any;
      const options = {
        consoleType: 'aws-ssm',
        awsSSMOptions: {
          instanceId: 'i-123',
          region: 'us-west-2',
        },
        command: '/bin/bash',
      } as any;

      const result = await manager.createSession('s1', session, options);

      expect(result).toBe('s1');
      expect(mockProtocol.startSession).toHaveBeenCalledWith(
        options.awsSSMOptions
      );
      expect(session.awsSSMSessionId).toBe('ssm-session-1');
      expect(host.setSession).toHaveBeenCalledWith('s1', session);
      expect(host.addToHeartbeatMonitor).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ id: 's1', type: 'aws-ssm' })
      );
    });

    it('should create a port-forwarding session', async () => {
      const session = { id: 's2' } as any;
      const options = {
        consoleType: 'ssm-tunnel',
        awsSSMOptions: {
          instanceId: 'i-456',
          portNumber: 3389,
          localPortNumber: 13389,
          region: 'us-east-1',
        },
        command: '/bin/bash',
      } as any;

      await manager.createSession('s2', session, options);

      expect(mockProtocol.startPortForwardingSession).toHaveBeenCalledWith(
        'i-456',
        3389,
        13389
      );
      expect(session.awsSSMSessionId).toBe('ssm-pf-1');
    });

    it('should create a command session', async () => {
      const session = { id: 's3' } as any;
      const options = {
        consoleType: 'aws-ssm',
        awsSSMOptions: {
          instanceId: 'i-789',
          documentName: 'AWS-RunShellScript',
          parameters: { commands: ['echo hello'] },
          region: 'us-east-1',
        },
        command: '/bin/bash',
      } as any;

      await manager.createSession('s3', session, options);

      expect(mockProtocol.sendCommand).toHaveBeenCalledWith(
        'AWS-RunShellScript',
        { commands: ['echo hello'] },
        [{ type: 'instance', id: 'i-789' }]
      );
      expect(session.awsSSMSessionId).toBe('ssm-cmd-1');
    });

    it('should throw for interactive without instanceId', async () => {
      await expect(
        manager.createSession('s4', { id: 's4' }, {
          consoleType: 'aws-ssm',
          awsSSMOptions: { region: 'us-east-1' },
          command: '/bin/bash',
        } as any)
      ).rejects.toThrow('Instance ID is required for interactive SSM sessions');
    });

    it('should throw for port-forwarding without instanceId', async () => {
      await expect(
        manager.createSession('s5', { id: 's5' }, {
          consoleType: 'ssm-tunnel',
          awsSSMOptions: { region: 'us-east-1' },
          command: '/bin/bash',
        } as any)
      ).rejects.toThrow(
        'Instance ID and port number are required for SSM port forwarding'
      );
    });

    it('should throw for command without documentName', async () => {
      const options = {
        consoleType: 'ssm-session',
        awsSSMOptions: {
          documentName: 'doc',
          region: 'us-east-1',
        },
        command: '/bin/bash',
      } as any;

      // This is a command type, but we remove documentName to trigger error
      delete options.awsSSMOptions.documentName;

      // Without documentName it becomes interactive, not command
      // So we need instanceId missing to trigger an error
      await expect(
        manager.createSession('s6', { id: 's6' }, options)
      ).rejects.toThrow('Instance ID is required for interactive SSM sessions');
    });

    it('should emit session-created event', async () => {
      const session = { id: 's7' } as any;
      const options = {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-111', region: 'us-east-1' },
        command: '/bin/bash',
      } as any;

      await manager.createSession('s7', session, options);

      expect(host.emitTypedEvent).toHaveBeenCalledWith('session-created', {
        sessionId: 's7',
        type: 'aws-ssm',
        ssmSessionId: 'ssm-session-1',
        ssmSessionType: 'interactive',
      });
    });

    it('should propagate errors from protocol', async () => {
      mockProtocol.startSession.mockRejectedValue(new Error('SSM unavailable'));

      await expect(
        manager.createSession('s8', { id: 's8' }, {
          consoleType: 'aws-ssm',
          awsSSMOptions: { instanceId: 'i-fail', region: 'us-east-1' },
          command: '/bin/bash',
        } as any)
      ).rejects.toThrow('SSM unavailable');
    });

    it('should accept consoleType aws-ssm without explicit awsSSMOptions', async () => {
      const session = { id: 's9' } as any;
      const options = {
        consoleType: 'aws-ssm',
        command: '/bin/bash',
      } as any;

      // Will throw because no instanceId, but should get past the initial validation
      await expect(
        manager.createSession('s9', session, options)
      ).rejects.toThrow('Instance ID is required');
    });
  });

  describe('sendInput', () => {
    it('should send input through the protocol', async () => {
      // Initialize protocol first
      const session = { id: 'si1', awsSSMSessionId: 'ssm-si1' } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      // Need to initialize protocol
      await manager.createSession('init', { id: 'init' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-test', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      await manager.sendInput('si1', 'ls -la\n');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('ssm-si1', 'ls -la\n');
    });

    it('should throw when protocol not initialized', async () => {
      await expect(manager.sendInput('si2', 'test')).rejects.toThrow(
        'AWS SSM protocol not initialized'
      );
    });

    it('should throw when session not found', async () => {
      // Initialize protocol
      await manager.createSession('init', { id: 'init' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-test', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      (host.getSession as jest.Mock).mockReturnValue(null);

      await expect(manager.sendInput('si3', 'test')).rejects.toThrow(
        'AWS SSM session si3 not found or SSM session ID missing'
      );
    });

    it('should throw when session has no awsSSMSessionId', async () => {
      await manager.createSession('init', { id: 'init' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-test', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      (host.getSession as jest.Mock).mockReturnValue({ id: 'si4' });

      await expect(manager.sendInput('si4', 'test')).rejects.toThrow(
        'AWS SSM session si4 not found or SSM session ID missing'
      );
    });

    it('should emit input event', async () => {
      const session = { id: 'si5', awsSSMSessionId: 'ssm-si5' } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.createSession('init', { id: 'init' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-test', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      await manager.sendInput('si5', 'echo hello');

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'si5',
          type: 'input',
          data: { input: 'echo hello' },
        })
      );
    });

    it('should propagate errors from protocol sendInput', async () => {
      const session = { id: 'si6', awsSSMSessionId: 'ssm-si6' } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.createSession('init', { id: 'init' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-test', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      mockProtocol.sendInput.mockRejectedValue(new Error('connection lost'));

      await expect(manager.sendInput('si6', 'test')).rejects.toThrow(
        'connection lost'
      );
    });
  });

  describe('setupEventHandlers', () => {
    async function initProtocol() {
      await manager.createSession('evt', { id: 'evt' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-evt', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);
    }

    it('should handle output events', async () => {
      const session = { id: 'out1', awsSSMSessionId: 'ssm-out1' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);

      await initProtocol();

      mockProtocol.emit('output', { sessionId: 'ssm-out1', data: 'hello' });

      expect(host.setOutputBuffer).toHaveBeenCalled();
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'out1',
          type: 'output',
        })
      );
    });

    it('should handle session-started events', async () => {
      await initProtocol();

      mockProtocol.emit('session-started', { sessionId: 'ssm-1', instanceId: 'i-1' });

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'ssm-1',
          type: 'started',
        })
      );
    });

    it('should handle session-terminated events', async () => {
      const session = { id: 'term1', awsSSMSessionId: 'ssm-term1' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);

      await initProtocol();

      mockProtocol.emit('session-terminated', { sessionId: 'ssm-term1' });

      expect(host.deleteSession).toHaveBeenCalledWith('term1');
    });

    it('should handle session-error events', async () => {
      const session = { id: 'err1', awsSSMSessionId: 'ssm-err1', status: 'running' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);

      await initProtocol();

      const error = new Error('connection dropped');
      mockProtocol.emit('session-error', { sessionId: 'ssm-err1', error });

      expect(session.status).toBe('crashed');
      expect(host.setSession).toHaveBeenCalledWith('err1', session);
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'err1',
          type: 'error',
          data: { error: 'connection dropped', ssmSessionId: 'ssm-err1' },
        })
      );
    });

    it('should attempt recovery on error when self-healing is enabled', async () => {
      const session = { id: 'heal1', awsSSMSessionId: 'ssm-heal1', status: 'running' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);
      (host.isSelfHealingEnabled as jest.Mock).mockReturnValue(true);
      // getSession needed for recovery
      (host.getSession as jest.Mock).mockReturnValue(null);

      await initProtocol();

      mockProtocol.emit('session-error', {
        sessionId: 'ssm-heal1',
        error: new Error('timeout'),
      });

      // Recovery was attempted but session not found, so it logged a warning
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle port-forwarding-started events', async () => {
      await initProtocol();

      mockProtocol.emit('port-forwarding-started', {
        sessionId: 'ssm-pf',
        targetId: 'i-123',
        portNumber: 3389,
        localPortNumber: 13389,
      });

      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'ssm-pf',
          type: 'started',
        })
      );
    });

    it('should handle command-sent events', async () => {
      await initProtocol();

      mockProtocol.emit('command-sent', {
        commandId: 'cmd-1',
        documentName: 'AWS-RunShellScript',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('AWS SSM command sent: cmd-1')
      );
    });

    it('should handle command-completed events', async () => {
      await initProtocol();

      mockProtocol.emit('command-completed', {
        commandId: 'cmd-1',
        status: 'Success',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('AWS SSM command completed: cmd-1')
      );
    });

    it('should handle health-check unhealthy events', async () => {
      await initProtocol();

      mockProtocol.emit('health-check', {
        status: 'unhealthy',
        timestamp: new Date(),
        error: new Error('timeout'),
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('health check failed'),
        expect.anything()
      );
    });

    it('should handle session-recovered events', async () => {
      await initProtocol();

      mockProtocol.emit('session-recovered', { sessionId: 'ssm-rec1' });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('session recovered: ssm-rec1')
      );
    });

    it('should use error detector for output processing', async () => {
      const session = { id: 'det1', awsSSMSessionId: 'ssm-det1' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);
      const errorDetector = { processOutput: jest.fn() };
      (host.getErrorDetector as jest.Mock).mockReturnValue(errorDetector);

      await initProtocol();

      mockProtocol.emit('output', { sessionId: 'ssm-det1', data: 'error output' });

      expect(errorDetector.processOutput).toHaveBeenCalled();
    });

    it('should use pagination manager for output', async () => {
      const session = { id: 'pag1', awsSSMSessionId: 'ssm-pag1' } as any;
      (host.findSessionBySSMId as jest.Mock).mockReturnValue(session);
      const paginationManager = { addOutputs: jest.fn() };
      (host.getPaginationManager as jest.Mock).mockReturnValue(paginationManager);

      await initProtocol();

      mockProtocol.emit('output', { sessionId: 'ssm-pag1', data: 'page data' });

      expect(paginationManager.addOutputs).toHaveBeenCalledWith('pag1', expect.any(Array));
    });
  });

  describe('attemptSessionRecovery', () => {
    async function initProtocol() {
      await manager.createSession('rec', { id: 'rec' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-rec', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);
    }

    it('should recover an interactive session', async () => {
      await initProtocol();

      const session = {
        id: 'r1',
        type: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-r1', region: 'us-east-1' },
        command: '/bin/bash',
      } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.attemptSessionRecovery('r1', 'old-ssm-1', new Error('fail'));

      expect(mockProtocol.terminateSession).toHaveBeenCalledWith('old-ssm-1');
      expect(mockProtocol.startSession).toHaveBeenCalledWith(session.awsSSMOptions);
      expect(session.awsSSMSessionId).toBe('ssm-session-1');
      expect(session.status).toBe('running');
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'session-recovered',
        expect.objectContaining({ sessionId: 'r1' })
      );
    });

    it('should recover a port-forwarding session', async () => {
      await initProtocol();

      const session = {
        id: 'r2',
        type: 'ssm-tunnel',
        awsSSMOptions: {
          instanceId: 'i-r2',
          portNumber: 3389,
          localPortNumber: 13389,
          region: 'us-east-1',
        },
        command: '/bin/bash',
      } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.attemptSessionRecovery('r2', 'old-ssm-2', new Error('fail'));

      expect(mockProtocol.startPortForwardingSession).toHaveBeenCalledWith(
        'i-r2',
        3389,
        13389
      );
    });

    it('should recover a command session', async () => {
      await initProtocol();

      const session = {
        id: 'r3',
        type: 'aws-ssm',
        awsSSMOptions: {
          instanceId: 'i-r3',
          documentName: 'AWS-RunShellScript',
          parameters: { commands: ['ls'] },
          region: 'us-east-1',
        },
        command: '/bin/bash',
      } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);

      await manager.attemptSessionRecovery('r3', 'old-ssm-3', new Error('fail'));

      expect(mockProtocol.sendCommand).toHaveBeenCalledWith(
        'AWS-RunShellScript',
        { commands: ['ls'] },
        [{ type: 'instance', id: 'i-r3' }]
      );
    });

    it('should handle missing session gracefully', async () => {
      await initProtocol();
      (host.getSession as jest.Mock).mockReturnValue(null);

      await manager.attemptSessionRecovery('missing', 'ssm-x', new Error('fail'));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot recover')
      );
    });

    it('should set status to crashed on recovery failure', async () => {
      await initProtocol();

      const session = {
        id: 'r4',
        type: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-r4', region: 'us-east-1' },
        command: '/bin/bash',
      } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);
      mockProtocol.startSession.mockRejectedValue(new Error('cannot reconnect'));

      await manager.attemptSessionRecovery('r4', 'old-ssm-4', new Error('fail'));

      expect(session.status).toBe('crashed');
    });

    it('should continue recovery even if terminate fails', async () => {
      await initProtocol();

      const session = {
        id: 'r5',
        type: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-r5', region: 'us-east-1' },
        command: '/bin/bash',
      } as any;
      (host.getSession as jest.Mock).mockReturnValue(session);
      mockProtocol.terminateSession.mockRejectedValue(new Error('already terminated'));

      await manager.attemptSessionRecovery('r5', 'old-ssm-5', new Error('fail'));

      // Should still attempt to start a new session
      expect(mockProtocol.startSession).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('should clean up protocol', async () => {
      // Initialize protocol
      await manager.createSession('d1', { id: 'd1' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-d1', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockProtocol.cleanup.mockRejectedValue(new Error('cleanup failed'));

      await manager.createSession('d2', { id: 'd2' }, {
        consoleType: 'aws-ssm',
        awsSSMOptions: { instanceId: 'i-d2', region: 'us-east-1' },
        command: '/bin/bash',
      } as any);

      await expect(manager.destroy()).resolves.toBeUndefined();
    });

    it('should be safe to call without initialization', async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });
});
