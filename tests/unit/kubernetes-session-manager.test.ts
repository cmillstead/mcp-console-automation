import { KubernetesSessionManager } from '../../src/core/KubernetesSessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

function createMockProtocol() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    type: 'kubectl' as const,
    capabilities: { supportsStreaming: true },
    createExecSession: jest.fn().mockResolvedValue(undefined),
    streamLogs: jest.fn().mockResolvedValue(undefined),
    startPortForward: jest.fn().mockResolvedValue(undefined),
    sendInput: jest.fn().mockResolvedValue(undefined),
    getCurrentContext: jest.fn().mockReturnValue({
      context: 'minikube',
      namespace: 'default',
    }),
    getActiveSessions: jest.fn().mockReturnValue([]),
    performHealthCheck: jest.fn().mockResolvedValue({
      status: 'healthy',
      overallScore: 100,
      checks: [],
    }),
    cleanup: jest.fn().mockResolvedValue(undefined),
  });
}

function createMockHost(mockProtocol: any): ProtocolSessionHost {
  return {
    getSession: jest.fn().mockReturnValue(null),
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
    getPaginationManager: jest.fn().mockReturnValue({ addOutputs: jest.fn() }),
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

describe('KubernetesSessionManager', () => {
  let manager: KubernetesSessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new KubernetesSessionManager(host, logger);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(manager).toBeInstanceOf(KubernetesSessionManager);
    });
  });

  describe('createSession', () => {
    const baseSession = {
      id: 'k8s-1',
      status: 'starting' as const,
      type: 'kubectl' as any,
      command: 'kubectl exec',
      createdAt: new Date(),
      cwd: '/tmp',
    };

    it('should throw if kubernetesOptions not provided', async () => {
      await expect(
        manager.createSession('k8s-1', baseSession as any, {
          command: 'kubectl exec',
        } as any)
      ).rejects.toThrow('Kubernetes options are required');
    });

    it('should create an exec session', async () => {
      const result = await manager.createSession('k8s-1', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '-c', 'main'],
      } as any);

      expect(result).toBe('k8s-1');
      expect(mockProtocol.createExecSession).toHaveBeenCalledWith(
        'k8s-1',
        expect.objectContaining({
          namespace: 'default',
          containerName: 'main',
          name: 'my-pod',
        })
      );
      expect(host.setSession).toHaveBeenCalled();
      expect(host.setOutputBuffer).toHaveBeenCalledWith('k8s-1', []);
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-1',
          type: 'started',
        })
      );
    });

    it('should create a logs session when command includes "logs"', async () => {
      const result = await manager.createSession('k8s-2', baseSession as any, {
        command: 'kubectl logs',
        kubernetesOptions: { namespace: 'kube-system' },
        args: ['my-pod', '--tail', '100'],
      } as any);

      expect(result).toBe('k8s-2');
      expect(mockProtocol.streamLogs).toHaveBeenCalledWith(
        'k8s-2',
        expect.objectContaining({
          namespace: 'kube-system',
          podName: 'my-pod',
          tail: 100,
        })
      );
    });

    it('should create a logs session when consoleType is k8s-logs', async () => {
      await manager.createSession('k8s-3', baseSession as any, {
        command: 'stream',
        consoleType: 'k8s-logs',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(mockProtocol.streamLogs).toHaveBeenCalled();
    });

    it('should create a port-forward session', async () => {
      const result = await manager.createSession('k8s-4', baseSession as any, {
        command: 'kubectl port-forward',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '8080:80'],
      } as any);

      expect(result).toBe('k8s-4');
      expect(mockProtocol.startPortForward).toHaveBeenCalledWith(
        'k8s-4',
        expect.objectContaining({
          podName: 'my-pod',
          localPort: 8080,
          remotePort: 80,
        })
      );
    });

    it('should create a port-forward session when consoleType is k8s-port-forward', async () => {
      await manager.createSession('k8s-5', baseSession as any, {
        command: 'forward',
        consoleType: 'k8s-port-forward',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '3000:3000'],
      } as any);

      expect(mockProtocol.startPortForward).toHaveBeenCalled();
    });

    it('should register with health monitoring when self-healing is enabled', async () => {
      (host.isSelfHealingEnabled as jest.Mock).mockReturnValue(true);

      await manager.createSession('k8s-6', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(host.registerSessionWithHealthMonitoring).toHaveBeenCalled();
    });

    it('should setup streaming stream manager when streaming enabled', async () => {
      await manager.createSession('k8s-7', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
        streaming: true,
      } as any);

      expect(host.createStreamManager).toHaveBeenCalledWith(
        'k8s-7',
        expect.objectContaining({
          pollingInterval: 25,
          maxChunkSize: 4096,
        })
      );
    });

    it('should setup non-streaming stream manager by default', async () => {
      await manager.createSession('k8s-8', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(host.createStreamManager).toHaveBeenCalledWith(
        'k8s-8',
        expect.objectContaining({
          pollingInterval: 50,
          maxChunkSize: 8192,
        })
      );
    });

    it('should update session status with kubernetes context', async () => {
      await manager.createSession('k8s-9', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'k8s-9',
        'running',
        expect.objectContaining({
          kubernetesContext: 'minikube',
          kubernetesNamespace: 'default',
        })
      );
    });
  });

  describe('sendInput', () => {
    it('should throw if protocol not initialized', async () => {
      await expect(manager.sendInput('k8s-1', 'ls')).rejects.toThrow(
        'Kubernetes protocol not initialized'
      );
    });

    it('should throw if session not found', async () => {
      // Initialize protocol
      await manager.createSession('k8s-init', { id: 'k8s-init' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      (host.getSession as jest.Mock).mockReturnValue(null);

      await expect(manager.sendInput('k8s-missing', 'ls')).rejects.toThrow(
        'Kubernetes session k8s-missing not found'
      );
    });

    it('should send input to exec session', async () => {
      // Initialize protocol
      await manager.createSession('k8s-exec', { id: 'k8s-exec' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      (host.getSession as jest.Mock).mockReturnValue({
        id: 'k8s-exec',
        kubernetesState: { sessionType: 'exec' },
      });

      await manager.sendInput('k8s-exec', 'ls -la');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('k8s-exec', 'ls -la');
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-exec',
          type: 'input',
        })
      );
    });

    it('should throw when sending input to non-exec session', async () => {
      await manager.createSession('k8s-logs', { id: 'k8s-logs' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      (host.getSession as jest.Mock).mockReturnValue({
        id: 'k8s-logs',
        kubernetesState: { sessionType: 'logs' },
      });

      await expect(manager.sendInput('k8s-logs', 'input')).rejects.toThrow(
        'Input not supported for Kubernetes logs sessions'
      );
    });
  });

  describe('parseExecOptions', () => {
    it('should parse namespace from args', () => {
      const result = manager.parseExecOptions({
        command: 'kubectl exec',
        kubernetesOptions: {},
        args: ['-n', 'kube-system', 'my-pod'],
      } as any);

      expect(result.namespace).toBe('kube-system');
      expect(result.name).toBe('my-pod');
    });

    it('should parse container from args', () => {
      const result = manager.parseExecOptions({
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: ['-c', 'sidecar', 'my-pod'],
      } as any);

      expect(result.containerName).toBe('sidecar');
      expect(result.name).toBe('my-pod');
    });

    it('should parse label selector from args', () => {
      const result = manager.parseExecOptions({
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: ['-l', 'app=nginx'],
      } as any);

      expect(result.labelSelector).toBe('app=nginx');
    });

    it('should default to interactive and stdin enabled', () => {
      const result = manager.parseExecOptions({
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(result.interactive).toBe(true);
      expect(result.stdin).toBe(true);
    });

    it('should handle --namespace long form', () => {
      const result = manager.parseExecOptions({
        command: 'kubectl exec',
        kubernetesOptions: {},
        args: ['--namespace', 'prod'],
      } as any);

      expect(result.namespace).toBe('prod');
    });
  });

  describe('parseLogOptions', () => {
    it('should parse log options from args', () => {
      const result = manager.parseLogOptions({
        command: 'kubectl logs',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '--tail', '50', '--timestamps', '--previous'],
      } as any);

      expect(result.podName).toBe('my-pod');
      expect(result.tail).toBe(50);
      expect(result.timestamps).toBe(true);
      expect(result.previous).toBe(true);
    });

    it('should parse --since option', () => {
      const result = manager.parseLogOptions({
        command: 'kubectl logs',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '--since', '1h'],
      } as any);

      expect(result.since).toBe('1h');
    });

    it('should default to follow: true', () => {
      const result = manager.parseLogOptions({
        command: 'kubectl logs',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      expect(result.follow).toBe(true);
    });

    it('should parse container for logs', () => {
      const result = manager.parseLogOptions({
        command: 'kubectl logs',
        kubernetesOptions: { namespace: 'default' },
        args: ['-c', 'app'],
      } as any);

      expect(result.containerName).toBe('app');
    });
  });

  describe('parsePortForwardOptions', () => {
    it('should parse port-forward options', () => {
      const result = manager.parsePortForwardOptions({
        command: 'kubectl port-forward',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '8080:80'],
      } as any);

      expect(result.podName).toBe('my-pod');
      expect(result.localPort).toBe(8080);
      expect(result.remotePort).toBe(80);
      expect(result.namespace).toBe('default');
    });

    it('should parse namespace override', () => {
      const result = manager.parsePortForwardOptions({
        command: 'kubectl port-forward',
        kubernetesOptions: { namespace: 'default' },
        args: ['-n', 'kube-system', 'my-pod', '3000:3000'],
      } as any);

      expect(result.namespace).toBe('kube-system');
      expect(result.podName).toBe('my-pod');
      expect(result.localPort).toBe(3000);
      expect(result.remotePort).toBe(3000);
    });

    it('should handle missing port spec', () => {
      const result = manager.parsePortForwardOptions({
        command: 'kubectl port-forward',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod'],
      } as any);

      expect(result.podName).toBe('my-pod');
      expect(result.localPort).toBe(0);
      expect(result.remotePort).toBe(0);
    });
  });

  describe('event handlers', () => {
    const baseSession = {
      id: 'k8s-1',
      status: 'starting' as const,
      type: 'kubectl' as any,
      command: 'kubectl exec',
      createdAt: new Date(),
      cwd: '/tmp',
    };

    it('should handle sessionClosed event', async () => {
      (host.getSession as jest.Mock).mockReturnValue({ id: 'k8s-1' });

      await manager.createSession('k8s-1', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      mockProtocol.emit('sessionClosed', { sessionId: 'k8s-1' });

      expect(host.deleteSession).toHaveBeenCalledWith('k8s-1');
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-1',
          type: 'stopped',
          data: { reason: 'kubernetes_session_closed' },
        })
      );
    });

    it('should handle logData event', async () => {
      await manager.createSession('k8s-log', baseSession as any, {
        command: 'kubectl logs my-pod',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod'],
      } as any);

      mockProtocol.emit('logData', {
        streamId: 'k8s-log',
        podName: 'my-pod',
        data: 'log line',
        raw: 'raw log line',
      });

      expect(host.setOutputBuffer).toHaveBeenCalled();
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-log',
          type: 'output',
        })
      );
    });

    it('should handle logError event', async () => {
      await manager.createSession('k8s-log-err', baseSession as any, {
        command: 'kubectl logs my-pod',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod'],
      } as any);

      mockProtocol.emit('logError', {
        streamId: 'k8s-log-err',
        error: new Error('stream error'),
      });

      expect(host.setOutputBuffer).toHaveBeenCalled();
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-log-err',
          type: 'error',
        })
      );
    });

    it('should handle logEnd event', async () => {
      (host.getSession as jest.Mock).mockReturnValue({ id: 'k8s-log-end' });

      await manager.createSession('k8s-log-end', baseSession as any, {
        command: 'kubectl logs my-pod',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod'],
      } as any);

      mockProtocol.emit('logEnd', { streamId: 'k8s-log-end' });

      expect(host.deleteSession).toHaveBeenCalledWith('k8s-log-end');
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-log-end',
          type: 'stopped',
          data: { reason: 'log_stream_ended' },
        })
      );
    });

    it('should handle portForwardStopped event', async () => {
      (host.getSession as jest.Mock).mockReturnValue({ id: 'k8s-pf' });

      await manager.createSession('k8s-pf', baseSession as any, {
        command: 'kubectl port-forward my-pod 8080:80',
        kubernetesOptions: { namespace: 'default' },
        args: ['my-pod', '8080:80'],
      } as any);

      mockProtocol.emit('portForwardStopped', { portForwardId: 'k8s-pf' });

      expect(host.deleteSession).toHaveBeenCalledWith('k8s-pf');
      expect(host.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'k8s-pf',
          type: 'stopped',
          data: { reason: 'port_forward_stopped' },
        })
      );
    });

    it('should ignore events for other sessions', async () => {
      await manager.createSession('k8s-1', baseSession as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      // Reset mocks after createSession calls
      (host.deleteSession as jest.Mock).mockClear();

      mockProtocol.emit('sessionClosed', { sessionId: 'other-session' });

      expect(host.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe('getHealthStatus', () => {
    it('should return null when protocol not initialized', async () => {
      const result = await manager.getHealthStatus();
      expect(result).toBeNull();
    });

    it('should return health status when protocol is active', async () => {
      // Initialize protocol by creating a session
      await manager.createSession('k8s-h', { id: 'k8s-h' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      const result = await manager.getHealthStatus();

      expect(result).toEqual(
        expect.objectContaining({
          type: 'kubernetes',
          status: 'healthy',
          overallScore: 100,
          context: { context: 'minikube', namespace: 'default' },
        })
      );
    });

    it('should return critical status on health check error', async () => {
      await manager.createSession('k8s-he', { id: 'k8s-he' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      mockProtocol.performHealthCheck.mockRejectedValue(
        new Error('connection refused')
      );

      const result = await manager.getHealthStatus();

      expect(result).toEqual(
        expect.objectContaining({
          type: 'kubernetes',
          status: 'critical',
          error: 'connection refused',
        })
      );
    });
  });

  describe('destroy', () => {
    it('should clean up protocol', async () => {
      // Initialize protocol
      await manager.createSession('k8s-d', { id: 'k8s-d' } as any, {
        command: 'kubectl exec',
        kubernetesOptions: { namespace: 'default' },
        args: [],
      } as any);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
    });

    it('should handle destroy when protocol not initialized', async () => {
      await expect(manager.destroy()).resolves.not.toThrow();
    });
  });
});
