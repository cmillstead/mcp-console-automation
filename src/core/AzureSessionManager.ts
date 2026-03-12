import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import { AzureMonitoring } from '../monitoring/AzureMonitoring.js';
import type {
  ConsoleOutput,
  SessionOptions,
  AzureTokenInfo,
} from '../types/index.js';

/**
 * Manages Azure protocol sessions (Cloud Shell, Bastion, Arc).
 * Extracted from ConsoleManager to isolate Azure-specific logic
 * and eliminate the legacy azureProtocol / azureMonitoring fields.
 *
 * Owns its own AzureMonitoring instance for metrics, health checks,
 * and cost tracking.
 */
export class AzureSessionManager extends ProtocolSessionManagerBase {
  private azureMonitoring: AzureMonitoring;

  constructor(host: ProtocolSessionHost, logger: Logger, azureMonitoring?: AzureMonitoring) {
    super(host, logger, 'azure');
    this.azureMonitoring = azureMonitoring ?? new AzureMonitoring(logger.getWinstonLogger());
  }

  /**
   * Set up event handlers for the Azure protocol.
   * Called automatically by ensureProtocol() on first use.
   */
  protected setupEventHandlers(): void {
    const protocol = this.protocol;
    if (!protocol) return;

    protocol.on('connected', (sessionId: string) => {
      this.logger.info(`Azure session connected: ${sessionId}`);
      this.host.emitTypedEvent('azure-connected', { sessionId });
      this.azureMonitoring.recordConnectionEvent(sessionId, 'success');
    });

    protocol.on('disconnected', (sessionId: string) => {
      this.logger.info(`Azure session disconnected: ${sessionId}`);
      this.host.emitTypedEvent('azure-disconnected', { sessionId });
      this.azureMonitoring.unregisterSession(sessionId);
    });

    protocol.on('error', (sessionId: string, error: Error) => {
      this.logger.error(`Azure session error: ${sessionId}`, error);
      this.host.emitTypedEvent('azure-error', { sessionId, error });

      // Record error for monitoring
      if (error.message.includes('auth')) {
        this.azureMonitoring.recordErrorEvent('authentication', error);
      } else if (error.message.includes('network')) {
        this.azureMonitoring.recordErrorEvent('network', error);
      } else {
        this.azureMonitoring.recordErrorEvent('api', error);
      }

      this.azureMonitoring.recordConnectionEvent(sessionId, 'failure');
    });

    protocol.on('output', (sessionId: string, output: ConsoleOutput) => {
      // Forward Azure output to the console system
      const outputBuffer = this.host.getOutputBuffer(sessionId) || [];
      outputBuffer.push(output);

      if (outputBuffer.length > this.host.getMaxBufferSize()) {
        outputBuffer.shift();
      }

      this.host.setOutputBuffer(sessionId, outputBuffer);
      this.host.emitEvent({
        sessionId,
        type: 'output',
        timestamp: new Date(),
        data: output,
      });
    });

    protocol.on(
      'token-refreshed',
      (sessionId: string, tokenInfo: AzureTokenInfo) => {
        this.logger.debug(`Azure token refreshed for session: ${sessionId}`);
        this.host.emitTypedEvent('azure-token-refreshed', {
          sessionId,
          tokenInfo,
        });
        this.azureMonitoring.recordAuthenticationEvent(
          'token-refresh',
          tokenInfo
        );
      }
    );

    protocol.on('session-ready', (sessionId: string) => {
      this.logger.info(`Azure session ready: ${sessionId}`);
      this.host.emitTypedEvent('azure-session-ready', { sessionId });
    });

    protocol.on('reconnecting', (sessionId: string, attempt: number) => {
      this.logger.info(
        `Azure session reconnecting: ${sessionId} (attempt ${attempt})`
      );
      this.host.emitTypedEvent('azure-reconnecting', { sessionId, attempt });
    });

    this.logger.info('Azure protocol integration setup completed');
  }

  /**
   * Create an Azure session, routing to the correct sub-type based on consoleType.
   */
  async createSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    const consoleType = options.consoleType || 'azure-shell';

    switch (consoleType) {
      case 'azure-shell':
        return await this.createCloudShellSession(sessionId, options);
      case 'azure-bastion':
        return await this.createBastionSession(sessionId, options);
      case 'azure-ssh':
        return await this.createArcSession(sessionId, options);
      default:
        return await this.createCloudShellSession(sessionId, options);
    }
  }

  /**
   * Create Azure Cloud Shell session.
   */
  async createCloudShellSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    if (!options.azureOptions) {
      throw new Error(
        'Azure options are required for Azure Cloud Shell session'
      );
    }

    try {
      this.logger.info(`Creating Azure Cloud Shell session: ${sessionId}`);

      const protocol = await this.ensureProtocol();
      const azureSession = await (protocol as any).createCloudShellSession(
        sessionId,
        options.azureOptions
      );

      this.azureMonitoring.registerSession(azureSession);

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'running';
        session.type = 'azure-shell';
        this.host.setSession(sessionId, session);
      }

      await this.host.registerSessionWithHealthMonitoring(
        sessionId,
        session!,
        options
      );

      this.logger.info(
        `Azure Cloud Shell session created successfully: ${sessionId}`
      );
      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create Azure Cloud Shell session: ${sessionId}`,
        error
      );
      throw error;
    }
  }

  /**
   * Create Azure Bastion session.
   */
  async createBastionSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    if (!options.azureOptions) {
      throw new Error('Azure options are required for Azure Bastion session');
    }

    try {
      this.logger.info(`Creating Azure Bastion session: ${sessionId}`);

      const protocol = await this.ensureProtocol();
      const azureSession = await (protocol as any).createBastionSession(
        sessionId,
        options.azureOptions
      );

      this.azureMonitoring.registerSession(azureSession);

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'running';
        session.type = 'azure-bastion';
        this.host.setSession(sessionId, session);
      }

      await this.host.registerSessionWithHealthMonitoring(
        sessionId,
        session!,
        options
      );

      this.logger.info(
        `Azure Bastion session created successfully: ${sessionId}`
      );
      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create Azure Bastion session: ${sessionId}`,
        error
      );
      throw error;
    }
  }

  /**
   * Create Azure Arc session.
   */
  async createArcSession(
    sessionId: string,
    options: SessionOptions
  ): Promise<string> {
    if (!options.azureOptions) {
      throw new Error('Azure options are required for Azure Arc session');
    }

    try {
      this.logger.info(`Creating Azure Arc session: ${sessionId}`);

      const protocol = await this.ensureProtocol();
      const azureSession = await (protocol as any).createArcSession(
        sessionId,
        options.azureOptions
      );

      this.azureMonitoring.registerSession(azureSession);

      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'running';
        session.type = 'azure-ssh';
        this.host.setSession(sessionId, session);
      }

      await this.host.registerSessionWithHealthMonitoring(
        sessionId,
        session!,
        options
      );

      this.logger.info(`Azure Arc session created successfully: ${sessionId}`);
      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create Azure Arc session: ${sessionId}`,
        error
      );
      throw error;
    }
  }

  /**
   * Send input to an Azure session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).sendInput(sessionId, input);
    } catch (error) {
      this.logger.error(
        `Failed to send input to Azure session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Cleanup an Azure session.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).closeSession(sessionId);
      this.logger.info(`Azure session cleaned up: ${sessionId}`);
    } catch (error) {
      this.logger.error(
        `Failed to cleanup Azure session ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Get Azure session metrics.
   */
  getSessionMetrics(sessionId: string): Record<string, unknown> {
    if (!this.protocol) {
      return {};
    }
    return (this.protocol as any).getSessionMetrics(sessionId);
  }

  /**
   * Check Azure session health.
   */
  async checkSessionHealth(sessionId: string): Promise<boolean> {
    if (!this.protocol) {
      return false;
    }
    return await (this.protocol as any).healthCheck(sessionId);
  }

  /**
   * Resize Azure session terminal.
   */
  async resizeSession(
    sessionId: string,
    rows: number,
    cols: number
  ): Promise<void> {
    try {
      const protocol = await this.ensureProtocol();
      await (protocol as any).resizeTerminal(sessionId, rows, cols);
    } catch (error) {
      this.logger.error(
        `Failed to resize Azure session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get Azure monitoring metrics.
   */
  getMonitoringMetrics() {
    return this.azureMonitoring.getMetrics();
  }

  /**
   * Perform Azure health check.
   */
  async performHealthCheck() {
    return await this.azureMonitoring.performHealthCheck();
  }

  /**
   * Update Azure cost estimates for a session.
   */
  updateCostEstimate(sessionId: string, costEstimate: number) {
    this.azureMonitoring.updateCostEstimates(sessionId, costEstimate);
  }

  /**
   * Override destroy to clean up AzureMonitoring.
   */
  override async destroy(): Promise<void> {
    // AzureMonitoring extends EventEmitter — remove all listeners
    if (this.azureMonitoring) {
      this.azureMonitoring.removeAllListeners();
    }
    await super.destroy();
  }
}
