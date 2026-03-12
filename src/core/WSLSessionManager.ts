import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type {
  ConsoleSession,
  ConsoleOutput,
  SessionOptions,
  WSLDistribution,
  WSLSystemInfo,
  WSLHealthStatus,
  WSLConfig,
} from '../types/index.js';

/**
 * Manages WSL protocol sessions.
 * Extracted from ConsoleManager to isolate WSL-specific logic
 * and eliminate the legacy wslProtocol field.
 *
 * Uses the singleton protocol pattern: the protocol is initialized
 * once via ensureProtocol() and reused for all sessions.
 */
export class WSLSessionManager extends ProtocolSessionManagerBase {
  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'wsl');
  }

  /**
   * Set up event handlers for the WSL protocol.
   * WSL does not emit custom events beyond what BaseProtocol provides,
   * so this is a no-op but satisfies the abstract contract.
   */
  protected setupEventHandlers(): void {
    // WSL protocol does not expose custom EventEmitter events
    this.logger.info('WSL Protocol integration initialized');
  }

  /**
   * Initialize WSL integration (ensures protocol is ready).
   * Mirrors the original setupWSLIntegration() in ConsoleManager.
   * Swallows errors so WSL unavailability is non-fatal.
   */
  async setupWSLIntegration(): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).initialize();
      this.logger.info('WSL integration setup completed');
    } catch (error) {
      this.logger.warn('WSL integration setup failed:', error);
    }
  }

  /**
   * Create a WSL session.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    try {
      if (!options.wslOptions) {
        throw new Error('WSL options are required for WSL session');
      }

      this.logger.info(
        `Creating WSL session ${sessionId} with distribution: ${options.wslOptions.distribution || 'default'}`
      );

      const protocol = await this.ensureProtocol();

      // Create WSL session using the protocol
      const wslSession = await (protocol as any).createSession(options);

      // Update the session with WSL-specific properties
      const updatedSession = { ...session, ...wslSession };
      this.host.setSession(sessionId, updatedSession);
      this.host.setOutputBuffer(sessionId, []);

      // Setup output streaming if requested
      if (options.streaming) {
        const streamManager = this.host.createStreamManager(sessionId, options);
        this.host.setStreamManager(sessionId, streamManager);
      }

      // Emit session started event
      this.host.emitEvent({
        sessionId,
        type: 'started',
        timestamp: new Date(),
        data: {
          distribution: options.wslOptions.distribution,
          wslVersion: options.wslOptions.wslVersion,
          wsl: true,
        },
      });

      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create WSL session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Send input to a WSL session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    try {
      const session = this.host.getSession(sessionId);
      if (!session) {
        throw new Error(`WSL session ${sessionId} not found`);
      }

      this.logger.debug(
        `Sending input to WSL session ${sessionId}: ${input.substring(0, 50)}...`
      );

      const protocol = this.protocol;
      if (!protocol) {
        throw new Error('WSL protocol not initialized');
      }

      // Send input through WSL protocol — uses executeCommand for stdin handling
      const result = await (protocol as any).executeCommand(sessionId, input);

      // Create output events for stdout and stderr
      if (result.stdout) {
        const output: ConsoleOutput = {
          sessionId,
          type: 'stdout',
          data: result.stdout,
          timestamp: new Date(),
          raw: result.stdout,
        };

        const outputBuffer = this.host.getOutputBuffer(sessionId) || [];
        outputBuffer.push(output);
        this.host.setOutputBuffer(sessionId, outputBuffer);

        this.host.emitTypedEvent('output', output);
      }

      if (result.stderr) {
        const output: ConsoleOutput = {
          sessionId,
          type: 'stderr',
          data: result.stderr,
          timestamp: new Date(),
          raw: result.stderr,
        };

        const outputBuffer = this.host.getOutputBuffer(sessionId) || [];
        outputBuffer.push(output);
        this.host.setOutputBuffer(sessionId, outputBuffer);

        this.host.emitTypedEvent('output', output);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send input to WSL session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Resize the WSL terminal for the given session.
   */
  async resizeTerminal(
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const protocol = this.protocol;
    if (protocol && 'resizeTerminal' in protocol) {
      await (protocol as any).resizeTerminal(sessionId, cols, rows);
    }
  }

  /**
   * Get installed WSL distributions.
   */
  async getWSLDistributions(): Promise<WSLDistribution[]> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).getInstalledDistributions();
    } catch (error) {
      this.logger.error('Failed to get WSL distributions:', error);
      throw error;
    }
  }

  /**
   * Get WSL system information.
   */
  async getWSLSystemInfo(): Promise<WSLSystemInfo> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).getSystemInfo();
    } catch (error) {
      this.logger.error('Failed to get WSL system info:', error);
      throw error;
    }
  }

  /**
   * Start a WSL distribution.
   */
  async startWSLDistribution(distribution: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).startDistribution(distribution);
      this.logger.info(`Started WSL distribution: ${distribution}`);
    } catch (error) {
      this.logger.error(
        `Failed to start WSL distribution ${distribution}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Stop a WSL distribution.
   */
  async stopWSLDistribution(distribution: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).stopDistribution(distribution);
      this.logger.info(`Stopped WSL distribution: ${distribution}`);
    } catch (error) {
      this.logger.error(
        `Failed to stop WSL distribution ${distribution}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get WSL health status for a distribution.
   */
  async getWSLHealthStatus(distribution: string): Promise<WSLHealthStatus> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).getHealthStatus(distribution);
    } catch (error) {
      this.logger.error(
        `Failed to get WSL health status for ${distribution}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Translate a path between Windows and Linux.
   */
  async translateWSLPath(
    path: string,
    direction: 'windows-to-linux' | 'linux-to-windows'
  ): Promise<string> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).translatePath(path, direction);
    } catch (error) {
      this.logger.error(`Failed to translate WSL path ${path}:`, error);
      throw error;
    }
  }

  /**
   * Check whether WSL is available.
   * Returns false on any error (non-fatal availability check).
   */
  async isWSLAvailable(): Promise<boolean> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).checkWSLAvailability();
    } catch (error) {
      this.logger.error('Failed to check WSL availability:', error);
      return false;
    }
  }

  /**
   * Get WSL configuration.
   */
  async getWSLConfig(): Promise<WSLConfig> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).getWSLConfig();
    } catch (error) {
      this.logger.error('Failed to get WSL configuration:', error);
      throw error;
    }
  }
}
