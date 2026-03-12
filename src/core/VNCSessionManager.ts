import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type { IProtocol } from './IProtocol.js';
import type {
  ConsoleSession,
  ConsoleOutput,
  SessionOptions,
  VNCSession,
  VNCFramebuffer,
  VNCSecurityType,
} from '../types/index.js';
import { StreamManager } from './StreamManager.js';

/**
 * Extended host interface for VNCSessionManager.
 * Adds handleSessionError() for VNC connection error recovery.
 */
export interface VNCSessionHost extends ProtocolSessionHost {
  handleSessionError(sessionId: string, error: Error, operation: string): Promise<boolean>;
}

/**
 * Manages VNC remote desktop sessions.
 * Extracted from ConsoleManager to isolate VNC-specific logic
 * and eliminate the legacy vncProtocols / vncSessions / vncFramebuffers fields.
 *
 * Key pattern: creates a NEW protocol instance per session via
 * host.getProtocolFactory().createProtocol('vnc'), not a shared singleton.
 * The base class ensureProtocol() is NOT used; setupEventHandlers() is a no-op.
 *
 * Owns:
 *   - vncProtocols: Map<string, IProtocol>   (was Map<string, any>)
 *   - vncSessions: Map<string, VNCSession>
 *   - vncFramebuffers: Map<string, VNCFramebuffer>
 */
export class VNCSessionManager extends ProtocolSessionManagerBase {
  private vncProtocols: Map<string, IProtocol> = new Map();
  private vncSessions: Map<string, VNCSession> = new Map();
  private vncFramebuffers: Map<string, VNCFramebuffer> = new Map();

  protected declare host: VNCSessionHost;

  constructor(host: VNCSessionHost, logger: Logger) {
    super(host, logger, 'vnc');
    this.host = host;
  }

  /**
   * Set up global event handlers for the singleton protocol.
   * VNC uses per-session protocols, so this is intentionally a no-op.
   * Event handlers are wired per-session in createSession().
   */
  protected setupEventHandlers(): void {
    // No-op: VNC uses per-session protocol instances, not a singleton.
  }

  /**
   * Map an auth method string to a VNCSecurityType.
   */
  mapAuthMethodToVNCSecurityType(authMethod?: string): VNCSecurityType {
    switch (authMethod) {
      case 'none':
        return 'none';
      case 'vnc':
        return 'vnc';
      case 'tight':
        return 'tight';
      case 'ultra':
        return 'ultra';
      case 'tls':
        return 'tls';
      case 'vencrypt':
        return 'vencrypt';
      case 'ra2':
        return 'ra2';
      case 'ra2ne':
        return 'ra2ne';
      case 'sasl':
        return 'sasl';
      default:
        return 'vnc';
    }
  }

  /**
   * Wire up per-session VNC event handlers on the given protocol instance.
   */
  private setupVNCEventHandlers(sessionId: string, vncProtocol: IProtocol): void {
    // Handle framebuffer updates
    (vncProtocol as any).on(
      'framebuffer-update',
      (update: { data: Buffer; width: number; height: number; encoding: string }) => {
        const framebuffer = this.vncFramebuffers.get(sessionId);
        if (framebuffer) {
          framebuffer.data = update.data;
          framebuffer.lastUpdate = new Date();
          this.vncFramebuffers.set(sessionId, framebuffer);

          this.host.emitEvent({
            sessionId,
            type: 'vnc-framebuffer-update',
            timestamp: new Date(),
            data: {
              width: update.width,
              height: update.height,
              encoding: update.encoding,
            },
          });
        }
      }
    );

    // Handle VNC server messages — buffer as console output
    (vncProtocol as any).on('server-message', (message: { text?: string }) => {
      const output: ConsoleOutput = {
        sessionId,
        type: 'stdout',
        data: message.text || JSON.stringify(message),
        timestamp: new Date(),
        raw: JSON.stringify(message),
      };

      const outputBuffer = this.host.getOutputBuffer(sessionId);
      outputBuffer.push(output);
      this.host.setOutputBuffer(sessionId, outputBuffer);

      this.host.emitTypedEvent('output', output);
    });

    // Handle clipboard updates
    (vncProtocol as any).on('clipboard-update', (clipboardData: string) => {
      this.host.emitEvent({
        sessionId,
        type: 'vnc-clipboard-update',
        timestamp: new Date(),
        data: { content: clipboardData },
      });
    });

    // Handle connection errors
    (vncProtocol as any).on('error', (error: Error) => {
      this.logger.error(`VNC session ${sessionId} error:`, error);
      this.host.handleSessionError(sessionId, error, 'vnc-connection');
    });

    // Handle disconnection
    (vncProtocol as any).on('disconnect', () => {
      this.logger.info(`VNC session ${sessionId} disconnected`);
      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'terminated';
        this.host.setSession(sessionId, session);
      }

      this.host.emitEvent({
        sessionId,
        type: 'terminated',
        timestamp: new Date(),
        data: { reason: 'vnc-disconnect' },
      });
    });
  }

  /**
   * Create a VNC remote desktop session.
   *
   * Creates a new per-session protocol instance via the protocol factory,
   * wires up event handlers, initialises the framebuffer, and tracks the session.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (!options.vncOptions) {
      throw new Error('VNC options are required for VNC session');
    }

    try {
      this.logger.info(`Creating VNC session ${sessionId}`, {
        host: options.vncOptions.host,
        port: options.vncOptions.port,
        rfbProtocolVersion: options.vncOptions.rfbProtocolVersion,
        encoding: options.vncOptions.encoding,
      });

      // Create a new protocol instance per-session (not a singleton)
      const vncProtocol = (await this.host
        .getProtocolFactory()
        .createProtocol('vnc')) as IProtocol;
      this.vncProtocols.set(sessionId, vncProtocol);

      // Create VNC session via the protocol
      const connectedSession = await (vncProtocol as any).createSession(options);

      // Build VNCSession state
      const vncSession: VNCSession = {
        sessionId,
        connectionId: (connectedSession as any).connectionId || sessionId,
        status: 'connected',
        host: options.vncOptions.host,
        port: options.vncOptions.port || 5900,
        protocolVersion: options.vncOptions.rfbProtocolVersion || 'auto',
        serverName: (connectedSession as any).serverName || 'VNC Server',
        securityType:
          this.mapAuthMethodToVNCSecurityType(options.vncOptions.authMethod) || 'vnc',
        sharedConnection: options.vncOptions.sharedConnection || false,
        viewOnlyMode: options.vncOptions.viewOnly || false,
        supportedEncodings: (connectedSession as any).supportedEncodings || ['raw'],
        serverCapabilities: (connectedSession as any).serverCapabilities || {
          cursorShapeUpdates: false,
          richCursor: false,
          desktopResize: false,
          continuousUpdates: false,
          fence: false,
          fileTransfer: false,
          clipboardTransfer: false,
          audio: false,
        },
        connectionTime: new Date(),
        lastActivity: new Date(),
        framebufferInfo: {
          width: 0,
          height: 0,
          pixelFormat: {
            bitsPerPixel: 32,
            depth: 24,
            bigEndianFlag: false,
            trueColorFlag: true,
            redMax: 255,
            greenMax: 255,
            blueMax: 255,
            redShift: 16,
            greenShift: 8,
            blueShift: 0,
          },
        },
        statistics: {
          bytesReceived: 0,
          bytesSent: 0,
          framebufferUpdates: 0,
          keyboardEvents: 0,
          mouseEvents: 0,
          clipboardTransfers: 0,
          fileTransfers: 0,
          avgFrameRate: 0,
          bandwidth: 0,
          compression: 0,
          latency: 0,
        },
        errorCount: 0,
        warnings: [],
        monitors: options.vncOptions.monitors || [
          {
            id: 0,
            primary: true,
            x: 0,
            y: 0,
            width: 1024,
            height: 768,
          },
        ],
      };

      this.vncSessions.set(sessionId, vncSession);

      // Initialise framebuffer
      const framebuffer: VNCFramebuffer = {
        width: vncSession.framebufferInfo.width,
        height: vncSession.framebufferInfo.height,
        pixelFormat: vncSession.framebufferInfo.pixelFormat,
        data: Buffer.alloc(0),
        lastUpdate: new Date(),
        encoding: options.vncOptions.encoding || ['raw'],
        compressionLevel: options.vncOptions.compressionLevel || 6,
      };

      this.vncFramebuffers.set(sessionId, framebuffer);

      // Update console session status via host
      const updatedSession = { ...session };
      updatedSession.status = 'running';
      (updatedSession as any).pid = undefined;
      (updatedSession as any).vncOptions = options.vncOptions;
      this.host.setSession(sessionId, updatedSession);

      // Initialise output buffer
      this.host.setOutputBuffer(sessionId, []);

      // Set up output streaming if requested
      if (options.streaming) {
        const streamManager = new StreamManager(sessionId);
        this.host.setStreamManager(sessionId, streamManager);
      }

      // Register with session manager
      await this.host.updateSessionStatus(sessionId, 'running', {
        vncHost: options.vncOptions.host,
        vncPort: options.vncOptions.port,
        rfbVersion: options.vncOptions.rfbProtocolVersion,
        securityType: options.vncOptions.authMethod,
        encoding: options.vncOptions.encoding,
      });

      // Wire up event handlers
      this.setupVNCEventHandlers(sessionId, vncProtocol);

      // Emit session-started event
      this.host.emitEvent({
        sessionId,
        type: 'started',
        timestamp: new Date(),
        data: {
          host: options.vncOptions.host,
          port: options.vncOptions.port,
          encoding: options.vncOptions.encoding,
          vnc: true,
        },
      });

      this.logger.info(`VNC session ${sessionId} created successfully`);
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create VNC session ${sessionId}:`, error);

      // Clean up failed session
      this.vncProtocols.delete(sessionId);
      this.vncSessions.delete(sessionId);
      this.vncFramebuffers.delete(sessionId);

      // Update session status to crashed
      const updatedSession = { ...session };
      updatedSession.status = 'crashed';
      this.host.setSession(sessionId, updatedSession);

      throw error;
    }
  }

  /**
   * Get the VNC protocol instance for a session.
   */
  getVNCProtocol(sessionId: string): IProtocol | undefined {
    return this.vncProtocols.get(sessionId);
  }

  /**
   * Get the VNC session state.
   */
  getVNCSession(sessionId: string): VNCSession | undefined {
    return this.vncSessions.get(sessionId);
  }

  /**
   * Get the framebuffer state for a session.
   */
  getFramebuffer(sessionId: string): VNCFramebuffer | undefined {
    return this.vncFramebuffers.get(sessionId);
  }

  /**
   * Get the number of tracked VNC protocol instances.
   */
  getSessionCount(): number {
    return this.vncProtocols.size;
  }

  /**
   * Cleanup VNC session resources (disconnect protocol, remove tracking entries).
   */
  async cleanupSession(sessionId: string): Promise<void> {
    try {
      const vncProtocol = this.vncProtocols.get(sessionId);
      if (vncProtocol) {
        if (typeof (vncProtocol as any).disconnect === 'function') {
          await (vncProtocol as any).disconnect();
        }
        this.vncProtocols.delete(sessionId);
      }
      this.vncSessions.delete(sessionId);
      this.vncFramebuffers.delete(sessionId);
    } catch (error) {
      this.logger.error(`Error cleaning up VNC session ${sessionId}:`, error);
    }
  }

  /**
   * Override destroy to clean up all per-session protocols and tracking maps.
   */
  override async destroy(): Promise<void> {
    for (const [sessionId, protocol] of this.vncProtocols) {
      try {
        if (typeof (protocol as any).disconnect === 'function') {
          await (protocol as any).disconnect();
        }
      } catch (e) {
        this.logger.warn(
          `Error disconnecting VNC protocol for session ${sessionId}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.vncProtocols.clear();
    this.vncSessions.clear();
    this.vncFramebuffers.clear();
    // Note: do NOT call super.destroy() because we manage per-session protocols,
    // not the single this.protocol field that super.destroy() would clean up.
  }
}
