import { Logger } from '../utils/logger.js';
import {
  ProtocolSessionManagerBase,
  ProtocolSessionHost,
} from './ProtocolSessionManagerBase.js';
import type { IProtocol } from './IProtocol.js';
import type {
  ConsoleSession,
  SessionOptions,
  IPMISessionState,
  IPMIConnectionOptions,
} from '../types/index.js';

/**
 * Manages IPMI/BMC sessions.
 * Extracted from ConsoleManager to isolate IPMI-specific logic
 * and eliminate the legacy ipmiProtocols / ipmiSessions / ipmiMonitoringIntervals fields.
 *
 * Key pattern: creates a NEW protocol instance per session via host.getProtocolFactory().createProtocol('ipmi').
 * Event handlers attach to the ipmiSession object returned by protocol.createSession(),
 * NOT to the protocol itself. This is unique among all managers.
 *
 * Owns:
 *   - ipmiProtocols: Map<string, IProtocol>  (was Map<string, any> in ConsoleManager)
 *   - ipmiSessions: Map<string, IPMISessionState>
 *   - ipmiMonitoringIntervals: Map<string, NodeJS.Timeout | NodeJS.Timeout[]>
 */
export class IPMISessionManager extends ProtocolSessionManagerBase {
  private ipmiProtocols: Map<string, IProtocol> = new Map();
  private ipmiSessions: Map<string, IPMISessionState> = new Map();
  private ipmiMonitoringIntervals: Map<
    string,
    NodeJS.Timeout | NodeJS.Timeout[]
  > = new Map();

  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'ipmi');
  }

  /**
   * Set up global event handlers on the singleton protocol.
   * IPMI uses per-session protocols with events on the ipmiSession object,
   * so this is intentionally a no-op.
   */
  protected setupEventHandlers(): void {
    // No-op: IPMI uses per-session protocol instances and session-level event objects.
  }

  /**
   * Create an IPMI session.
   *
   * Creates a new per-session protocol instance via the protocol factory,
   * wires up event handlers on the ipmiSession object (not the protocol),
   * and optionally starts monitoring.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (!options.ipmiOptions) {
      throw new Error('IPMI options are required for IPMI session');
    }

    try {
      this.logger.info(`Creating IPMI session ${sessionId}`, {
        host: options.ipmiOptions.host,
        port: options.ipmiOptions.port,
        username: options.ipmiOptions.username,
        ipmiVersion: options.ipmiOptions.ipmiVersion,
        privilegeLevel: options.ipmiOptions.privilegeLevel,
      });

      // Create IPMI protocol instance (per-session, not singleton)
      const ipmiProtocol = (await this.host
        .getProtocolFactory()
        .createProtocol('ipmi')) as IProtocol;
      this.ipmiProtocols.set(sessionId, ipmiProtocol);

      const ipmiSession = await (ipmiProtocol as any).createSession({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env: options.env,
        streaming: options.streaming || true,
        timeout: options.timeout,
        detectErrors: options.detectErrors,
        ...options.ipmiOptions,
      });

      // Update console session
      session.status = 'running';
      session.pid = undefined; // IPMI sessions don't have PIDs
      this.host.setSession(sessionId, session);

      // Wire event handlers on the ipmiSession object (not the protocol)
      this.setupIPMIEventHandlers(sessionId, ipmiSession);

      // Register with session manager
      await this.host.updateSessionStatus(sessionId, 'running', {
        host: options.ipmiOptions.host,
        port: options.ipmiOptions.port,
        ipmiVersion: options.ipmiOptions.ipmiVersion,
        privilegeLevel: options.ipmiOptions.privilegeLevel,
        cipherSuite: options.ipmiOptions.cipherSuite,
        interface: options.ipmiOptions.interface,
      });

      // Start IPMI monitoring if enabled
      if (options.monitoring?.enableMetrics) {
        await this.startIPMIMonitoring(sessionId, options.ipmiOptions);
      }

      this.logger.info(`IPMI session ${sessionId} created successfully`);
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create IPMI session ${sessionId}:`, error);

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
   * Wire up event handlers for a specific IPMI session.
   * NOTE: Events attach to `ipmiSession` (EventEmitter-like object returned by
   * protocol.createSession()), NOT to the protocol itself.
   */
  private setupIPMIEventHandlers(sessionId: string, ipmiSession: any): void {
    // Handle session output
    ipmiSession.on(
      'output',
      (data: { type: 'stdout' | 'stderr'; data: string }) => {
        this.host.emitTypedEvent('output', {
          sessionId,
          type: data.type,
          data: data.data,
          timestamp: new Date(),
        });
      }
    );

    // Handle SOL console data
    ipmiSession.on('sol-data', (data: Buffer) => {
      this.host.emitTypedEvent('output', {
        sessionId,
        type: 'stdout',
        data: data.toString(),
        timestamp: new Date(),
      });
    });

    // Handle sensor data
    ipmiSession.on('sensor-data', (sensorData: unknown) => {
      this.host.emitTypedEvent('sensor-data', {
        sessionId,
        sensorData,
        timestamp: new Date(),
      });
    });

    // Handle power state changes
    ipmiSession.on('power-state-change', (state: string) => {
      this.host.emitTypedEvent('power-state-change', {
        sessionId,
        powerState: state,
        timestamp: new Date(),
      });
    });

    // Handle IPMI events
    ipmiSession.on('ipmi-event', (event: unknown) => {
      this.host.emitTypedEvent('ipmi-event', {
        sessionId,
        event,
        timestamp: new Date(),
      });
    });

    // Handle session errors
    ipmiSession.on('error', (error: Error) => {
      this.logger.error(`IPMI session ${sessionId} error:`, error);
      this.host.emitTypedEvent('sessionError', {
        sessionId,
        error: error.message,
        timestamp: new Date(),
      });
    });

    // Handle session close
    ipmiSession.on('close', () => {
      void this.handleIPMISessionClosed(sessionId);
    });
  }

  /**
   * Start IPMI monitoring (sensor polling every 30s, event log polling every 60s).
   */
  private async startIPMIMonitoring(
    sessionId: string,
    _options: IPMIConnectionOptions
  ): Promise<void> {
    try {
      // Start sensor monitoring
      const sensorInterval = setInterval(async () => {
        try {
          const sensors = await this.readIPMISensors(sessionId);
          if (sensors && sensors.length > 0) {
            this.host.emitTypedEvent('sensor-readings', {
              sessionId,
              sensors,
              timestamp: new Date(),
            });
          }
        } catch (error) {
          this.logger.warn(
            `Failed to read sensors for session ${sessionId}:`,
            error
          );
        }
      }, 30000); // Default 30 second polling interval

      // Start event log monitoring
      const eventInterval = setInterval(async () => {
        try {
          const events = await this.getIPMIEventLog(sessionId);
          if (events && events.length > 0) {
            events.forEach((event) => {
              this.host.emitTypedEvent('ipmi-event', {
                sessionId,
                event,
                timestamp: new Date(),
              });
            });
          }
        } catch (error) {
          this.logger.warn(
            `Failed to read event log for session ${sessionId}:`,
            error
          );
        }
      }, 60000); // Default 60 second polling interval

      // Store intervals for cleanup
      this.ipmiMonitoringIntervals.set(sessionId, [
        sensorInterval,
        eventInterval,
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to start IPMI monitoring for session ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Handle IPMI session closed event.
   */
  private async handleIPMISessionClosed(sessionId: string): Promise<void> {
    try {
      this.logger.info(`IPMI session ${sessionId} closed`);

      // Clean up monitoring intervals
      const intervals = this.ipmiMonitoringIntervals.get(sessionId);
      if (intervals) {
        if (Array.isArray(intervals)) {
          intervals.forEach((interval) => clearInterval(interval));
        } else {
          clearInterval(intervals);
        }
        this.ipmiMonitoringIntervals.delete(sessionId);
      }

      // Update session status
      const session = this.host.getSession(sessionId);
      if (session) {
        session.status = 'closed';
        this.host.setSession(sessionId, session);
      }

      // Clean up session data
      this.ipmiSessions.delete(sessionId);

      // Update session manager
      await this.host.updateSessionStatus(sessionId, 'terminated');

      // Emit session closed event
      this.host.emitTypedEvent('sessionClosed', sessionId);
    } catch (error) {
      this.logger.error(
        `Error handling IPMI session close for ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Send input to IPMI session (SOL console).
   */
  async sendIPMIInput(sessionId: string, input: string): Promise<void> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      await (ipmiProtocol as any).sendInput(sessionId, input);

      this.logger.debug(
        `Input sent to IPMI session ${sessionId}: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to send input to IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Execute IPMI power control operation.
   */
  async executeIPMIPowerControl(
    sessionId: string,
    operation: 'on' | 'off' | 'reset' | 'cycle' | 'status'
  ): Promise<unknown> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      const result = await (ipmiProtocol as any).executeCommand(
        sessionId,
        'chassis',
        ['power', operation]
      );

      this.logger.info(
        `Power control operation '${operation}' executed on IPMI session ${sessionId}`
      );

      // Emit power state change event
      this.host.emitTypedEvent('power-state-change', {
        sessionId,
        operation,
        result,
        timestamp: new Date(),
      });

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to execute power control operation '${operation}' on IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Read IPMI sensors.
   */
  async readIPMISensors(sessionId: string): Promise<unknown[]> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      // Execute sensor reading command
      await (ipmiProtocol as any).executeCommand(sessionId, 'sensor', [
        'reading',
        'all',
      ]);

      // Since executeCommand returns void, return a placeholder array
      // In a real implementation, this would be handled via events or callbacks
      const sensors: unknown[] = [];
      this.logger.debug(
        `Executed sensor reading command for IPMI session ${sessionId}`
      );

      return sensors;
    } catch (error) {
      this.logger.error(
        `Failed to read sensors from IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get IPMI system event log.
   */
  async getIPMIEventLog(sessionId: string): Promise<unknown[]> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      // Execute event log reading command
      await (ipmiProtocol as any).executeCommand(sessionId, 'sel', ['list']);

      // Since executeCommand returns void, return a placeholder array
      // In a real implementation, this would be handled via events or callbacks
      const events: unknown[] = [];
      this.logger.debug(
        `Executed event log reading command for IPMI session ${sessionId}`
      );

      return events;
    } catch (error) {
      this.logger.error(
        `Failed to read event log from IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Mount virtual media via IPMI.
   */
  async mountIPMIVirtualMedia(
    sessionId: string,
    mediaType: 'cd' | 'floppy' | 'usb',
    imageUrl: string
  ): Promise<void> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      await (ipmiProtocol as any).executeCommand(sessionId, 'sol', [
        'mount',
        mediaType,
        imageUrl,
      ]);

      this.logger.info(
        `Virtual media '${mediaType}' mounted from '${imageUrl}' on IPMI session ${sessionId}`
      );

      // Emit virtual media event
      this.host.emitTypedEvent('virtual-media-mounted', {
        sessionId,
        mediaType,
        imageUrl,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to mount virtual media on IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Unmount virtual media via IPMI.
   */
  async unmountIPMIVirtualMedia(
    sessionId: string,
    mediaType: 'cd' | 'floppy' | 'usb'
  ): Promise<void> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      await (ipmiProtocol as any).executeCommand(sessionId, 'sol', [
        'unmount',
        mediaType,
      ]);

      this.logger.info(
        `Virtual media '${mediaType}' unmounted from IPMI session ${sessionId}`
      );

      // Emit virtual media event
      this.host.emitTypedEvent('virtual-media-unmounted', {
        sessionId,
        mediaType,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to unmount virtual media on IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Update firmware via IPMI.
   */
  async updateIPMIFirmware(
    sessionId: string,
    firmwareType: 'bios' | 'bmc' | 'fpga',
    firmwarePath: string
  ): Promise<void> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      this.logger.info(
        `Starting firmware update for '${firmwareType}' on IPMI session ${sessionId}`
      );

      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      await (ipmiProtocol as any).executeCommand(sessionId, 'hpm', [
        'upgrade',
        firmwarePath,
        'component',
        firmwareType,
      ]);

      this.logger.info(
        `Firmware update for '${firmwareType}' completed on IPMI session ${sessionId}`
      );

      // Emit firmware update event
      this.host.emitTypedEvent('firmware-update-completed', {
        sessionId,
        firmwareType,
        firmwarePath,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to update firmware on IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get IPMI system information.
   */
  async getIPMISystemInfo(sessionId: string): Promise<unknown> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }
      const systemInfo = await (ipmiProtocol as any).executeCommand(
        sessionId,
        'mc',
        ['info']
      );

      this.logger.debug(
        `Retrieved system info from IPMI session ${sessionId}`
      );

      return systemInfo;
    } catch (error) {
      this.logger.error(
        `Failed to get system info from IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Configure IPMI LAN settings.
   */
  async configureIPMILAN(
    sessionId: string,
    channel: number,
    settings: Record<string, unknown>
  ): Promise<void> {
    const ipmiState = this.ipmiSessions.get(sessionId);
    if (!ipmiState) {
      throw new Error(`IPMI session ${sessionId} not found or inactive`);
    }

    try {
      const ipmiProtocol = this.ipmiProtocols.get(sessionId);
      if (!ipmiProtocol) {
        throw new Error(`IPMI protocol not found for session ${sessionId}`);
      }

      // Configure LAN parameters
      for (const [param, value] of Object.entries(settings)) {
        await (ipmiProtocol as any).executeCommand(sessionId, 'lan', [
          'set',
          channel.toString(),
          param,
          String(value),
        ]);
      }

      this.logger.info(
        `LAN configuration updated for channel ${channel} on IPMI session ${sessionId}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to configure LAN settings on IPMI session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get the number of tracked IPMI protocol instances.
   */
  getSessionCount(): number {
    return this.ipmiProtocols.size;
  }

  /**
   * Override destroy to clean up all per-session protocols, intervals, and tracking maps.
   */
  override async destroy(): Promise<void> {
    // Clean up all IPMI monitoring intervals
    for (const [, timers] of this.ipmiMonitoringIntervals) {
      if (Array.isArray(timers)) {
        for (const timer of timers) {
          clearInterval(timer);
        }
      } else {
        clearInterval(timers);
      }
    }
    this.ipmiMonitoringIntervals.clear();

    // Disconnect/cleanup all active IPMI protocol instances
    for (const [sessionId, protocol] of this.ipmiProtocols) {
      try {
        if (typeof (protocol as any).cleanup === 'function') {
          await (protocol as any).cleanup();
        }
      } catch (e) {
        this.logger.warn(
          `Error cleaning up IPMI protocol for session ${sessionId}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    this.ipmiProtocols.clear();
    this.ipmiSessions.clear();
    // Note: do NOT call super.destroy() — we manage per-session protocols,
    // not the single this.protocol field that super.destroy() would attempt to clean up.
  }
}
