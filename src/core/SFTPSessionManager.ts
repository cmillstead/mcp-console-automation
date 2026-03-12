import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type { IProtocol } from './IProtocol.js';
import type {
  ConsoleSession,
  SessionOptions,
  FileTransferSession,
  SFTPSessionOptions,
  SFTPTransferOptions,
} from '../types/index.js';

/**
 * Manages SFTP/SCP file transfer sessions.
 * Extracted from ConsoleManager to isolate SFTP-specific logic
 * and eliminate the legacy sftpProtocols / fileTransferSessions fields.
 *
 * Key pattern difference from singleton-based managers:
 * creates a NEW protocol instance per session via host.getProtocolFactory().createProtocol('sftp'),
 * rather than using a shared singleton. The base class ensureProtocol() is NOT used.
 *
 * Owns:
 *   - sftpProtocols: Map<string, IProtocol>  (was Map<string, any> in ConsoleManager)
 *   - fileTransferSessions: Map<string, FileTransferSession>
 */
export class SFTPSessionManager extends ProtocolSessionManagerBase {
  private sftpProtocols: Map<string, IProtocol> = new Map();
  private fileTransferSessions: Map<string, FileTransferSession> = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'sftp');
  }

  /**
   * Set up global event handlers for the singleton protocol.
   * SFTP uses per-session protocols, so this is intentionally a no-op.
   * Event handlers are wired per-session in createSession().
   */
  protected setupEventHandlers(): void {
    // No-op: SFTP uses per-session protocol instances, not a singleton.
  }

  /**
   * Wire up event handlers for a specific SFTP session's protocol instance.
   */
  private setupSFTPEventHandlers(sessionId: string, sftpProtocol: IProtocol): void {
    sftpProtocol.on('connected', (connectionState: string) => {
      this.logger.info(`SFTP session ${sessionId} connected`);
      this.host.emitTypedEvent('sftp-connected', { sessionId, connectionState });
    });

    sftpProtocol.on('transfer-progress', (progress: { status: string; transferredBytes?: number }) => {
      this.updateTransferSessionStats(sessionId, progress);
      this.host.emitTypedEvent('sftp-transfer-progress', { sessionId, progress });
    });

    sftpProtocol.on('error', (error: Error) => {
      this.logger.error(`SFTP session ${sessionId} error:`, error);
      this.host.emitTypedEvent('sftp-error', { sessionId, error });
    });
  }

  /**
   * Update transfer statistics for a session based on progress events.
   */
  private updateTransferSessionStats(
    sessionId: string,
    progress: { status: string; transferredBytes?: number }
  ): void {
    const transferSession = this.fileTransferSessions.get(sessionId);
    if (!transferSession) return;

    if (progress.status === 'completed') {
      transferSession.transferStats.successfulTransfers++;
      transferSession.transferStats.totalBytesTransferred += progress.transferredBytes || 0;
    } else if (progress.status === 'failed') {
      transferSession.transferStats.failedTransfers++;
    }
  }

  /**
   * Cleanup SFTP session resources (disconnect protocol, remove tracking entries).
   */
  async cleanupSFTPSession(sessionId: string): Promise<void> {
    try {
      const sftpProtocol = this.sftpProtocols.get(sessionId);
      if (sftpProtocol) {
        await (sftpProtocol as any).disconnect();
        this.sftpProtocols.delete(sessionId);
      }
      this.fileTransferSessions.delete(sessionId);
    } catch (error) {
      this.logger.error(`Error cleaning up SFTP session ${sessionId}:`, error);
    }
  }

  /**
   * Create an SFTP/SCP file transfer session.
   *
   * Creates a new per-session protocol instance via the protocol factory,
   * wires up event handlers, connects, and tracks the session.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (!options.sshOptions) {
      throw new Error('SSH options are required for SFTP/SCP session');
    }

    try {
      this.logger.info(
        `Creating SFTP session: ${sessionId} for ${options.sshOptions.host}`
      );

      const sftpOptions: SFTPSessionOptions = {
        ...options.sshOptions,
        maxConcurrentTransfers: 3,
        transferQueue: {
          maxSize: 100,
          priorityLevels: 4,
          timeoutMs: 300000,
        },
        bandwidth: {
          adaptiveThrottling: true,
        },
        compressionLevel: 6,
        keepAlive: {
          enabled: true,
          interval: 30000,
          maxMissed: 3,
        },
      };

      // Create a new protocol instance per-session (not a singleton)
      const sftpProtocol = (await this.host.getProtocolFactory().createProtocol('sftp')) as IProtocol;
      this.setupSFTPEventHandlers(sessionId, sftpProtocol);
      await (sftpProtocol as any).connect();
      this.sftpProtocols.set(sessionId, sftpProtocol);

      const fileTransferSession: FileTransferSession = {
        ...session,
        protocol: options.consoleType as 'sftp' | 'scp',
        sftpOptions,
        activeTransfers: new Map(),
        transferQueue: [],
        connectionState: (sftpProtocol as any).getConnectionState(),
        transferStats: {
          totalTransfers: 0,
          successfulTransfers: 0,
          failedTransfers: 0,
          totalBytesTransferred: 0,
          averageSpeed: 0,
        },
      };

      this.fileTransferSessions.set(sessionId, fileTransferSession);

      // Update session status via host (host-level operation)
      session.status = 'running';
      this.host.setSession(sessionId, session);

      this.host.emitTypedEvent('session-started', {
        sessionId,
        type: 'sftp',
        options: sftpOptions,
      });
      this.logger.info(`SFTP session created successfully: ${sessionId}`);

      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create SFTP session ${sessionId}:`, error);
      await this.cleanupSFTPSession(sessionId);
      throw error;
    }
  }

  /**
   * Get the SFTP protocol instance for a session.
   */
  getSFTPProtocol(sessionId: string): IProtocol | undefined {
    return this.sftpProtocols.get(sessionId);
  }

  /**
   * Upload a file via SFTP.
   */
  async uploadFile(
    sessionId: string,
    localPath: string,
    remotePath: string,
    options?: SFTPTransferOptions
  ): Promise<unknown> {
    const sftpProtocol = this.getSFTPProtocol(sessionId);
    if (!sftpProtocol) {
      throw new Error(`SFTP session not found: ${sessionId}`);
    }
    return await (sftpProtocol as any).uploadFile(localPath, remotePath, options);
  }

  /**
   * Download a file via SFTP.
   */
  async downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string,
    options?: SFTPTransferOptions
  ): Promise<unknown> {
    const sftpProtocol = this.getSFTPProtocol(sessionId);
    if (!sftpProtocol) {
      throw new Error(`SFTP session not found: ${sessionId}`);
    }
    return await (sftpProtocol as any).downloadFile(remotePath, localPath, options);
  }

  /**
   * Get the number of tracked SFTP protocol instances.
   */
  getSessionCount(): number {
    return this.sftpProtocols.size;
  }

  /**
   * Override destroy to clean up all per-session protocols and tracking maps.
   */
  override async destroy(): Promise<void> {
    // Disconnect all active SFTP protocol instances
    for (const [sessionId, protocol] of this.sftpProtocols) {
      try {
        if (typeof (protocol as any).disconnect === 'function') {
          await (protocol as any).disconnect();
        }
      } catch (e) {
        this.logger.warn(
          `Error disconnecting SFTP protocol for session ${sessionId}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.sftpProtocols.clear();
    this.fileTransferSessions.clear();
    // Note: do NOT call super.destroy() here because we manage per-session protocols,
    // not the single this.protocol field that super.destroy() would attempt to clean up.
  }
}
