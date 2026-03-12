import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  ConsoleOutput,
  ConsoleSession,
  SessionOptions,
  KubernetesSessionState,
  KubernetesExecOptions,
  KubernetesLogOptions,
  PortForwardOptions,
} from '../types/index.js';

/**
 * Manages Kubernetes protocol sessions (exec, logs, port-forward).
 * Extracted from ConsoleManager to isolate Kubernetes-specific logic
 * and eliminate the legacy kubernetesProtocol field.
 *
 * Event handlers are per-session (not global), so setupEventHandlers()
 * is a no-op and handlers are wired in createSession() for each session type.
 */
export class KubernetesSessionManager extends ProtocolSessionManagerBase {
  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'kubectl');
  }

  /**
   * Kubernetes event handlers are per-session, not global.
   * Override as empty — handlers are set up per-session in createSession().
   */
  protected setupEventHandlers(): void {
    // No-op: Kubernetes event handlers are per-session
  }

  /**
   * Create a Kubernetes session (exec, logs, or port-forward).
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (!options.kubernetesOptions) {
      throw new Error('Kubernetes options are required for Kubernetes session');
    }

    try {
      const protocol = await this.ensureProtocol();

      // Determine session operation type based on command or console type
      let sessionType: 'exec' | 'logs' | 'port-forward' = 'exec';
      if (
        options.command.includes('logs') ||
        options.consoleType === 'k8s-logs'
      ) {
        sessionType = 'logs';
      } else if (
        options.command.includes('port-forward') ||
        options.consoleType === 'k8s-port-forward'
      ) {
        sessionType = 'port-forward';
      }

      // Create Kubernetes session state
      const kubernetesState: KubernetesSessionState = {
        sessionType: sessionType,
        kubeConfig: options.kubernetesOptions,
        connectionState: {
          connected: false,
          reconnectAttempts: 0,
        },
      };

      // Parse Kubernetes-specific options from command and args
      const kubernetesExecOptions = this.parseExecOptions(options);

      if (sessionType === 'exec') {
        await (protocol as any).createExecSession(
          sessionId,
          kubernetesExecOptions
        );
        this.setupExecHandlers(sessionId);
      } else if (sessionType === 'logs') {
        const logOptions = this.parseLogOptions(options);
        await (protocol as any).streamLogs(sessionId, logOptions);
        this.setupLogHandlers(sessionId);
      } else if (sessionType === 'port-forward') {
        const portForwardOptions = this.parsePortForwardOptions(options);
        await (protocol as any).startPortForward(
          sessionId,
          portForwardOptions
        );
        this.setupPortForwardHandlers(sessionId);
      }

      // Update session with Kubernetes state
      const updatedSession = {
        ...session,
        kubernetesState: kubernetesState,
        status: 'running' as const,
        pid: undefined as number | undefined,
      };
      this.host.setSession(sessionId, updatedSession);
      this.host.setOutputBuffer(sessionId, []);

      // Register with health monitoring
      if (this.host.isSelfHealingEnabled()) {
        this.host
          .registerSessionWithHealthMonitoring(
            sessionId,
            updatedSession,
            options
          )
          .catch((error: Error) => {
            this.logger.warn(
              `Failed to register Kubernetes session with health monitoring: ${error.message}`
            );
          });
        this.logger.debug(
          `Kubernetes session ${sessionId} registered for monitoring`
        );
      }

      // Setup stream manager for Kubernetes output
      if (options.streaming) {
        const streamManager = this.host.createStreamManager(sessionId, {
          enableRealTimeCapture: true,
          immediateFlush: true,
          bufferFlushInterval: 5,
          pollingInterval: 25,
          chunkCombinationTimeout: 10,
          maxChunkSize: 4096,
        });
        this.host.setStreamManager(sessionId, streamManager);
      } else {
        const streamManager = this.host.createStreamManager(sessionId, {
          enableRealTimeCapture: true,
          immediateFlush: true,
          bufferFlushInterval: 10,
          pollingInterval: 50,
          chunkCombinationTimeout: 15,
          maxChunkSize: 8192,
        });
        this.host.setStreamManager(sessionId, streamManager);
      }

      // Update session manager
      const currentContext = (protocol as any).getCurrentContext();
      await this.host.updateSessionStatus(sessionId, 'running', {
        kubernetesContext: currentContext.context,
        kubernetesNamespace: currentContext.namespace,
        sessionType: sessionType,
      });

      this.host.emitEvent({
        sessionId,
        type: 'started',
        timestamp: new Date(),
        data: {
          command: options.command,
          type: 'kubernetes',
          context: currentContext.context,
          namespace: currentContext.namespace,
          sessionType: sessionType,
        },
      });

      this.logger.info(
        `Kubernetes ${sessionType} session ${sessionId} created: ${options.command}`
      );

      return sessionId;
    } catch (error) {
      this.logger.error(
        `Kubernetes session creation failed for ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Send input to a Kubernetes session. Only exec sessions support input.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    if (!this.protocol) {
      throw new Error('Kubernetes protocol not initialized');
    }

    const session = this.host.getSession(sessionId);
    if (!session || !session.kubernetesState) {
      throw new Error(`Kubernetes session ${sessionId} not found`);
    }

    try {
      if (session.kubernetesState.sessionType === 'exec') {
        await (this.protocol as any).sendInput(sessionId, input);

        this.host.emitEvent({
          sessionId,
          type: 'input',
          timestamp: new Date(),
          data: { input },
        });
      } else {
        throw new Error(
          `Input not supported for Kubernetes ${session.kubernetesState.sessionType} sessions`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send input to Kubernetes session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Parse Kubernetes exec options from session options.
   */
  parseExecOptions(options: SessionOptions): KubernetesExecOptions {
    const args = options.args || [];
    const kubernetesOptions: KubernetesExecOptions = {
      namespace: options.kubernetesOptions?.namespace,
      interactive: true,
      stdin: true,
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      switch (arg) {
        case '-n':
        case '--namespace':
          kubernetesOptions.namespace = args[i + 1];
          i++;
          break;
        case '-c':
        case '--container':
          kubernetesOptions.containerName = args[i + 1];
          i++;
          break;
        case '-l':
        case '--selector':
          kubernetesOptions.labelSelector = args[i + 1];
          i++;
          break;
        default:
          if (!kubernetesOptions.name && !arg.startsWith('-')) {
            kubernetesOptions.name = arg;
          }
          break;
      }
    }

    return kubernetesOptions;
  }

  /**
   * Parse Kubernetes log options from session options.
   */
  parseLogOptions(options: SessionOptions): KubernetesLogOptions {
    const args = options.args || [];
    const logOptions: KubernetesLogOptions = {
      namespace: options.kubernetesOptions?.namespace,
      follow: true,
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      switch (arg) {
        case '-n':
        case '--namespace':
          logOptions.namespace = args[i + 1];
          i++;
          break;
        case '-c':
        case '--container':
          logOptions.containerName = args[i + 1];
          i++;
          break;
        case '-l':
        case '--selector':
          logOptions.labelSelector = args[i + 1];
          i++;
          break;
        case '-f':
        case '--follow':
          logOptions.follow = true;
          break;
        case '--tail':
          logOptions.tail = parseInt(args[i + 1]);
          i++;
          break;
        case '--since':
          logOptions.since = args[i + 1];
          i++;
          break;
        case '--timestamps':
          logOptions.timestamps = true;
          break;
        case '--previous':
          logOptions.previous = true;
          break;
        default:
          if (!logOptions.podName && !arg.startsWith('-')) {
            logOptions.podName = arg;
          }
          break;
      }
    }

    return logOptions;
  }

  /**
   * Parse port-forward options from session options.
   */
  parsePortForwardOptions(options: SessionOptions): PortForwardOptions {
    const args = options.args || [];
    let podName = '';
    let localPort = 0;
    let remotePort = 0;
    let namespace = options.kubernetesOptions?.namespace;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' || arg === '--namespace') {
        namespace = args[i + 1];
        i++;
      } else if (!arg.startsWith('-')) {
        if (!podName) {
          podName = arg;
        } else if (arg.includes(':')) {
          const ports = arg.split(':');
          localPort = parseInt(ports[0]);
          remotePort = parseInt(ports[1]);
        }
      }
    }

    return {
      podName,
      localPort,
      remotePort,
      namespace,
    };
  }

  /**
   * Setup event handlers for Kubernetes exec sessions.
   */
  private setupExecHandlers(sessionId: string): void {
    if (!this.protocol) return;

    this.protocol.on(
      'sessionCreated',
      ({ sessionId: k8sSessionId }: { sessionId: string; sessionState: string }) => {
        if (k8sSessionId === sessionId) {
          this.logger.debug(`Kubernetes exec session ${sessionId} established`);
        }
      }
    );

    this.protocol.on(
      'sessionClosed',
      ({ sessionId: k8sSessionId }: { sessionId: string }) => {
        if (k8sSessionId === sessionId) {
          this.handleSessionClosed(sessionId);
        }
      }
    );
  }

  /**
   * Setup event handlers for Kubernetes log streaming.
   */
  private setupLogHandlers(sessionId: string): void {
    if (!this.protocol) return;

    this.protocol.on(
      'logData',
      ({ streamId, data, raw }: { streamId: string; podName: string; data: string; raw: string }) => {
        if (streamId === sessionId) {
          this.handleLogData(sessionId, data, raw);
        }
      }
    );

    this.protocol.on('logError', ({ streamId, error }: { streamId: string; error: Error }) => {
      if (streamId === sessionId) {
        this.handleLogError(sessionId, error);
      }
    });

    this.protocol.on('logEnd', ({ streamId }: { streamId: string }) => {
      if (streamId === sessionId) {
        this.handleLogEnd(sessionId);
      }
    });
  }

  /**
   * Setup event handlers for Kubernetes port forwarding.
   */
  private setupPortForwardHandlers(sessionId: string): void {
    if (!this.protocol) return;

    this.protocol.on(
      'portForwardStarted',
      ({ portForwardId, localPort, remotePort }: { portForwardId: string; localPort: number; remotePort: number }) => {
        if (portForwardId === sessionId) {
          this.logger.info(
            `Port forward ${sessionId} started: ${localPort} -> ${remotePort}`
          );
        }
      }
    );

    this.protocol.on('portForwardStopped', ({ portForwardId }: { portForwardId: string }) => {
      if (portForwardId === sessionId) {
        this.handlePortForwardStopped(sessionId);
      }
    });
  }

  /**
   * Handle Kubernetes session closed.
   */
  private handleSessionClosed(sessionId: string): void {
    const session = this.host.getSession(sessionId);
    if (session) {
      this.host.deleteSession(sessionId);
    }

    this.host.emitEvent({
      sessionId,
      type: 'stopped',
      timestamp: new Date(),
      data: { reason: 'kubernetes_session_closed' },
    });

    this.logger.info(`Kubernetes session ${sessionId} closed`);
  }

  /**
   * Handle Kubernetes log data.
   */
  private handleLogData(sessionId: string, data: string, raw: string): void {
    const output: ConsoleOutput = {
      sessionId,
      type: 'stdout',
      data: data,
      timestamp: new Date(),
      raw: raw,
    };

    const buffer = this.host.getOutputBuffer(sessionId) || [];
    buffer.push(output);
    this.host.setOutputBuffer(sessionId, buffer);

    const streamManager = this.host.getStreamManager(sessionId);
    if (streamManager) {
      streamManager.processOutput(output);
    }

    this.host.emitEvent({
      sessionId,
      type: 'output',
      timestamp: new Date(),
      data: output,
    });
  }

  /**
   * Handle Kubernetes log error.
   */
  private handleLogError(sessionId: string, error: Error): void {
    const output: ConsoleOutput = {
      sessionId,
      type: 'stderr',
      data: error.message,
      timestamp: new Date(),
    };

    const buffer = this.host.getOutputBuffer(sessionId) || [];
    buffer.push(output);
    this.host.setOutputBuffer(sessionId, buffer);

    this.host.emitEvent({
      sessionId,
      type: 'error',
      timestamp: new Date(),
      data: { error: error.message },
    });

    this.logger.error(`Kubernetes log error for session ${sessionId}:`, error);
  }

  /**
   * Handle Kubernetes log stream end.
   */
  private handleLogEnd(sessionId: string): void {
    const session = this.host.getSession(sessionId);
    if (session) {
      this.host.deleteSession(sessionId);
    }

    this.host.emitEvent({
      sessionId,
      type: 'stopped',
      timestamp: new Date(),
      data: { reason: 'log_stream_ended' },
    });

    this.logger.info(`Kubernetes log stream ${sessionId} ended`);
  }

  /**
   * Handle Kubernetes port forward stopped.
   */
  private handlePortForwardStopped(sessionId: string): void {
    const session = this.host.getSession(sessionId);
    if (session) {
      this.host.deleteSession(sessionId);
    }

    this.host.emitEvent({
      sessionId,
      type: 'stopped',
      timestamp: new Date(),
      data: { reason: 'port_forward_stopped' },
    });

    this.logger.info(`Kubernetes port forward ${sessionId} stopped`);
  }

  /**
   * Get Kubernetes health status for diagnostics.
   * Returns health info if the protocol is active, null otherwise.
   */
  async getHealthStatus(): Promise<Record<string, unknown> | null> {
    if (!this.protocol) {
      return null;
    }

    try {
      const kubernetesHealth = await (this.protocol as any).performHealthCheck();
      return {
        type: 'kubernetes',
        status: kubernetesHealth.status,
        overallScore: kubernetesHealth.overallScore,
        checks: kubernetesHealth.checks,
        context: (this.protocol as any).getCurrentContext(),
        activeSessions: (this.protocol as any).getActiveSessions().length,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        type: 'kubernetes',
        status: 'critical',
        error: (error as Error).message,
        timestamp: new Date(),
      };
    }
  }
}
