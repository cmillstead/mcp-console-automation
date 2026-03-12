import { Logger } from '../utils/logger.js';
import { ProtocolSessionManagerBase, ProtocolSessionHost } from './ProtocolSessionManagerBase.js';
import { StreamManager } from './StreamManager.js';
import type {
  ConsoleSession,
  ConsoleOutput,
  SessionOptions,
  ExtendedErrorPattern,
  SerialConnectionOptions,
} from '../types/index.js';

/**
 * Manages serial protocol sessions (COM, UART, serial devices).
 * Extracted from ConsoleManager to isolate serial-specific logic
 * and eliminate the legacy serialProtocol field.
 */
export class SerialSessionManager extends ProtocolSessionManagerBase {
  constructor(host: ProtocolSessionHost, logger: Logger) {
    super(host, logger, 'serial');
  }

  /**
   * Create a serial session using SerialProtocol.
   */
  async createSession(
    sessionId: string,
    session: ConsoleSession,
    options: SessionOptions
  ): Promise<string> {
    if (
      !options.serialOptions &&
      !['serial', 'com', 'uart'].includes(options.consoleType || '')
    ) {
      throw new Error(
        'Serial options or serial console type required for serial session'
      );
    }

    try {
      const protocol = await this.ensureProtocol();

      // Determine serial options
      let serialOptions: SerialConnectionOptions;

      if (options.serialOptions) {
        serialOptions = options.serialOptions;
      } else {
        // Auto-detect serial port if only console type is specified
        const devices = await (protocol as any).discoverDevices();
        const availableDevice = devices.find(
          (device: { isConnected: boolean }) => device.isConnected === false
        );

        if (!availableDevice) {
          throw new Error(
            'No available serial devices found. Please specify explicit serial options.'
          );
        }

        // Use first available device with default settings
        serialOptions = {
          path: availableDevice.path,
          baudRate: availableDevice.deviceType === 'esp32' ? 115200 : 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          encoding: 'utf8',
          lineEnding: '\r\n',
          resetOnConnect: availableDevice.deviceType === 'arduino',
          reconnectOnDisconnect: true,
          maxReconnectAttempts: 5,
          reconnectDelay: 1000,
        };
      }

      // Store serial options in session
      session.serialOptions = serialOptions;

      // Create serial connection
      await (protocol as any).createConnection(sessionId, serialOptions);

      // Set up session tracking
      this.host.setSession(sessionId, session);
      this.host.setOutputBuffer(sessionId, []);

      // Initialize stream manager for serial output
      const streamManager = new StreamManager(sessionId, {
        maxChunkSize: options.maxBuffer || 10000,
        enableRealTimeCapture: true,
        bufferFlushInterval: 10,
        enablePolling: true,
        pollingInterval: 50,
        immediateFlush: true,
        chunkCombinationTimeout: 20,
      });
      this.host.setStreamManager(sessionId, streamManager);

      // Initialize error detection for serial output
      if (options.detectErrors !== false) {
        const defaultPatterns = this.getDefaultSerialErrorPatterns();
        const extendedPatterns = options.patterns
          ? options.patterns.map((p) => ({ ...p, category: 'serial' }))
          : defaultPatterns;
        this.host.addErrorPatterns(extendedPatterns);
      }

      this.logger.info(
        `Serial session created successfully: ${sessionId} on ${serialOptions.path}`
      );

      // Emit session started event
      this.host.emitTypedEvent('session:created', {
        sessionId,
        type: 'serial',
        path: serialOptions.path,
        deviceType: serialOptions.deviceType || 'generic',
        timestamp: new Date(),
      });

      return sessionId;
    } catch (error) {
      this.logger.error(
        `Serial session creation failed for ${sessionId}:`,
        error
      );

      // Clean up on failure
      await this.cleanupSession(sessionId);

      throw error;
    }
  }

  /**
   * Set up event handlers for SerialProtocol.
   */
  protected setupEventHandlers(): void {
    const protocol = this.protocol;
    if (!protocol) return;

    protocol.on('data', (output: ConsoleOutput) => {
      this.handleSerialOutput(output);
    });

    protocol.on('line', (output: ConsoleOutput) => {
      this.handleSerialLine(output);
    });

    protocol.on('binary_data', (output: ConsoleOutput) => {
      this.handleSerialBinaryData(output);
    });

    protocol.on('connection', (event: unknown) => {
      this.logger.info(`Serial connection event:`, event);
      this.host.emitTypedEvent('serial:connection', event);
    });

    protocol.on('disconnection', (event: unknown) => {
      this.logger.warn(`Serial disconnection event:`, event);
      this.host.emitTypedEvent('serial:disconnection', event);
    });

    protocol.on('error', (event: unknown) => {
      this.logger.error(`Serial error event:`, event);
      this.host.emitTypedEvent('serial:error', event);
    });

    protocol.on('bootloader_detected', (event: unknown) => {
      this.logger.info(`Bootloader detected:`, event);
      this.host.emitTypedEvent('serial:bootloader_detected', event);
    });

    protocol.on('device_list_updated', (devices: unknown) => {
      this.host.emitTypedEvent('serial:device_list_updated', devices);
    });
  }

  /**
   * Handle serial data output.
   */
  private handleSerialOutput(output: ConsoleOutput): void {
    const { sessionId } = output;

    // Store output in buffer
    const buffer = this.host.getOutputBuffer(sessionId);
    if (buffer) {
      buffer.push(output);
    }

    // Pass through stream manager
    const streamManager = this.host.getStreamManager(sessionId);
    if (streamManager) {
      streamManager.processOutput(output);
    }

    // Emit output event
    this.host.emitTypedEvent('output', output);
    this.host.emitTypedEvent(`output:${sessionId}`, output);
  }

  /**
   * Handle serial line output (parsed lines).
   */
  private handleSerialLine(output: ConsoleOutput): void {
    const { sessionId } = output;

    // Process line for error detection
    const errorDetector = this.host.getErrorDetector();
    if (errorDetector) {
      errorDetector.processOutput(output.data);
    }

    // Process line for prompt detection
    const promptDetector = this.host.getPromptDetector();
    if (promptDetector) {
      const result = promptDetector.detectPrompt(sessionId, output.data);
      if (result && result.detected) {
        this.host.emitTypedEvent('prompt:detected', {
          sessionId,
          pattern: result.pattern,
          matchedText: result.matchedText,
          timestamp: new Date(),
        });
      }
    }

    // Regular output handling
    this.handleSerialOutput(output);
  }

  /**
   * Handle binary data from serial connection.
   */
  private handleSerialBinaryData(output: ConsoleOutput): void {
    // Binary data typically bypasses text processing
    this.handleSerialOutput(output);
  }

  /**
   * Get default error patterns for serial communication.
   */
  getDefaultSerialErrorPatterns(): ExtendedErrorPattern[] {
    return [
      {
        pattern: /error|ERROR|Error/,
        type: 'error',
        description: 'General error message',
        severity: 'medium',
        category: 'serial',
        tags: ['serial', 'general'],
      },
      {
        pattern: /exception|Exception|EXCEPTION/,
        type: 'exception',
        description: 'Exception in serial communication',
        severity: 'high',
        category: 'serial',
        tags: ['serial', 'exception'],
      },
      {
        pattern: /timeout|Timeout|TIMEOUT/,
        type: 'error',
        description: 'Serial communication timeout',
        severity: 'medium',
        category: 'serial',
        tags: ['serial', 'timeout'],
      },
      {
        pattern: /connection.*lost|disconnected|unplugged/i,
        type: 'error',
        description: 'Serial device disconnected',
        severity: 'high',
        category: 'serial',
        tags: ['serial', 'connection'],
      },
      {
        pattern: /bootloader|Bootloader|BOOTLOADER/,
        type: 'warning',
        description: 'Device in bootloader mode',
        severity: 'low',
        category: 'serial',
        tags: ['serial', 'bootloader'],
      },
    ];
  }

  /**
   * Clean up serial session resources.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    try {
      // Remove from sessions map
      this.host.deleteSession(sessionId);

      // Close serial connection
      if (this.protocol) {
        await (this.protocol as any).closeConnection(sessionId);
      }

      // Clean up buffers and managers
      this.host.setOutputBuffer(sessionId, []);
      this.host.deleteStreamManager(sessionId);
      // Cleanup pagination manager for this session
      const paginationManager = this.host.getPaginationManager();
      if (paginationManager) {
        paginationManager.removeSession(sessionId);
      }
    } catch (error) {
      this.logger.error(
        `Error cleaning up serial session ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Send input to serial session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    if (!this.protocol) {
      throw new Error('Serial protocol not initialized');
    }

    try {
      // Send data to serial device
      await (this.protocol as any).sendData(sessionId, input);

      // Emit input event
      this.host.emitEvent({
        sessionId,
        type: 'input',
        timestamp: new Date(),
        data: { input },
      });

      this.logger.debug(
        `Sent input to serial session ${sessionId}: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to send input to serial session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Discover available serial devices.
   */
  async discoverSerialDevices(): Promise<unknown[]> {
    try {
      const protocol = await this.ensureProtocol();
      return await (protocol as any).discoverDevices();
    } catch (error) {
      this.logger.error('Failed to discover serial devices:', error);
      throw error;
    }
  }

  /**
   * Get serial connection status for a session.
   */
  getSerialConnectionStatus(sessionId: string): unknown {
    if (!this.protocol) {
      return null;
    }
    return (this.protocol as any).getConnectionStatus(sessionId);
  }

  /**
   * Perform device reset on a serial session (e.g., Arduino reset).
   */
  async resetSerialDevice(sessionId: string): Promise<void> {
    if (!this.protocol) {
      throw new Error('Serial protocol not initialized');
    }

    try {
      await (this.protocol as any).performDeviceReset(sessionId);
      this.logger.info(
        `Device reset performed for serial session ${sessionId}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to reset device for session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get output buffer for serial session.
   */
  getSerialOutputBuffer(sessionId: string, limit?: number): unknown[] {
    if (!this.protocol) {
      return [];
    }
    return (this.protocol as any).getOutputBuffer(sessionId, limit);
  }

  /**
   * Clear output buffer for serial session.
   */
  clearSerialOutputBuffer(sessionId: string): void {
    if (this.protocol) {
      (this.protocol as any).clearOutputBuffer(sessionId);
    }
  }
}
