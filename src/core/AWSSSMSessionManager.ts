import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  ConsoleOutput,
  SessionOptions,
  AWSSSMConnectionOptions,
} from '../types/index.js';

/**
 * Extended host interface for AWSSSMSessionManager.
 * Adds methods for SSM session ID lookup, heartbeat monitoring,
 * and health check interval tracking.
 */
export interface AWSSSMSessionHost extends ProtocolSessionHost {
  findSessionBySSMId(ssmSessionId: string): any;
  addToHeartbeatMonitor(sessionId: string, info: any): void;
  addHealthCheckInterval(
    sessionId: string,
    interval: ReturnType<typeof setInterval>
  ): void;
}

/**
 * Manages AWS SSM protocol sessions (interactive, port-forwarding, command).
 * Extracted from ConsoleManager to isolate AWS SSM-specific logic
 * and eliminate the legacy awsSSMProtocol field.
 *
 * Owns its own health check intervals and handles session recovery.
 */
export class AWSSSMSessionManager extends ProtocolSessionManagerBase {
  protected declare host: AWSSSMSessionHost;
  private healthCheckIntervals: Map<string, ReturnType<typeof setInterval>> =
    new Map();

  constructor(host: AWSSSMSessionHost, logger: Logger) {
    super(host, logger, 'aws-ssm');
    this.host = host;
  }

  /**
   * Set up event handlers for the AWS SSM protocol.
   * Called automatically by ensureProtocol() on first use.
   */
  protected setupEventHandlers(): void {
    const protocol = this.protocol;
    if (!protocol) return;

    protocol.on('output', (output: ConsoleOutput) => {
      this.handleOutput(output);
    });

    protocol.on(
      'session-started',
      (data: { sessionId: string; instanceId?: string }) => {
        this.logger.info(`AWS SSM session started: ${data.sessionId}`);
        this.host.emitEvent({
          sessionId: data.sessionId,
          type: 'started',
          timestamp: new Date(),
          data,
        });
      }
    );

    protocol.on(
      'session-terminated',
      (data: { sessionId: string }) => {
        this.logger.info(`AWS SSM session terminated: ${data.sessionId}`);
        this.handleSessionTermination(data.sessionId);
      }
    );

    protocol.on(
      'session-error',
      (data: { sessionId: string; error: Error }) => {
        this.logger.error(
          `AWS SSM session error: ${data.sessionId}`,
          data.error
        );
        this.handleSessionError(data.sessionId, data.error);
      }
    );

    protocol.on(
      'port-forwarding-started',
      (data: {
        sessionId: string;
        targetId: string;
        portNumber: number;
        localPortNumber: number;
      }) => {
        this.logger.info(
          `AWS SSM port forwarding started: ${data.sessionId} (${data.targetId}:${data.portNumber} -> localhost:${data.localPortNumber})`
        );
        this.host.emitEvent({
          sessionId: data.sessionId,
          type: 'started',
          timestamp: new Date(),
          data,
        });
      }
    );

    protocol.on(
      'command-sent',
      (data: { commandId: string; documentName: string }) => {
        this.logger.info(
          `AWS SSM command sent: ${data.commandId} (${data.documentName})`
        );
      }
    );

    protocol.on(
      'command-completed',
      (data: { commandId: string; status: string }) => {
        this.logger.info(
          `AWS SSM command completed: ${data.commandId} (${data.status})`
        );
      }
    );

    protocol.on(
      'health-check',
      (data: { status: string; timestamp: Date; error?: unknown }) => {
        if (data.status === 'unhealthy') {
          this.logger.warn(`AWS SSM protocol health check failed:`, data.error);
        }
      }
    );

    protocol.on(
      'session-recovered',
      (data: { sessionId: string }) => {
        this.logger.info(`AWS SSM session recovered: ${data.sessionId}`);
      }
    );

    this.logger.info('AWS SSM protocol event handlers set up');
  }

  /**
   * Create an AWS SSM session, routing to the correct sub-type.
   */
  async createSession(
    sessionId: string,
    session: any,
    options: SessionOptions
  ): Promise<string> {
    if (
      !options.awsSSMOptions &&
      !['aws-ssm', 'ssm-session', 'ssm-tunnel'].includes(
        options.consoleType || ''
      )
    ) {
      throw new Error(
        'AWS SSM options or AWS SSM console type required for AWS SSM session'
      );
    }

    try {
      const protocol = await this.ensureProtocol();

      // Build default SSM config if needed
      if (!options.awsSSMOptions) {
        // consoleType must be one of aws-ssm/ssm-session/ssm-tunnel at this point
        options.awsSSMOptions = {
          region:
            process.env.AWS_REGION ||
            process.env.AWS_DEFAULT_REGION ||
            'us-east-1',
        };
      }

      if (!options.awsSSMOptions.region) {
        options.awsSSMOptions.region =
          process.env.AWS_REGION ||
          process.env.AWS_DEFAULT_REGION ||
          'us-east-1';
      }

      const ssmSessionType = this.determineSessionType(options);

      let ssmSessionId: string;

      switch (ssmSessionType) {
        case 'interactive':
          if (!options.awsSSMOptions?.instanceId) {
            throw new Error(
              'Instance ID is required for interactive SSM sessions'
            );
          }
          ssmSessionId = await (protocol as any).startSession(
            options.awsSSMOptions
          );
          break;

        case 'port-forwarding':
          if (
            !options.awsSSMOptions?.instanceId ||
            !options.awsSSMOptions?.portNumber
          ) {
            throw new Error(
              'Instance ID and port number are required for SSM port forwarding'
            );
          }
          ssmSessionId = await (protocol as any).startPortForwardingSession(
            options.awsSSMOptions.instanceId,
            options.awsSSMOptions.portNumber,
            options.awsSSMOptions.localPortNumber
          );
          break;

        case 'command':
          if (!options.awsSSMOptions?.documentName) {
            throw new Error(
              'Document name is required for SSM command execution'
            );
          }
          ssmSessionId = await (protocol as any).sendCommand(
            options.awsSSMOptions.documentName,
            options.awsSSMOptions.parameters || {},
            options.awsSSMOptions.instanceId
              ? [
                  {
                    type: 'instance',
                    id: options.awsSSMOptions.instanceId,
                  },
                ]
              : undefined
          );
          break;

        default:
          throw new Error(
            `Unsupported AWS SSM session type: ${ssmSessionType}`
          );
      }

      // Update session with SSM-specific information
      session.awsSSMSessionId = ssmSessionId;
      session.awsSSMOptions = options.awsSSMOptions;

      // Store session
      this.host.setSession(sessionId, session);

      // Set up session monitoring
      this.setupSessionMonitoring(sessionId, ssmSessionId);

      this.logger.info(
        `AWS SSM session created: ${sessionId} (SSM: ${ssmSessionId}, type: ${ssmSessionType})`
      );
      this.host.emitTypedEvent('session-created', {
        sessionId,
        type: 'aws-ssm',
        ssmSessionId,
        ssmSessionType,
      });

      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create AWS SSM session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Determine the SSM session type based on options.
   */
  determineSessionType(
    options: SessionOptions
  ): 'interactive' | 'port-forwarding' | 'command' {
    const consoleType = options.consoleType;

    if (consoleType === 'ssm-tunnel' || options.awsSSMOptions?.portNumber) {
      return 'port-forwarding';
    }

    if (consoleType === 'aws-ssm' || consoleType === 'ssm-session') {
      return options.awsSSMOptions?.documentName ? 'command' : 'interactive';
    }

    return 'interactive';
  }

  /**
   * Handle output from the SSM protocol, mapping SSM session ID back to our session ID.
   */
  private handleOutput(output: ConsoleOutput): void {
    const session = this.host.findSessionBySSMId(output.sessionId);
    if (session) {
      const consoleOutput: ConsoleOutput = {
        ...output,
        sessionId: session.id,
      };

      const outputs = this.host.getOutputBuffer(session.id) || [];
      outputs.push(consoleOutput);
      this.host.setOutputBuffer(session.id, outputs);

      const paginationManager = this.host.getPaginationManager();
      if (paginationManager) {
        paginationManager.addOutputs(session.id, [consoleOutput]);
      }

      this.host.emitTypedEvent('output', consoleOutput);
      this.host.emitEvent({
        sessionId: session.id,
        type: 'output',
        timestamp: new Date(),
        data: consoleOutput,
      });

      const errorDetector = this.host.getErrorDetector();
      if (errorDetector) {
        errorDetector.processOutput(consoleOutput);
      }
    }
  }

  /**
   * Handle SSM session termination.
   */
  private handleSessionTermination(ssmSessionId: string): void {
    const session = this.host.findSessionBySSMId(ssmSessionId);
    if (session) {
      this.host.deleteSession(session.id);
      this.clearHealthCheckInterval(session.id);

      this.host.emitEvent({
        sessionId: session.id,
        type: 'stopped',
        timestamp: new Date(),
        data: { ssmSessionId },
      });
    }
  }

  /**
   * Handle SSM session error.
   */
  private handleSessionError(ssmSessionId: string, error: Error): void {
    const session = this.host.findSessionBySSMId(ssmSessionId);
    if (session) {
      session.status = 'crashed';
      this.host.setSession(session.id, session);

      this.host.emitEvent({
        sessionId: session.id,
        type: 'error',
        timestamp: new Date(),
        data: { error: error.message, ssmSessionId },
      });

      if (this.host.isSelfHealingEnabled()) {
        this.attemptSessionRecovery(session.id, ssmSessionId, error);
      }
    }
  }

  /**
   * Set up health monitoring for an SSM session.
   */
  private setupSessionMonitoring(
    sessionId: string,
    ssmSessionId: string
  ): void {
    this.host.addToHeartbeatMonitor(sessionId, {
      id: sessionId,
      status: 'running',
      type: 'aws-ssm',
      createdAt: new Date(),
      lastActivity: new Date(),
      recoveryAttempts: 0,
      maxRecoveryAttempts: 3,
      healthScore: 100,
    });

    const healthCheckInterval = setInterval(async () => {
      try {
        if (this.protocol && !(this.protocol as any).isHealthy()) {
          this.logger.warn(
            `AWS SSM protocol unhealthy, attempting recovery for session ${sessionId}`
          );
          await this.attemptSessionRecovery(
            sessionId,
            ssmSessionId,
            new Error('Protocol unhealthy')
          );
        }
      } catch (e) {
        this.logger.warn(
          `Error during SSM health check for session ${sessionId}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }, 60000);

    this.healthCheckIntervals.set(sessionId, healthCheckInterval);
    this.host.addHealthCheckInterval(sessionId, healthCheckInterval);
  }

  /**
   * Attempt to recover a failed SSM session.
   */
  async attemptSessionRecovery(
    sessionId: string,
    ssmSessionId: string,
    _error: Error
  ): Promise<void> {
    try {
      this.logger.info(`Attempting AWS SSM session recovery for ${sessionId}`);

      const session = this.host.getSession(sessionId);
      if (!session || !session.awsSSMOptions) {
        this.logger.warn(
          `Cannot recover AWS SSM session ${sessionId}: session or options not found`
        );
        return;
      }

      const protocol = this.protocol;
      if (!protocol) {
        this.logger.warn(
          `Cannot recover AWS SSM session ${sessionId}: protocol not initialized`
        );
        return;
      }

      try {
        await (protocol as any).terminateSession(ssmSessionId);
      } catch (terminateError) {
        this.logger.warn(
          `Failed to terminate old SSM session ${ssmSessionId}:`,
          terminateError
        );
      }

      const ssmSessionType = this.determineSessionType({
        consoleType: session.type,
        awsSSMOptions: session.awsSSMOptions,
        command: session.command || '/bin/bash',
      });

      let newSsmSessionId: string;

      switch (ssmSessionType) {
        case 'interactive':
          newSsmSessionId = await (protocol as any).startSession(
            session.awsSSMOptions
          );
          break;
        case 'port-forwarding':
          newSsmSessionId =
            await (protocol as any).startPortForwardingSession(
              session.awsSSMOptions.instanceId!,
              session.awsSSMOptions.portNumber!,
              session.awsSSMOptions.localPortNumber
            );
          break;
        case 'command':
          newSsmSessionId = await (protocol as any).sendCommand(
            session.awsSSMOptions.documentName!,
            session.awsSSMOptions.parameters || {},
            session.awsSSMOptions.instanceId
              ? [
                  {
                    type: 'instance',
                    id: session.awsSSMOptions.instanceId,
                  },
                ]
              : undefined
          );
          break;
      }

      session.awsSSMSessionId = newSsmSessionId;
      session.status = 'running';
      this.host.setSession(sessionId, session);

      this.logger.info(
        `AWS SSM session recovery successful: ${sessionId} (new SSM: ${newSsmSessionId!})`
      );
      this.host.emitTypedEvent('session-recovered', {
        sessionId,
        newSsmSessionId: newSsmSessionId!,
        ssmSessionType,
      });
    } catch (recoveryError) {
      this.logger.error(
        `AWS SSM session recovery failed for ${sessionId}:`,
        recoveryError
      );

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'crashed';
        this.host.setSession(sessionId, session);
      }
    }
  }

  /**
   * Send input to an AWS SSM session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    if (!this.protocol) {
      throw new Error('AWS SSM protocol not initialized');
    }

    const session = this.host.getSession(sessionId);
    if (!session || !session.awsSSMSessionId) {
      throw new Error(
        `AWS SSM session ${sessionId} not found or SSM session ID missing`
      );
    }

    try {
      await (this.protocol as any).sendInput(session.awsSSMSessionId, input);

      this.host.emitEvent({
        sessionId,
        type: 'input',
        timestamp: new Date(),
        data: { input },
      });

      this.logger.debug(
        `Sent input to AWS SSM session ${sessionId}: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to send input to AWS SSM session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Clear a health check interval for a session.
   */
  private clearHealthCheckInterval(sessionId: string): void {
    const interval = this.healthCheckIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(sessionId);
    }
  }

  /**
   * Override destroy to clean up health check intervals.
   */
  override async destroy(): Promise<void> {
    for (const [, interval] of this.healthCheckIntervals) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
    await super.destroy();
  }
}
