import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type { IProtocol } from './IProtocol.js';
import type {
  ConsoleOutput,
  SessionOptions,
  WinRMSessionState,
} from '../types/index.js';

/**
 * Manages WinRM protocol sessions.
 * Extracted from ConsoleManager to isolate WinRM-specific logic
 * and eliminate the legacy winrmProtocols / winrmSessions fields.
 *
 * Key pattern difference from singleton-based managers:
 * creates a NEW protocol instance per session via host.getProtocolFactory().createProtocol('winrm'),
 * rather than using a shared singleton. The base class ensureProtocol() is NOT used.
 *
 * Owns:
 *   - winrmProtocols: Map<string, IProtocol>  (was Map<string, any> in ConsoleManager)
 *   - winrmSessions: Map<string, WinRMSessionState>
 */
export class WinRMSessionManager extends ProtocolSessionManagerBase {
  private winrmProtocols: Map<string, IProtocol> = new Map();
  private winrmSessions: Map<string, WinRMSessionState> = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'winrm');
  }

  /**
   * Set up global event handlers for the singleton protocol.
   * WinRM uses per-session protocols, so this is intentionally a no-op.
   * Event handlers are wired per-session in createSession().
   */
  protected setupEventHandlers(): void {
    // No-op: WinRM uses per-session protocol instances, not a singleton.
  }

  /**
   * Create a WinRM session.
   *
   * Creates a new per-session protocol instance via the protocol factory,
   * builds session state, and tracks the session.
   */
  async createSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    if (!options.winrmOptions) {
      throw new Error('WinRM options are required for WinRM session');
    }

    try {
      this.logger.info(`Creating WinRM session ${sessionId}`, {
        host: options.winrmOptions.host,
        port: options.winrmOptions.port,
        username: options.winrmOptions.username,
        authType: options.winrmOptions.authType,
      });

      // Create a new protocol instance per-session (not a singleton)
      const winrmProtocol = (await this.host
        .getProtocolFactory()
        .createProtocol('winrm')) as IProtocol;
      this.winrmProtocols.set(sessionId, winrmProtocol);

      // Create WinRM session via the protocol
      await (winrmProtocol as any).createSession(options);

      // Build WinRM session state
      const winrmSessionState: WinRMSessionState = {
        sessionId,
        status: 'running',
        host: options.winrmOptions.host,
        port:
          options.winrmOptions.port ||
          (options.winrmOptions.protocol === 'https' ? 5986 : 5985),
        protocol: options.winrmOptions.protocol || 'https',
        authType: options.winrmOptions.authType || 'negotiate',
        username: options.winrmOptions.username,
        connectedAt: new Date(),
        lastActivity: new Date(),
        shells: new Map(),
        activeCommands: new Map(),
        transferredFiles: [],
        performanceCounters: {
          commandsExecuted: 0,
          bytesTransferred: 0,
          averageResponseTime: 0,
          errorCount: 0,
          reconnections: 0,
        },
        isConnected: true,
      };

      this.winrmSessions.set(sessionId, winrmSessionState);

      // Update host-level console session
      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'running';
        session.pid = undefined; // WinRM sessions don't have PIDs
        this.host.setSession(sessionId, session);
      }

      // Register with session manager
      await this.host.updateSessionStatus(sessionId, 'running', {
        winrmHost: options.winrmOptions.host,
        winrmPort: options.winrmOptions.port,
        protocol: options.winrmOptions.protocol,
        authType: options.winrmOptions.authType,
      });

      this.logger.info(`WinRM session ${sessionId} created successfully`);
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create WinRM session ${sessionId}:`, error);

      // Clean up failed session
      this.winrmProtocols.delete(sessionId);
      this.winrmSessions.delete(sessionId);

      // Update session status to failed
      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'crashed';
        this.host.setSession(sessionId, session);
      }

      throw error;
    }
  }

  /**
   * Send input to a WinRM session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    const winrmProtocol = this.winrmProtocols.get(sessionId);
    if (!winrmProtocol) {
      throw new Error(`WinRM protocol not found for session ${sessionId}`);
    }

    const session = this.host.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const winrmSession = this.winrmSessions.get(sessionId);
    if (!winrmSession) {
      throw new Error(`WinRM session state not found for session ${sessionId}`);
    }

    try {
      // Determine if input is a PowerShell command or regular command
      const isPowerShellCommand = input
        .trim()
        .match(
          /^(Get-|Set-|New-|Remove-|Invoke-|Import-|Export-|Start-|Stop-|Restart-|Test-|\$)/i
        );

      if (isPowerShellCommand) {
        // Execute as PowerShell command
        await (winrmProtocol as any).executeCommand(sessionId, input.trim());
      } else {
        // Execute as regular command
        await (winrmProtocol as any).executeCommand(sessionId, input.trim());
      }

      // Update session activity
      winrmSession.lastActivity = new Date();
      winrmSession.performanceCounters!.commandsExecuted++;
      this.winrmSessions.set(sessionId, winrmSession);

      // Emit input event
      this.host.emitEvent({
        sessionId,
        type: 'input',
        timestamp: new Date(),
        data: { input, isPowerShell: isPowerShellCommand },
      });

      this.logger.debug(
        `Sent input to WinRM session ${sessionId}: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`
      );
    } catch (error) {
      // Update error count
      if (winrmSession) {
        winrmSession.performanceCounters!.errorCount++;
        this.winrmSessions.set(sessionId, winrmSession);
      }

      this.logger.error(
        `Failed to send input to WinRM session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Handle WinRM output: buffer it, assign a sequence number, emit the output
   * event, and update session lastActivity / bytesTransferred.
   */
  handleOutput(sessionId: string, output: ConsoleOutput): void {
    // Store output in buffer
    const buffer = this.host.getOutputBuffer(sessionId) || [];
    buffer.push(output);
    this.host.setOutputBuffer(sessionId, buffer);

    // Assign sequence number via host
    output.sequence = this.host.getNextSequenceNumber(sessionId);

    // Emit output event
    this.host.emitEvent({
      sessionId,
      type: 'output',
      timestamp: new Date(),
      data: output,
    });

    // Update session last activity
    const winrmSession = this.winrmSessions.get(sessionId);
    if (winrmSession) {
      winrmSession.lastActivity = new Date();

      // Update performance counters
      if (output.data) {
        winrmSession.performanceCounters!.bytesTransferred += output.data.length;
      }

      this.winrmSessions.set(sessionId, winrmSession);
    }

    this.logger.debug(
      `WinRM output for session ${sessionId}: ${output.type} - ${output.data?.substring(0, 100)}${(output.data?.length || 0) > 100 ? '...' : ''}`
    );
  }

  /**
   * Clean up a WinRM session (called from ConsoleManager.stopSession).
   * Closes the per-session protocol instance and removes tracking entries.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    try {
      const winrmProtocol = this.winrmProtocols.get(sessionId);
      if (winrmProtocol) {
        await (winrmProtocol as any).closeSession(sessionId);
        this.winrmProtocols.delete(sessionId);
      }
      this.winrmSessions.delete(sessionId);
      this.logger.info(`WinRM session ${sessionId} stopped and cleaned up`);
    } catch (error) {
      this.logger.error(`Error stopping WinRM session ${sessionId}:`, error);
    }
  }

  /**
   * Get the WinRM session state for a session.
   */
  getSession(sessionId: string): WinRMSessionState | undefined {
    return this.winrmSessions.get(sessionId);
  }

  /**
   * Get the number of tracked WinRM protocol instances.
   */
  getSessionCount(): number {
    return this.winrmProtocols.size;
  }

  /**
   * Override destroy to clean up all per-session protocols and tracking maps.
   */
  override async destroy(): Promise<void> {
    // Close all active WinRM protocol instances
    for (const [sessionId, protocol] of this.winrmProtocols) {
      try {
        if (typeof (protocol as any).closeSession === 'function') {
          await (protocol as any).closeSession(sessionId);
        } else if (typeof (protocol as any).cleanup === 'function') {
          await (protocol as any).cleanup();
        }
      } catch (e) {
        this.logger.warn(
          `Error closing WinRM protocol for session ${sessionId}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.winrmProtocols.clear();
    this.winrmSessions.clear();
    // Note: do NOT call super.destroy() here because we manage per-session protocols,
    // not the single this.protocol field that super.destroy() would attempt to clean up.
  }
}
