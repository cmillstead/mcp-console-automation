import { v4 as uuidv4 } from 'uuid';
import { ClientChannel } from 'ssh2';
import { Logger } from '../utils/logger.js';
import { CommandExecution, ConsoleOutput } from '../types/index.js';
import {
  SessionPersistenceManager,
  SessionPersistentData,
  SerializedQueuedCommand,
  SessionBookmark,
} from './SessionPersistenceManager.js';
import { NetworkMetricsManager } from './NetworkMetricsManager.js';
import { ErrorRecovery } from './ErrorRecovery.js';

export interface QueuedCommand {
  id: string;
  sessionId: string;
  input: string;
  timestamp: Date;
  retryCount: number;
  resolve: (value?: any) => void;
  reject: (error: Error) => void;
  acknowledged: boolean;
  sent: boolean;
  priority?: number;
  context?: any;
}

export interface TimeoutRecoveryResult {
  success: boolean;
  error?: string;
  reconnected?: boolean;
  restoredCommands?: number;
  metadata?: Record<string, any>;
}

export interface SessionCommandQueue {
  sessionId: string;
  commands: QueuedCommand[];
  isProcessing: boolean;
  lastCommandTime: number;
  acknowledgmentTimeout: NodeJS.Timeout | null;
  outputBuffer: string;
  expectedPrompt?: RegExp;
  persistentData?: SessionPersistentData;
  bookmarks: SessionBookmark[];
}

export interface CommandQueueConfig {
  maxQueueSize: number;
  commandTimeout: number;
  interCommandDelay: number;
  acknowledgmentTimeout: number;
  enablePromptDetection: boolean;
  defaultPromptPattern: RegExp;
}

export interface CommandQueueHost {
  getSession(sessionId: string): any;
  updateSessionExecutionState(sessionId: string, state: 'idle' | 'executing', commandId?: string, completedAt?: Date): void;
  removeActiveCommand(sessionId: string, commandId: string): void;
  getOutputBufferLength(sessionId: string): number;
  getSSHChannel(sessionId: string): any;
  getSessionSSHHost(sessionId: string): string | undefined;
  sendInput(sessionId: string, input: string): Promise<void>;
  addToOutputBuffer(sessionId: string, output: any): void;
  emitEvent(event: any): void;
  isSessionMonitored(sessionId: string): boolean;
  recordMonitoringEvent(sessionId: string, type: string, data: any): void;
  recordCommandMetrics(success: boolean, duration: number, command: string, sessionId: string): void;
  attemptTimeoutRecovery(sessionId: string, command: QueuedCommand): Promise<TimeoutRecoveryResult>;
  delay(ms: number): Promise<void>;
  isSelfHealingEnabled(): boolean;
}

export class CommandQueueManager {
  private commandExecutions: Map<string, CommandExecution> = new Map();
  private sessionCommandQueue: Map<string, string[]> = new Map();
  private outputSequenceCounters: Map<string, number> = new Map();
  private promptPatterns: Map<string, RegExp> = new Map();

  private commandQueues: Map<string, SessionCommandQueue> = new Map();
  private queueConfig: CommandQueueConfig;
  private commandProcessingIntervals: Map<string, NodeJS.Timeout> = new Map();

  private logger: Logger;
  private host: CommandQueueHost;
  private networkMetricsManager: NetworkMetricsManager;
  private persistenceManager: SessionPersistenceManager;
  private errorRecovery: ErrorRecovery;

  constructor(
    logger: Logger,
    host: CommandQueueHost,
    networkMetricsManager: NetworkMetricsManager,
    persistenceManager: SessionPersistenceManager,
    errorRecovery: ErrorRecovery
  ) {
    this.logger = logger;
    this.host = host;
    this.networkMetricsManager = networkMetricsManager;
    this.persistenceManager = persistenceManager;
    this.errorRecovery = errorRecovery;
    this.queueConfig = {
      maxQueueSize: 100,
      commandTimeout: 30000,
      interCommandDelay: 500,
      acknowledgmentTimeout: 10000,
      enablePromptDetection: true,
      defaultPromptPattern: /[$#%>]\s*$/m,
    };
  }

  initializeSessionCommandTracking(
    sessionId: string,
    consoleType: string,
    sshOptions?: { host?: string; username?: string }
  ): void {
    this.sessionCommandQueue.set(sessionId, []);
    this.outputSequenceCounters.set(sessionId, 0);

    // Set up prompt pattern for command completion detection
    let promptPattern: RegExp;
    if (
      consoleType === 'powershell' ||
      consoleType === 'pwsh'
    ) {
      promptPattern = /PS\s.*?>\s*$/m;
    } else if (consoleType === 'cmd') {
      promptPattern = /^[A-Z]:\\.*?>\s*$/m;
    } else if (
      consoleType === 'bash' ||
      consoleType === 'zsh' ||
      consoleType === 'sh'
    ) {
      promptPattern = /^[\w\-\.~]*[$#]\s*$/m;
    } else {
      // Generic prompt pattern
      promptPattern = /^.*?[$#>]\s*$/m;
    }

    this.promptPatterns.set(sessionId, promptPattern);

    // Initialize persistent session data
    this.persistenceManager.initializeSessionPersistence(sessionId, { sshOptions: sshOptions as any });
  }

  serializeCommandQueue(
    commands: QueuedCommand[]
  ): SerializedQueuedCommand[] {
    return commands.map((cmd) => ({
      id: cmd.id,
      sessionId: cmd.sessionId,
      input: cmd.input,
      timestamp: cmd.timestamp.toISOString(),
      retryCount: cmd.retryCount,
      acknowledged: cmd.acknowledged,
      sent: cmd.sent,
      priority: cmd.priority,
      context: cmd.context,
    }));
  }

  private deserializeCommandQueue(
    serialized: SerializedQueuedCommand[],
    sessionId: string
  ): QueuedCommand[] {
    return serialized.map((cmd) => ({
      id: cmd.id,
      sessionId: cmd.sessionId,
      input: cmd.input,
      timestamp: new Date(cmd.timestamp),
      retryCount: cmd.retryCount,
      acknowledged: cmd.acknowledged,
      sent: cmd.sent,
      priority: cmd.priority,
      context: cmd.context,
      resolve: () => {}, // Will be replaced during recovery
      reject: () => {}, // Will be replaced during recovery
    }));
  }

  private startCommandExecution(
    sessionId: string,
    command: string,
    args?: string[]
  ): string {
    const commandId = uuidv4();
    const session = this.host.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Update session state
    this.host.updateSessionExecutionState(sessionId, 'executing', commandId);

    // Create command execution record
    const commandExecution: CommandExecution = {
      id: commandId,
      sessionId,
      command,
      args,
      startedAt: new Date(),
      status: 'executing',
      output: [],
      isolatedBufferStartIndex: this.host.getOutputBufferLength(sessionId),
      totalOutputLines: 0,
      markers: {
        promptPattern: this.promptPatterns.get(sessionId),
      },
    };

    // Store command execution
    this.commandExecutions.set(commandId, commandExecution);
    session.activeCommands.set(commandId, commandExecution);

    // Add to session command queue
    const queue = this.sessionCommandQueue.get(sessionId) || [];
    queue.push(commandId);
    this.sessionCommandQueue.set(sessionId, queue);

    this.logger.debug(
      `Started command execution ${commandId} for session ${sessionId}: ${command}`
    );
    return commandId;
  }

  completeCommandExecution(commandId: string, exitCode?: number): void {
    const commandExecution = this.commandExecutions.get(commandId);
    if (!commandExecution) {
      this.logger.warn(`Command execution ${commandId} not found`);
      return;
    }

    const session = this.host.getSession(commandExecution.sessionId);
    if (!session) {
      this.logger.warn(
        `Session ${commandExecution.sessionId} not found for command ${commandId}`
      );
      return;
    }

    // Update command execution
    commandExecution.completedAt = new Date();
    commandExecution.status =
      exitCode === 0
        ? 'completed'
        : exitCode !== undefined
          ? 'failed'
          : 'completed';
    commandExecution.exitCode = exitCode;
    commandExecution.duration =
      commandExecution.completedAt.getTime() -
      commandExecution.startedAt.getTime();

    // Update session state
    this.host.updateSessionExecutionState(commandExecution.sessionId, 'idle', undefined, commandExecution.completedAt);

    // Clean up from active commands (keep in session for history but not as active)
    this.host.removeActiveCommand(commandExecution.sessionId, commandId);

    // Record command metrics for health monitoring
    if (this.host.isSelfHealingEnabled()) {
      this.host.recordCommandMetrics(
        commandExecution.status === 'completed',
        commandExecution.duration || 0,
        commandExecution.command,
        commandExecution.sessionId
      );
    }

    this.logger.debug(
      `Completed command execution ${commandId} with status ${commandExecution.status} in ${commandExecution.duration}ms`
    );
  }

  getCommandOutput(commandId: string): ConsoleOutput[] {
    const commandExecution = this.commandExecutions.get(commandId);
    if (!commandExecution) {
      return [];
    }

    // Return the output that was captured for this command
    return commandExecution.output;
  }

  detectCommandCompletion(sessionId: string, output: string): boolean {
    const promptPattern = this.promptPatterns.get(sessionId);
    if (!promptPattern) {
      return false;
    }

    // Check if the output contains a prompt indicating command completion
    return promptPattern.test(output);
  }

  async executeCommandInSession(
    sessionId: string,
    command: string,
    args?: string[],
    timeout: number = 120000
  ): Promise<{
    commandId: string;
    output: ConsoleOutput[];
    exitCode?: number;
    duration: number;
    status: 'completed' | 'failed' | 'timeout';
  }> {
    console.error(
      `[DEBUG-HANG] executeCommandInSession called with:`,
      JSON.stringify(
        {
          sessionId,
          command,
          args,
          timeout,
        },
        null,
        2
      )
    );

    const session = this.host.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.executionState !== 'idle') {
      throw new Error(
        `Session ${sessionId} is currently ${session.executionState}. Wait for current command to complete.`
      );
    }

    // Start command execution tracking
    const commandId = this.startCommandExecution(sessionId, command, args);

    try {
      // Add command start boundary marker
      const startBoundaryOutput: ConsoleOutput = {
        sessionId,
        type: 'stdout',
        data: '',
        timestamp: new Date(),
        commandId,
        isCommandBoundary: true,
        boundaryType: 'start',
        sequence: this.outputSequenceCounters.get(sessionId) || 0,
      };
      this.host.addToOutputBuffer(sessionId, startBoundaryOutput);

      // Send the command
      const fullCommand =
        args && args.length > 0 ? `${command} ${args.join(' ')}` : command;
      await this.host.sendInput(sessionId, fullCommand + '\n');

      // Wait for command completion or timeout
      const result = await this.waitForCommandCompletion(commandId, timeout);

      return {
        commandId,
        output: this.getCommandOutput(commandId),
        exitCode: result.exitCode,
        duration: result.duration,
        status: result.status,
      };
    } catch (error) {
      // Mark command as failed
      this.completeCommandExecution(commandId, -1);
      throw error;
    }
  }

  private async waitForCommandCompletion(
    commandId: string,
    timeout: number
  ): Promise<{
    exitCode?: number;
    duration: number;
    status: 'completed' | 'failed' | 'timeout';
  }> {
    const commandExecution = this.commandExecutions.get(commandId);
    if (!commandExecution) {
      throw new Error(`Command execution ${commandId} not found`);
    }

    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms

    return new Promise((resolve, reject) => {
      const checkCompletion = () => {
        const currentExecution = this.commandExecutions.get(commandId);
        if (!currentExecution) {
          reject(new Error(`Command execution ${commandId} was removed`));
          return;
        }

        // Check if command completed
        if (currentExecution.status !== 'executing') {
          resolve({
            exitCode: currentExecution.exitCode,
            duration: currentExecution.duration || Date.now() - startTime,
            status:
              currentExecution.status === 'completed' ? 'completed' : 'failed',
          });
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          this.completeCommandExecution(commandId, -1);
          resolve({
            exitCode: -1,
            duration: Date.now() - startTime,
            status: 'timeout',
          });
          return;
        }

        // Continue checking
        setTimeout(checkCompletion, checkInterval);
      };

      checkCompletion();
    });
  }

  getCommandExecutionDetails(commandId: string): CommandExecution | null {
    return this.commandExecutions.get(commandId) || null;
  }

  getSessionCommandHistory(sessionId: string): CommandExecution[] {
    const commandIds = this.sessionCommandQueue.get(sessionId) || [];
    return commandIds
      .map((id) => this.commandExecutions.get(id))
      .filter((cmd): cmd is CommandExecution => cmd !== undefined);
  }

  cleanupSessionCommandHistory(sessionId: string, keepLast: number = 10): void {
    const commandIds = this.sessionCommandQueue.get(sessionId) || [];

    if (commandIds.length > keepLast) {
      const toRemove = commandIds.splice(0, commandIds.length - keepLast);
      toRemove.forEach((commandId) => {
        this.commandExecutions.delete(commandId);
      });

      this.sessionCommandQueue.set(sessionId, commandIds);
      this.logger.debug(
        `Cleaned up ${toRemove.length} old command executions for session ${sessionId}`
      );
    }
  }

  configurePromptDetection(
    sessionId: string,
    sshOptions: { host?: string; username?: string }
  ): void {
    // Command queue system handles prompt detection
    // Set custom prompt pattern if specified in options
    if (sshOptions?.host && sshOptions?.username) {
      const customPattern = new RegExp(
        `(?:^|\\n)(${sshOptions.username}@${sshOptions.host}[^$#]*[$#])\\s*$`,
        'm'
      );
      this.setSessionPromptPattern(sessionId, customPattern);

      this.logger.info(
        `Configured custom prompt pattern for SSH session ${sessionId}`,
        {
          host: sshOptions.host,
          username: sshOptions.username,
        }
      );
    }
  }

  initializeCommandQueue(sessionId: string): void {
    if (!this.commandQueues.has(sessionId)) {
      const persistentData = this.persistenceManager.getPersistenceData(sessionId);
      const bookmarks = this.persistenceManager.getBookmarks(sessionId);

      const queue: SessionCommandQueue = {
        sessionId,
        commands: [],
        isProcessing: false,
        lastCommandTime: 0,
        acknowledgmentTimeout: null,
        outputBuffer: '',
        expectedPrompt: this.queueConfig.defaultPromptPattern,
        persistentData,
        bookmarks,
      };

      // Restore pending commands if available
      if (persistentData && persistentData.pendingCommands.length > 0) {
        queue.commands = this.deserializeCommandQueue(
          persistentData.pendingCommands,
          sessionId
        );
        this.logger.info(
          `Restored ${queue.commands.length} pending commands for session ${sessionId}`
        );
      }

      this.commandQueues.set(sessionId, queue);
      this.logger.debug(
        `Command queue with persistence initialized for session ${sessionId}`
      );
    }
  }

  private async processCommandQueue(sessionId: string): Promise<void> {
    const queue = this.commandQueues.get(sessionId);
    const sshChannel = this.host.getSSHChannel(sessionId);

    if (
      !queue ||
      !sshChannel ||
      queue.isProcessing ||
      queue.commands.length === 0
    ) {
      return;
    }

    queue.isProcessing = true;
    this.logger.debug(
      `Processing command queue for session ${sessionId}, ${queue.commands.length} commands pending`
    );

    try {
      while (queue.commands.length > 0) {
        const command = queue.commands[0];

        if (command.sent && !command.acknowledged) {
          // Calculate adaptive acknowledgment timeout based on network conditions
          const sshHost = this.host.getSessionSSHHost(sessionId);
          const adaptiveTimeout = sshHost
            ? this.networkMetricsManager.calculateAdaptiveTimeout(sshHost)
            : this.queueConfig.acknowledgmentTimeout;

          // Wait for acknowledgment or timeout
          const waitTime = Date.now() - command.timestamp.getTime();
          const effectiveTimeout = Math.max(
            adaptiveTimeout,
            this.queueConfig.acknowledgmentTimeout
          );

          if (waitTime < effectiveTimeout) {
            // Still within timeout window, but check if we should provide progress updates
            if (waitTime > effectiveTimeout * 0.7) {
              // Getting close to timeout, log progress
              this.logger.debug(
                `Command waiting for acknowledgment: ${sessionId}, ${waitTime}ms/${effectiveTimeout}ms`
              );
            }
            break; // Wait for acknowledgment
          } else {
            // Timeout reached - enhanced handling
            const timeoutDuration = Date.now() - command.timestamp.getTime();
            this.logger.warn(
              `Command acknowledgment timeout for session ${sessionId} after ${timeoutDuration}ms (adaptive: ${adaptiveTimeout}ms), command: ${command.input.substring(0, 50)}...`
            );

            // Create detailed timeout context for error recovery
            const timeoutContext = {
              sessionId,
              operation: 'command_acknowledgment_timeout',
              error: new Error(
                `Command acknowledgment timeout after ${timeoutDuration}ms`
              ),
              timestamp: Date.now(),
              metadata: {
                commandInput: command.input.substring(0, 200),
                commandRetryCount: command.retryCount || 0,
                timeoutDuration,
                adaptiveTimeout,
                effectiveTimeout,
                networkQuality:
                  this.networkMetricsManager.getMetrics(sshHost || '')
                    ?.connectionQuality || 'unknown',
              },
            };

            // Check if this command has been retried too many times
            const maxCommandRetries = 2;
            if ((command.retryCount || 0) >= maxCommandRetries) {
              this.logger.error(
                `Command retry limit exceeded for session ${sessionId}, giving up`
              );

              // Attempt error recovery as last resort before failing
              const errorRecoveryResult =
                await this.errorRecovery.attemptRecovery(timeoutContext);
              if (errorRecoveryResult) {
                this.logger.info(
                  `Error recovery provided fallback for command timeout in session ${sessionId}`
                );
                command.resolve('Command completed via error recovery');
              } else {
                command.reject(
                  new Error(
                    `Command acknowledgment timeout after ${maxCommandRetries} retries`
                  )
                );
              }

              queue.commands.shift();
              continue;
            }

            // Attempt timeout recovery with enhanced context
            const recoveryResult = await this.host.attemptTimeoutRecovery(
              sessionId,
              command
            );
            if (recoveryResult.success) {
              this.logger.info(
                `Successfully recovered from timeout for session ${sessionId}${recoveryResult.metadata ? ` (${JSON.stringify(recoveryResult.metadata)})` : ''}`
              );

              // Reset command state for retry with exponential backoff
              command.timestamp = new Date();
              command.retryCount = (command.retryCount || 0) + 1;

              // Apply adaptive backoff based on network conditions and retry count
              const networkMetrics = this.networkMetricsManager.getMetrics(
                sshHost || ''
              );
              let backoffMs = 1000 * Math.pow(2, command.retryCount - 1); // Exponential backoff

              // Adjust backoff based on network quality
              if (networkMetrics) {
                switch (networkMetrics.connectionQuality) {
                  case 'poor':
                    backoffMs *= 2.5; // Longer backoff for poor connections
                    break;
                  case 'fair':
                    backoffMs *= 1.8;
                    break;
                  case 'good':
                    backoffMs *= 1.2;
                    break;
                  case 'excellent':
                    // No multiplier for excellent connections
                    break;
                }
              }

              // Cap the backoff at 10 seconds
              backoffMs = Math.min(backoffMs, 10000);

              if (backoffMs > 0) {
                this.logger.info(
                  `Applying ${backoffMs}ms adaptive backoff before command retry (network: ${networkMetrics?.connectionQuality || 'unknown'})`
                );
                await this.host.delay(backoffMs);
              }

              continue; // Retry the command
            } else {
              // Recovery failed, try error recovery system as fallback
              const errorRecoveryResult =
                await this.errorRecovery.attemptRecovery(timeoutContext);
              if (errorRecoveryResult) {
                this.logger.info(
                  `Error recovery provided fallback after timeout recovery failure for session ${sessionId}`
                );
                command.resolve(
                  'Command completed via error recovery after timeout'
                );
                queue.commands.shift();
                continue;
              }

              // All recovery attempts failed
              this.logger.error(
                `All recovery attempts failed for command timeout in session ${sessionId}: ${recoveryResult.error}`
              );
              command.reject(
                new Error(
                  `Command acknowledgment timeout: ${recoveryResult.error}`
                )
              );
              queue.commands.shift();
              continue;
            }
          }
        }

        if (!command.sent) {
          // Send the command
          try {
            await this.sendCommandToSSH(sessionId, command, sshChannel);
            command.sent = true;
            command.timestamp = new Date();

            // Update persistent data with command activity
            const persistentData = this.persistenceManager.getPersistenceData(sessionId);
            if (persistentData) {
              persistentData.lastActivity = new Date();
              persistentData.commandHistory.push(command.input);
              // Keep only last 50 commands in history
              if (persistentData.commandHistory.length > 50) {
                persistentData.commandHistory =
                  persistentData.commandHistory.slice(-50);
              }
            }

            // Create bookmark on command if using hybrid or on-command strategy
            const bookmarkStrategy = this.persistenceManager.getContinuityConfig().bookmarkStrategy;
            if (
              bookmarkStrategy === 'on-command' ||
              bookmarkStrategy === 'hybrid'
            ) {
              await this.createSessionBookmark(sessionId, 'on-command');
            }

            // Wait for inter-command delay
            if (queue.commands.length > 1) {
              await this.host.delay(this.queueConfig.interCommandDelay);
            }
          } catch (error) {
            this.logger.error(
              `Failed to send command to SSH session ${sessionId}:`,
              error
            );
            command.reject(error as Error);
            queue.commands.shift();
            continue;
          }
        }

        // Check for acknowledgment
        if (this.queueConfig.enablePromptDetection && queue.expectedPrompt) {
          if (queue.expectedPrompt.test(queue.outputBuffer)) {
            // Command acknowledged
            command.acknowledged = true;
            command.resolve();
            queue.commands.shift();
            queue.outputBuffer = ''; // Clear buffer after acknowledgment
            queue.lastCommandTime = Date.now();
          } else {
            // Wait for more output
            break;
          }
        } else {
          // No prompt detection, acknowledge immediately
          command.acknowledged = true;
          command.resolve();
          queue.commands.shift();
          queue.lastCommandTime = Date.now();
        }
      }
    } finally {
      queue.isProcessing = false;
    }

    // Schedule next processing if there are more commands
    if (queue.commands.length > 0) {
      setTimeout(() => this.processCommandQueue(sessionId), 100);
    }
  }

  private async sendCommandToSSH(
    sessionId: string,
    command: QueuedCommand,
    sshChannel: ClientChannel
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SSH write timeout'));
      }, this.queueConfig.commandTimeout);

      try {
        // Ensure command ends with newline for proper execution
        let commandToSend = command.input;
        if (!commandToSend.endsWith('\n') && !commandToSend.endsWith('\r\n')) {
          commandToSend += '\n';
        }

        sshChannel.write(commandToSend, (error) => {
          clearTimeout(timeout);

          if (error) {
            this.logger.error(
              `SSH write error for session ${sessionId}:`,
              error
            );
            reject(error);
          } else {
            // Record input to monitoring system
            if (this.host.isSessionMonitored(sessionId)) {
              this.host.recordMonitoringEvent(sessionId, 'input', {
                size: command.input.length,
                type: 'ssh_queued_input',
                commandId: command.id,
              });
            }

            this.host.emitEvent({
              sessionId,
              type: 'input',
              timestamp: new Date(),
              data: {
                input: command.input,
                ssh: true,
                queued: true,
                commandId: command.id,
              },
            });

            this.logger.debug(
              `Command sent to SSH session ${sessionId}: ${command.input.substring(0, 100)}...`
            );
            resolve();
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error as Error);
      }
    });
  }

  handleSSHOutputForQueue(sessionId: string, data: string): void {
    const queue = this.commandQueues.get(sessionId);
    if (!queue) return;

    // Append to output buffer for prompt detection
    queue.outputBuffer += data;

    // Keep buffer size manageable
    if (queue.outputBuffer.length > 4096) {
      queue.outputBuffer = queue.outputBuffer.slice(-2048);
    }

    // Trigger queue processing if there are pending commands
    if (queue.commands.length > 0 && !queue.isProcessing) {
      setImmediate(() => this.processCommandQueue(sessionId));
    }
  }

  async addCommandToQueue(
    sessionId: string,
    input: string
  ): Promise<void> {
    this.initializeCommandQueue(sessionId);
    const queue = this.commandQueues.get(sessionId)!;

    if (queue.commands.length >= this.queueConfig.maxQueueSize) {
      throw new Error(
        `Command queue full for session ${sessionId} (max: ${this.queueConfig.maxQueueSize})`
      );
    }

    return new Promise<void>((resolve, reject) => {
      const command: QueuedCommand = {
        id: uuidv4(),
        sessionId,
        input,
        timestamp: new Date(),
        retryCount: 0,
        resolve,
        reject,
        acknowledged: false,
        sent: false,
      };

      queue.commands.push(command);
      this.logger.debug(
        `Command queued for session ${sessionId}: ${input.substring(0, 50)}... (queue size: ${queue.commands.length})`
      );

      // Start processing
      setImmediate(() => this.processCommandQueue(sessionId));
    });
  }

  clearCommandQueue(sessionId: string): void {
    const queue = this.commandQueues.get(sessionId);
    if (!queue) return;

    // Reject all pending commands
    queue.commands.forEach((command) => {
      if (!command.acknowledged) {
        command.reject(new Error('Session terminated'));
      }
    });

    // Clear timeout if exists
    if (queue.acknowledgmentTimeout) {
      clearTimeout(queue.acknowledgmentTimeout);
    }

    // Remove queue
    this.commandQueues.delete(sessionId);

    // Clear processing interval
    const interval = this.commandProcessingIntervals.get(sessionId);
    if (interval) {
      clearTimeout(interval);
      this.commandProcessingIntervals.delete(sessionId);
    }

    this.logger.debug(`Command queue cleared for session ${sessionId}`);
  }

  private getCommandQueueStats(sessionId: string): {
    queueSize: number;
    processing: boolean;
    lastCommandTime: number;
  } | null {
    const queue = this.commandQueues.get(sessionId);
    if (!queue) return null;

    return {
      queueSize: queue.commands.length,
      processing: queue.isProcessing,
      lastCommandTime: queue.lastCommandTime,
    };
  }

  configureCommandQueue(config: Partial<CommandQueueConfig>): void {
    this.queueConfig = { ...this.queueConfig, ...config };
    this.logger.info('Command queue configuration updated:', config);
  }

  getSessionQueueStats(sessionId: string) {
    return this.getCommandQueueStats(sessionId);
  }

  getAllCommandQueueStats(): Record<
    string,
    { queueSize: number; processing: boolean; lastCommandTime: number }
  > {
    const stats: Record<
      string,
      { queueSize: number; processing: boolean; lastCommandTime: number }
    > = {};

    this.commandQueues.forEach((queue, sessionId) => {
      stats[sessionId] = {
        queueSize: queue.commands.length,
        processing: queue.isProcessing,
        lastCommandTime: queue.lastCommandTime,
      };
    });

    return stats;
  }

  clearSessionCommandQueue(sessionId: string): void {
    this.clearCommandQueue(sessionId);
  }

  clearAllCommandQueues(): void {
    Array.from(this.commandQueues.keys()).forEach((sessionId) => {
      this.clearCommandQueue(sessionId);
    });
  }

  setSessionPromptPattern(sessionId: string, pattern: RegExp): boolean {
    const queue = this.commandQueues.get(sessionId);
    if (!queue) {
      return false;
    }

    queue.expectedPrompt = pattern;
    this.logger.debug(
      `Updated prompt pattern for session ${sessionId}: ${pattern}`
    );
    return true;
  }

  getCommandQueueConfig(): CommandQueueConfig {
    return { ...this.queueConfig };
  }

  async forceProcessCommandQueue(sessionId: string): Promise<void> {
    await this.processCommandQueue(sessionId);
  }

  getCommandQueueSnapshot(sessionId: string): SerializedQueuedCommand[] | undefined {
    const queue = this.commandQueues.get(sessionId);
    if (queue) {
      return this.serializeCommandQueue(queue.commands);
    }
    return undefined;
  }

  getOutputSequenceCounter(sessionId: string): number {
    return this.outputSequenceCounters.get(sessionId) || 0;
  }

  async createSessionBookmark(sessionId: string, trigger: string): Promise<void> {
    const queue = this.commandQueues.get(sessionId);
    const snapshot = queue ? this.serializeCommandQueue(queue.commands) : undefined;
    const queueLength = queue ? queue.commands.length : 0;

    await this.persistenceManager.createSessionBookmark(sessionId, trigger, snapshot, queueLength);

    if (queue) {
      queue.bookmarks = this.persistenceManager.getBookmarks(sessionId);
    }
  }

  getNextSequenceNumber(sessionId: string): number {
    const current = this.outputSequenceCounters.get(sessionId) || 0;
    this.outputSequenceCounters.set(sessionId, current + 1);
    return current + 1;
  }

  getPendingCommandInputs(sessionId: string): string[] {
    const queue = this.commandQueues.get(sessionId);
    return queue?.commands.map((cmd) => cmd.input) || [];
  }

  getQueueSize(sessionId: string): number {
    const queue = this.commandQueues.get(sessionId);
    return queue?.commands.length || 0;
  }

  flushPendingCommands(sessionId: string): void {
    const queue = this.commandQueues.get(sessionId);
    if (queue) {
      queue.commands = [];
      queue.outputBuffer = '';
    }
  }

  clearQueueOutputBuffer(sessionId: string): void {
    const queue = this.commandQueues.get(sessionId);
    if (queue) {
      queue.outputBuffer = '';
    }
  }

  getExpectedPrompt(sessionId: string): RegExp {
    const queue = this.commandQueues.get(sessionId);
    return queue?.expectedPrompt || this.queueConfig.defaultPromptPattern;
  }

  processOutputForCommandTracking(sessionId: string, output: ConsoleOutput): void {
    const sequenceCounter = this.outputSequenceCounters.get(sessionId) || 0;
    output.sequence = sequenceCounter;
    this.outputSequenceCounters.set(sessionId, sequenceCounter + 1);

    const session = this.host.getSession(sessionId);
    if (session && session.currentCommandId) {
      output.commandId = session.currentCommandId;

      const commandExecution = this.commandExecutions.get(
        session.currentCommandId
      );
      if (commandExecution) {
        commandExecution.output.push(output);
        commandExecution.totalOutputLines++;

        if (this.detectCommandCompletion(sessionId, output.data)) {
          output.isCommandBoundary = true;
          output.boundaryType = 'end';
          this.completeCommandExecution(session.currentCommandId);
        }
      }
    }
  }

  restoreCommandQueueFromPersistence(sessionId: string): number {
    const serializedCommands = this.persistenceManager.restoreCommandQueueFromPersistence(sessionId);
    const queue = this.commandQueues.get(sessionId);

    if (serializedCommands.length === 0 || !queue) {
      return 0;
    }

    const restoredCommands = this.deserializeCommandQueue(
      serializedCommands,
      sessionId
    );

    restoredCommands.forEach((cmd) => {
      cmd.priority = 1;
      queue.commands.unshift(cmd);
    });

    this.logger.info(
      `Restored ${restoredCommands.length} commands to queue for session ${sessionId}`
    );
    return restoredCommands.length;
  }

  dispose(): void {
    // Clear all processing intervals
    for (const [, interval] of this.commandProcessingIntervals) {
      clearTimeout(interval);
    }
    this.commandProcessingIntervals.clear();

    // Reject all pending commands
    for (const [sessionId] of this.commandQueues) {
      this.clearCommandQueue(sessionId);
    }

    // Clear all maps
    this.commandExecutions.clear();
    this.sessionCommandQueue.clear();
    this.outputSequenceCounters.clear();
    this.promptPatterns.clear();
    this.commandQueues.clear();
  }

  deleteSessionData(sessionId: string): void {
    this.commandExecutions.forEach((exec, id) => {
      if (exec.sessionId === sessionId) {
        this.commandExecutions.delete(id);
      }
    });
    this.sessionCommandQueue.delete(sessionId);
    this.outputSequenceCounters.delete(sessionId);
    this.promptPatterns.delete(sessionId);
    this.clearCommandQueue(sessionId);
  }
}
