import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  SessionOptions,
  IPCSessionState,
} from '../types/index.js';

/**
 * Manages IPC protocol sessions.
 * Extracted from ConsoleManager to isolate IPC-specific logic
 * and eliminate the legacy ipcProtocols / ipcSessions fields.
 *
 * Currently a stub implementation — IPC session creation is a placeholder.
 * Owns its own ipcSessions map for future tracking of active IPC sessions.
 */
export class IPCSessionManager extends ProtocolSessionManagerBase {
  private ipcSessions: Map<string, IPCSessionState> = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'ipc');
  }

  /**
   * Set up event handlers for the IPC protocol.
   * No-op for this stub implementation.
   */
  protected setupEventHandlers(): void {
    // Stub: no event handlers needed for stub implementation
  }

  /**
   * Create an IPC session (stub implementation).
   */
  async createSession(
    sessionId: string,
    _session: unknown,
    options: SessionOptions
  ): Promise<string> {
    if (!options.ipcOptions) {
      throw new Error('IPC options are required for IPC session');
    }

    try {
      // Implementation placeholder - IPC session creation
      this.logger.info(`Creating IPC session ${sessionId}`);
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create IPC session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Get an IPC session by ID.
   */
  getSession(sessionId: string): IPCSessionState | undefined {
    return this.ipcSessions.get(sessionId);
  }

  /**
   * Get the number of tracked IPC sessions.
   */
  getSessionCount(): number {
    return this.ipcSessions.size;
  }

  /**
   * Override destroy to clean up ipcSessions map.
   */
  override async destroy(): Promise<void> {
    this.ipcSessions.clear();
    await super.destroy();
  }
}
