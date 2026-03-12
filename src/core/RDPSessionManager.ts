import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  ConsoleOutput,
  SessionOptions,
  RDPSession,
} from '../types/index.js';

/**
 * Manages RDP protocol sessions.
 * Extracted from ConsoleManager to isolate RDP-specific logic
 * and eliminate the legacy rdpProtocol / rdpSessions fields.
 *
 * Owns its own rdpSessions map for tracking active RDP sessions.
 */
export class RDPSessionManager extends ProtocolSessionManagerBase {
  private rdpSessions: Map<string, RDPSession> = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'rdp');
  }

  /**
   * Set up event handlers for the RDP protocol.
   * Called automatically by ensureProtocol() on first use.
   */
  protected setupEventHandlers(): void {
    const protocol = this.protocol;
    if (!protocol) return;

    protocol.on('connected', (session: RDPSession) => {
      this.logger.info(`RDP session connected: ${session.sessionId}`);
      this.rdpSessions.set(session.sessionId, session);
      this.host.emitTypedEvent('rdp-connected', {
        sessionId: session.sessionId,
        session,
      });
    });

    protocol.on('disconnected', (sessionId: string, reason?: string) => {
      this.logger.info(`RDP session disconnected: ${sessionId}`, { reason });
      this.rdpSessions.delete(sessionId);
      this.host.emitTypedEvent('rdp-disconnected', { sessionId, reason });
    });

    protocol.on('error', (sessionId: string, error: Error) => {
      this.logger.error(`RDP session error: ${sessionId}`, error);
      this.host.emitTypedEvent('rdp-error', { sessionId, error });
    });

    protocol.on('output', (output: ConsoleOutput) => {
      this.handleOutput(output);
    });

    protocol.on(
      'screen-update',
      (sessionId: string, imageData: Buffer) => {
        this.host.emitTypedEvent('rdp-screen-update', { sessionId, imageData });
      }
    );

    protocol.on(
      'clipboard-data',
      (sessionId: string, data: string, format: string) => {
        this.host.emitTypedEvent('rdp-clipboard-data', {
          sessionId,
          data,
          format,
        });
      }
    );

    protocol.on(
      'file-transfer-progress',
      (sessionId: string, progress: unknown) => {
        this.host.emitTypedEvent('rdp-file-transfer-progress', {
          sessionId,
          progress,
        });
      }
    );

    protocol.on(
      'performance-metrics',
      (sessionId: string, metrics: unknown) => {
        this.host.emitTypedEvent('rdp-performance-metrics', {
          sessionId,
          metrics,
        });
      }
    );

    this.logger.info('RDP Protocol integration initialized');
  }

  /**
   * Handle RDP output: buffer it and update session lastActivity.
   */
  private handleOutput(output: ConsoleOutput): void {
    const buffer = this.host.getOutputBuffer(output.sessionId) || [];
    buffer.push(output);
    this.host.setOutputBuffer(output.sessionId, buffer);

    this.host.emitEvent({
      sessionId: output.sessionId,
      type: 'output',
      timestamp: new Date(),
      data: output,
    });

    // Update session last activity
    const rdpSession = this.rdpSessions.get(output.sessionId);
    if (rdpSession) {
      rdpSession.lastActivity = new Date();
      this.rdpSessions.set(output.sessionId, rdpSession);
    }
  }

  /**
   * Create an RDP session.
   */
  async createSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    if (!options.rdpOptions) {
      throw new Error('RDP options are required for RDP session');
    }

    try {
      this.logger.info(`Creating RDP session ${sessionId}`, {
        host: options.rdpOptions.host,
        port: options.rdpOptions.port,
        username: options.rdpOptions.username,
      });

      const protocol = await this.ensureProtocol();
      await (protocol as any).createSession({
        command: 'rdp',
        ...options.rdpOptions,
      });

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'running';
        session.pid = undefined; // RDP sessions don't have PIDs
        this.host.setSession(sessionId, session);
      }

      await this.host.updateSessionStatus(sessionId, 'running', {
        rdpHost: options.rdpOptions.host,
        rdpPort: options.rdpOptions.port,
        protocol: options.rdpOptions.protocol,
      });

      this.logger.info(`RDP session ${sessionId} created successfully`);
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create RDP session ${sessionId}:`, error);

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'crashed';
        this.host.setSession(sessionId, session);
      }

      throw error;
    }
  }

  /**
   * Send input to an RDP session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).sendInput(sessionId, input);
    } catch (error) {
      this.logger.error(
        `Failed to send input to RDP session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Send clipboard data to an RDP session.
   */
  async sendClipboardData(
    sessionId: string,
    data: string,
    format: string = 'text'
  ): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).sendClipboardData(sessionId, data, format);
    } catch (error) {
      this.logger.error(
        `Failed to send clipboard data to RDP session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Start a file transfer in an RDP session.
   */
  async startFileTransfer(
    sessionId: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download'
  ): Promise<string> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).startFileTransfer(
        sessionId,
        localPath,
        remotePath,
        direction
      );
    } catch (error) {
      this.logger.error(
        `Failed to start file transfer in RDP session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get an RDP session by ID.
   */
  getSession(sessionId: string): RDPSession | undefined {
    return this.rdpSessions.get(sessionId);
  }

  /**
   * Get RDP protocol capabilities.
   */
  async getCapabilities(): Promise<unknown> {
    const protocol = await this.ensureProtocol();
    return (protocol as any).getCapabilities();
  }

  /**
   * Disconnect an RDP session.
   */
  async disconnectSession(sessionId: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).disconnectSession(sessionId);
      this.rdpSessions.delete(sessionId);
    } catch (error) {
      this.logger.error(
        `Failed to disconnect RDP session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Override destroy to clean up rdpSessions map.
   */
  override async destroy(): Promise<void> {
    this.rdpSessions.clear();
    await super.destroy();
  }
}
