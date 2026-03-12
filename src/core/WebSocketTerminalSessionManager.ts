import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  ConsoleSession,
  ConsoleOutput,
  SessionOptions,
  WebSocketTerminalSessionState,
} from '../types/index.js';

/**
 * Extended host interface for WebSocketTerminalSessionManager.
 * Adds updateSessionActivity which is needed for input tracking.
 */
export interface WebSocketTerminalSessionHost extends ProtocolSessionHost {
  updateSessionActivity(
    sessionId: string,
    metadata?: Record<string, unknown>
  ): void;
}

/**
 * Manages WebSocket Terminal protocol sessions.
 * Extracted from ConsoleManager to isolate WebSocket terminal-specific logic
 * and eliminate the legacy webSocketTerminalProtocol / webSocketTerminalSessions fields.
 */
export class WebSocketTerminalSessionManager extends ProtocolSessionManagerBase {
  protected declare host: WebSocketTerminalSessionHost;
  private wsSessions: Map<string, WebSocketTerminalSessionState> = new Map();

  constructor(host: WebSocketTerminalSessionHost, logger: Logger) {
    super(host, logger, 'websocket-terminal');
    this.host = host;
  }

  /**
   * Set up event handlers for the WebSocket Terminal protocol.
   */
  protected setupEventHandlers(): void {
    const protocol = this.protocol;
    if (!protocol) return;

    protocol.on('session_connected', (data: { sessionId: string }) => {
      this.logger.info(
        `WebSocket terminal session connected: ${data.sessionId}`
      );
      this.host.emitTypedEvent('websocket-terminal-connected', data);
    });

    protocol.on('session_disconnected', (data: { sessionId: string }) => {
      this.logger.info(
        `WebSocket terminal session disconnected: ${data.sessionId}`
      );
      this.wsSessions.delete(data.sessionId);
      this.host.emitTypedEvent('websocket-terminal-disconnected', data);
    });

    protocol.on('session_reconnecting', (data: { sessionId: string }) => {
      this.logger.info(
        `WebSocket terminal session reconnecting: ${data.sessionId}`
      );
      this.host.emitTypedEvent('websocket-terminal-reconnecting', data);
    });

    protocol.on(
      'data',
      (data: { sessionId: string; data: string | Buffer }) => {
        this.handleOutput(data.sessionId, data.data);
      }
    );

    protocol.on(
      'error',
      (data: { sessionId: string; error: Error }) => {
        this.logger.error(
          `WebSocket terminal session error: ${data.sessionId}`,
          data.error
        );
        this.host.emitTypedEvent('websocket-terminal-error', data);
        this.attemptRecovery(data.sessionId, data.error);
      }
    );

    protocol.on(
      'file_transfer_progress',
      (data: { sessionId: string; transfer: unknown }) => {
        this.host.emitTypedEvent(
          'websocket-terminal-file-transfer-progress',
          data
        );
      }
    );

    protocol.on(
      'multiplex_session_created',
      (data: { sessionId: string; multiplexSession: unknown }) => {
        this.host.emitTypedEvent(
          'websocket-terminal-multiplex-session-created',
          data
        );
      }
    );

    this.logger.info('WebSocket Terminal Protocol integration initialized');
  }

  /**
   * Handle WebSocket Terminal output.
   */
  private handleOutput(sessionId: string, data: string | Buffer): void {
    const output: ConsoleOutput = {
      sessionId,
      type: 'stdout',
      data: typeof data === 'string' ? data : data.toString('utf8'),
      timestamp: new Date(),
      raw: typeof data === 'string' ? data : data.toString('utf8'),
    };

    // Store output in buffer
    const buffer = this.host.getOutputBuffer(sessionId);
    const buf = buffer.length > 0 ? buffer : [];
    buf.push(output);

    // Limit buffer size
    if (buf.length > this.host.getMaxBufferSize()) {
      buf.shift();
    }
    this.host.setOutputBuffer(sessionId, buf);

    // Emit output event
    this.host.emitTypedEvent('output', output);

    // Update session last activity
    const wsSession = this.wsSessions.get(sessionId);
    if (wsSession) {
      wsSession.lastActivity = new Date();
      this.wsSessions.set(sessionId, wsSession);
    }

    // Update active command output
    const session = this.host.getSession(sessionId);
    if (session) {
      const activeCommands = Array.from(
        (session as any).activeCommands?.values() ?? []
      );
      if (activeCommands.length > 0) {
        const latestCommand = activeCommands[activeCommands.length - 1] as any;
        if (latestCommand.status === 'executing') {
          latestCommand.output.push(output);
        }
      }
    }
  }

  /**
   * Attempt automatic recovery for a failed WebSocket terminal session.
   */
  private async attemptRecovery(
    sessionId: string,
    _error: Error
  ): Promise<void> {
    try {
      this.logger.info(
        `Attempting WebSocket terminal recovery for session: ${sessionId}`
      );

      const session = this.host.getSession(sessionId);
      if (!session || !session.webSocketTerminalOptions) {
        this.logger.warn(
          `Cannot recover WebSocket terminal session ${sessionId}: session or options not found`
        );
        return;
      }

      const protocol = this.protocol;
      if (!protocol) {
        this.logger.warn(
          `Cannot recover WebSocket terminal session ${sessionId}: protocol not initialized`
        );
        return;
      }

      // Close existing session
      await (protocol as any).closeSession(sessionId);

      // Wait a moment before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Recreate session
      const wsSession = await (protocol as any).createSession(
        sessionId,
        session.webSocketTerminalOptions
      );
      this.wsSessions.set(sessionId, wsSession.state);

      this.logger.info(
        `WebSocket terminal session ${sessionId} recovered successfully`
      );
      this.host.emitTypedEvent('websocket-terminal-recovered', { sessionId });
    } catch (recoveryError) {
      this.logger.error(
        `Failed to recover WebSocket terminal session ${sessionId}:`,
        recoveryError
      );
      this.host.emitTypedEvent('websocket-terminal-recovery-failed', {
        sessionId,
        error: recoveryError,
      });
    }
  }

  /**
   * Create a WebSocket Terminal session.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (!options.webSocketTerminalOptions) {
      throw new Error(
        'WebSocket Terminal options are required for WebSocket Terminal session'
      );
    }

    try {
      this.logger.info(`Creating WebSocket Terminal session ${sessionId}`, {
        url: options.webSocketTerminalOptions.url,
        protocol: options.webSocketTerminalOptions.protocol,
        terminalType: options.webSocketTerminalOptions.terminalType,
      });

      const protocol = await this.ensureProtocol();

      // Create WebSocket Terminal session through the protocol
      const wsTerminalSession = await (protocol as any).createSession(
        sessionId,
        options.webSocketTerminalOptions
      );

      // Store WebSocket terminal session state
      this.wsSessions.set(sessionId, wsTerminalSession.state);

      // Update console session
      session.status = 'running';
      session.pid = undefined; // WebSocket terminal sessions don't have PIDs
      session.webSocketTerminalState = wsTerminalSession.state;
      this.host.setSession(sessionId, session);

      // Register with session manager
      await this.host.updateSessionStatus(sessionId, 'running', {
        webSocketUrl: options.webSocketTerminalOptions.url,
        protocol: options.webSocketTerminalOptions.protocol,
        terminalType: options.webSocketTerminalOptions.terminalType,
        terminalSize: {
          cols: options.webSocketTerminalOptions.cols || 80,
          rows: options.webSocketTerminalOptions.rows || 24,
        },
      });

      this.logger.info(
        `WebSocket Terminal session ${sessionId} created successfully`
      );
      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create WebSocket Terminal session ${sessionId}:`,
        error
      );

      // Update session status to failed
      session.status = 'crashed';
      this.host.setSession(sessionId, session);

      await this.host.updateSessionStatus(sessionId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Send input to a WebSocket terminal session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    const session = this.host.getSession(sessionId);
    if (!session) {
      throw new Error(`WebSocket terminal session ${sessionId} not found`);
    }

    const webSocketSession = this.wsSessions.get(sessionId);
    if (!webSocketSession) {
      throw new Error(
        `WebSocket terminal session state ${sessionId} not found`
      );
    }

    const protocol = this.protocol;
    if (!protocol) {
      throw new Error('WebSocket terminal protocol not initialized');
    }

    try {
      this.logger.debug(
        `Sending input to WebSocket terminal session ${sessionId}: ${input.substring(0, 50)}...`
      );

      // Send input through WebSocket terminal protocol
      await (protocol as any).sendInput(sessionId, input);

      // Update session state
      webSocketSession.lastActivity = new Date();
      webSocketSession.bytesTransferred =
        (webSocketSession.bytesTransferred || 0) + input.length;
      this.wsSessions.set(sessionId, webSocketSession);

      // Update session activity
      this.host.updateSessionActivity(sessionId, {
        lastActivity: new Date(),
        bytesTransferred: webSocketSession.bytesTransferred,
        inputCount: (webSocketSession as any).inputCount
          ? (webSocketSession as any).inputCount + 1
          : 1,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to send input to WebSocket terminal session ${sessionId}:`,
        error
      );

      // If it's a connection error, try to reconnect
      if (
        error.message.includes('connection') ||
        error.message.includes('websocket')
      ) {
        const wsSession = this.wsSessions.get(sessionId);
        if (wsSession && wsSession.supportsReconnection) {
          this.logger.info(
            `Attempting to reconnect WebSocket terminal session ${sessionId}`
          );
          try {
            await (protocol as any).reconnectSession(sessionId);
            // Retry sending the input after reconnection
            await (protocol as any).sendInput(sessionId, input);
            return;
          } catch (reconnectError) {
            this.logger.error(
              `Failed to reconnect WebSocket terminal session ${sessionId}:`,
              reconnectError
            );
          }
        }
      }

      throw error;
    }
  }

  /**
   * Check whether a session is tracked by this manager.
   */
  hasSession(sessionId: string): boolean {
    return this.wsSessions.has(sessionId);
  }

  /**
   * Clean up all WebSocket terminal sessions.
   */
  clearSessions(): void {
    this.wsSessions.clear();
  }

  /**
   * Override destroy to also clear wsSessions.
   */
  override async destroy(): Promise<void> {
    this.wsSessions.clear();
    await super.destroy();
  }
}
