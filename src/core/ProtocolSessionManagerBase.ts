import { Logger } from '../utils/logger.js';
import type { IProtocol } from './IProtocol.js';
import type { ConsoleType, ConsoleOutput, ConsoleEvent } from '../types/index.js';
import type { StreamManager } from './StreamManager.js';

/**
 * Callback interface that ConsoleManager implements to provide
 * protocol session managers access to shared state and services.
 * Shared by all ProtocolSessionManagerBase subclasses.
 */
export interface ProtocolSessionHost {
  getSession(sessionId: string): any;
  setSession(sessionId: string, session: any): void;
  deleteSession(sessionId: string): void;
  getOutputBuffer(sessionId: string): ConsoleOutput[];
  setOutputBuffer(sessionId: string, buffer: ConsoleOutput[]): void;
  getMaxBufferSize(): number;
  createStreamManager(sessionId: string, options: any): StreamManager;
  setStreamManager(sessionId: string, streamManager: StreamManager): void;
  getStreamManager(sessionId: string): StreamManager | undefined;
  deleteStreamManager(sessionId: string): void;
  updateSessionStatus(sessionId: string, status: string, metadata?: Record<string, unknown>): Promise<void>;
  registerSessionWithHealthMonitoring(sessionId: string, session: any, options: any): Promise<void>;
  emitEvent(event: ConsoleEvent): void;
  emitTypedEvent(eventName: string, data: any): void;
  getProtocolFactory(): any;
  getOrCreateProtocol(type: ConsoleType | string): Promise<IProtocol>;
  getErrorDetector(): any;
  addErrorPatterns(patterns: any[]): void;
  getPromptDetector(): any;
  getPaginationManager(): any;
  isSelfHealingEnabled(): boolean;
  getNextSequenceNumber(sessionId: string): number;
  getLogger(): Logger;
}

/**
 * Abstract base class for protocol session managers.
 * Provides lazy protocol initialization, event handler setup, and cleanup.
 * Extracted from ConsoleManager to reduce its size and isolate protocol-specific logic.
 */
export abstract class ProtocolSessionManagerBase {
  protected protocol: IProtocol | null = null;
  protected host: ProtocolSessionHost;
  protected logger: Logger;
  protected protocolType: ConsoleType | string;

  constructor(host: ProtocolSessionHost, logger: Logger, protocolType: ConsoleType | string) {
    this.host = host;
    this.logger = logger;
    this.protocolType = protocolType;
  }

  /**
   * Lazily initialize the protocol instance and set up event handlers.
   */
  protected async ensureProtocol(): Promise<IProtocol> {
    if (!this.protocol) {
      this.protocol = await this.host.getOrCreateProtocol(this.protocolType);
      this.setupEventHandlers();
    }
    return this.protocol;
  }

  /**
   * Subclasses must implement protocol-specific event handler wiring.
   */
  protected abstract setupEventHandlers(): void;

  /**
   * Clean up the protocol instance.
   */
  async destroy(): Promise<void> {
    if (this.protocol && typeof (this.protocol as any).cleanup === 'function') {
      try {
        await (this.protocol as any).cleanup();
      } catch (e) {
        this.logger.warn(
          `Error cleaning up ${this.protocolType} protocol:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.protocol = null;
  }
}
