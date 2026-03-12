import { Logger } from '../utils/logger.js';
import { QueuedCommand, TimeoutRecoveryResult } from './CommandQueueManager.js';
import { ClientChannel } from 'ssh2';

/**
 * Callback interface that ConsoleManager implements to provide
 * the TimeoutRecoveryManager access to SSH connections, session state,
 * and recovery infrastructure.
 */
export interface TimeoutRecoveryHost {
  getSSHClient(sessionId: string): any;
  getSSHChannel(sessionId: string): any;
  attemptSSHReconnection(sessionId: string): Promise<TimeoutRecoveryResult>;
  sendInput(sessionId: string, input: string): Promise<void>;
  getSession(sessionId: string): any;
  getOutputBuffer(sessionId: string): any[];
  setOutputBuffer(sessionId: string, buffer: any[]): void;
  getSessionRecovery(): any;
  getPersistenceManager(): any;
  getCommandQueueManager(): any;
  emitEvent(event: string, data: any): void;
  isSelfHealingEnabled(): boolean;
  delay(ms: number): Promise<void>;
  createSessionBookmark(sessionId: string, reason: string): Promise<void>;
  getRetryManager(): any;
  getErrorRecovery(): any;
}

/**
 * Manages timeout recovery logic for SSH sessions with session persistence
 * and state restoration. Extracted from ConsoleManager.
 */
export class TimeoutRecoveryManager {
  private readonly host: TimeoutRecoveryHost;
  private readonly logger: Logger;

  // Timeout recovery tracking
  private recoveryAttempts: Map<string, number> = new Map();
  private readonly maxRecoveryAttempts = 3;

  // Recovery success rate monitoring
  private recoveryMetrics = {
    totalRecoveryAttempts: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    averageRecoveryTimeMs: 0,
    recoverySuccessRateByCategory: new Map<
      string,
      { attempts: number; successes: number }
    >(),
    lastRecoveryTimestamp: 0,
    recoveryAttemptHistory: [] as Array<{
      timestamp: number;
      sessionId: string;
      category: string;
      success: boolean;
      durationMs: number;
      error?: string;
    }>,
  };

  // Timeout-specific error patterns for enhanced classification
  static readonly TIMEOUT_ERROR_PATTERNS = {
    command_acknowledgment: [
      /command acknowledgment timeout/i,
      /acknowledgment timeout/i,
      /waiting for command response/i,
      /command response timeout/i,
    ],
    ssh_connection: [
      /ssh connection timeout/i,
      /connection timed out/i,
      /handshake timeout/i,
      /authentication timeout/i,
      /ssh timeout/i,
    ],
    network_latency: [
      /network latency/i,
      /high latency detected/i,
      /slow network/i,
      /network congestion/i,
    ],
    ssh_responsiveness: [
      /ssh session unresponsive/i,
      /channel unresponsive/i,
      /responsiveness test failed/i,
      /ssh not responding/i,
    ],
    command_execution: [
      /command execution timeout/i,
      /execution timed out/i,
      /command took too long/i,
      /long running command timeout/i,
    ],
    recovery_timeout: [
      /recovery timeout/i,
      /timeout recovery failed/i,
      /recovery attempt timeout/i,
      /max recovery attempts/i,
    ],
  };

  constructor(host: TimeoutRecoveryHost, logger: Logger) {
    this.host = host;
    this.logger = logger;
  }

  /**
   * Get recovery attempt count for a session.
   */
  getRecoveryAttempts(sessionId: string): number {
    return this.recoveryAttempts.get(sessionId) || 0;
  }

  /**
   * Clear recovery attempts for a session (e.g., on cleanup).
   */
  clearRecoveryAttempts(sessionId: string): void {
    this.recoveryAttempts.delete(sessionId);
  }

  /**
   * Enhanced timeout recovery for SSH sessions with session persistence and state restoration
   */
  async attemptTimeoutRecovery(
    sessionId: string,
    command: QueuedCommand
  ): Promise<TimeoutRecoveryResult> {
    const recoveryStartTime = Date.now();
    const currentAttempts = this.recoveryAttempts.get(sessionId) || 0;

    // Create timeout error for enhanced classification
    const timeoutError = new Error(
      `SSH command acknowledgment timeout after ${Date.now() - command.timestamp.getTime()}ms`
    );
    const timeoutClassification = this.classifyTimeoutError(timeoutError);

    // Update persistent data with recovery attempt
    const persistentData = this.host.getPersistenceManager().getPersistenceData(sessionId);
    if (persistentData) {
      persistentData.recoveryMetadata.timeoutRecoveryAttempts =
        currentAttempts + 1;
      persistentData.recoveryMetadata.lastRecoveryTime = new Date();
      persistentData.connectionState.lastError = 'timeout';
    }

    // Create recovery bookmark before attempting recovery
    await this.host.createSessionBookmark(sessionId, 'timeout-recovery');

    if (currentAttempts >= this.maxRecoveryAttempts) {
      this.logger.warn(
        `Max timeout recovery attempts reached for session ${sessionId}`
      );

      // Check if this is an interactive prompt timeout that needs specialized recovery
      const shouldTriggerInteractive =
        this.host.getSessionRecovery().shouldTriggerInteractiveRecovery(sessionId);
      if (shouldTriggerInteractive.shouldTrigger) {
        this.logger.info(
          `Triggering interactive prompt recovery for session ${sessionId}: ${shouldTriggerInteractive.reason}`
        );

        // Update interactive state with timeout information
        await this.host.getSessionRecovery().updateInteractiveState(sessionId, {
          sessionUnresponsive: true,
          timeoutCount: currentAttempts,
          pendingCommands: [command.input],
          isInteractive: true,
        });

        // Attempt interactive prompt recovery
        const interactiveRecovery = await this.host.getSessionRecovery().recoverSession(
          sessionId,
          `interactive-prompt-timeout-${shouldTriggerInteractive.urgency}`
        );

        if (interactiveRecovery) {
          this.logger.info(
            `Interactive prompt recovery succeeded for session ${sessionId}`
          );
          return { success: true, reconnected: false };
        }
      }

      // Classify this as a permanent timeout failure for error recovery system
      const errorContext = {
        sessionId,
        operation: 'timeout_recovery',
        error: new Error('Max timeout recovery attempts exceeded'),
        timestamp: Date.now(),
        metadata: {
          attempts: currentAttempts,
          commandInput: command.input.substring(0, 100),
          interactivePromptDetected: shouldTriggerInteractive.shouldTrigger,
        },
      };

      // Attempt graceful degradation through error recovery system
      const classification = this.host.getErrorRecovery().classifyError(
        errorContext.error
      );
      if (classification?.recoverable) {
        this.logger.info(
          `Error recovery system suggests timeout is recoverable, trying fallback strategy`
        );
        const recoveryResult =
          await this.host.getErrorRecovery().attemptRecovery(errorContext);
        if (recoveryResult) {
          return { success: true, error: 'Recovered via fallback strategy' };
        }
      }

      // Record failed recovery attempt in metrics
      const recoveryDuration = Date.now() - recoveryStartTime;
      this.recordRecoveryAttempt(
        sessionId,
        timeoutClassification.category,
        false,
        recoveryDuration,
        'Max recovery attempts exceeded'
      );

      return { success: false, error: 'Max recovery attempts exceeded' };
    }

    this.recoveryAttempts.set(sessionId, currentAttempts + 1);
    this.logger.info(
      `Attempting timeout recovery for session ${sessionId} (attempt ${currentAttempts + 1})`
    );

    // Create error context for integration with error recovery system
    const recoveryContext = {
      sessionId,
      operation: 'ssh_timeout_recovery',
      error: new Error('SSH timeout recovery attempt'),
      timestamp: Date.now(),
      metadata: {
        attemptNumber: currentAttempts + 1,
        maxAttempts: this.maxRecoveryAttempts,
        commandInput: command.input.substring(0, 100),
        commandRetryCount: command.retryCount,
      },
      previousAttempts: currentAttempts,
    };

    try {
      // Step 1: Classify the timeout error to determine optimal recovery strategy
      const timeoutError = new Error(
        `SSH command acknowledgment timeout after ${Date.now() - command.timestamp.getTime()}ms`
      );
      const errorClassification =
        this.host.getErrorRecovery().classifyError(timeoutError);

      this.logger.info(
        `Timeout classified as: ${errorClassification?.type || 'unknown'} (severity: ${errorClassification?.severity || 'medium'})`
      );

      // Step 2: Check circuit breaker state before attempting recovery
      const circuitKey = `ssh_timeout_${sessionId}`;
      const circuitState =
        this.host.getRetryManager().getCircuitBreakerStates()[circuitKey];

      if (circuitState?.state === 'open') {
        this.logger.warn(
          `Circuit breaker is open for SSH timeout recovery on session ${sessionId}`
        );

        // Wait for circuit breaker cooldown or try alternative recovery
        const now = Date.now();
        if (now < circuitState.nextAttemptTime) {
          const waitTime = circuitState.nextAttemptTime - now;
          this.logger.info(
            `Waiting ${waitTime}ms for circuit breaker cooldown`
          );
          await this.host.delay(Math.min(waitTime, 5000)); // Max 5 second wait
        }
      }

      // Step 3: Check if SSH connection is still alive
      const sshClient = this.host.getSSHClient(sessionId);
      const sshChannel = this.host.getSSHChannel(sessionId);

      if (!sshClient || !sshChannel) {
        this.logger.warn(
          `SSH client or channel missing for session ${sessionId}, attempting reconnection`
        );

        // Use retry manager for reconnection attempts
        return await this.host.getRetryManager().executeWithRetry(
          async () => await this.host.attemptSSHReconnection(sessionId),
          {
            sessionId,
            operationName: 'ssh_reconnection',
            strategyName: 'ssh',
            onRetry: (context: any) => {
              this.logger.info(
                `Retrying SSH reconnection for ${sessionId} (attempt ${context.attemptNumber})`
              );
            },
          }
        );
      }

      // Step 4: Enhanced connection responsiveness test with multiple fallbacks
      const testResult = await this.testSSHResponsiveness(
        sessionId,
        sshChannel
      );
      if (!testResult.responsive) {
        this.logger.warn(
          `SSH session ${sessionId} unresponsive, attempting reconnection`
        );

        // Circuit breaker will be handled by the retry operation itself

        return await this.host.getRetryManager().executeWithRetry(
          async () => await this.host.attemptSSHReconnection(sessionId),
          {
            sessionId,
            operationName: 'ssh_reconnection_after_timeout',
            strategyName: 'ssh',
            onRetry: (context: any) => {
              this.logger.info(
                `Retrying SSH reconnection after timeout for ${sessionId} (attempt ${context.attemptNumber})`
              );
            },
          }
        );
      }

      // Step 5: Clear any stale output and reset acknowledgment state
      await this.clearStaleOutput(sessionId);

      // Step 6: Reset command state for retry with exponential backoff
      command.acknowledged = false;
      command.sent = false;
      command.retryCount = (command.retryCount || 0) + 1;

      // Apply exponential backoff based on retry count
      const backoffDelay = Math.min(
        1000 * Math.pow(2, command.retryCount - 1),
        8000
      );
      if (backoffDelay > 0) {
        this.logger.info(
          `Applying ${backoffDelay}ms backoff before command retry`
        );
        await this.host.delay(backoffDelay);
      }

      // Step 7: Test with a simple command to ensure the session is truly responsive
      const finalValidation = await this.validateSessionRecovery(
        sessionId,
        sshChannel
      );
      if (!finalValidation.valid) {
        this.logger.warn(
          `Session validation failed after recovery attempt: ${finalValidation.error}`
        );
        return { success: false, error: finalValidation.error };
      }

      // Success is automatically recorded by the retry manager

      // Step 8: Restore session state from latest bookmark if available
      await this.host.getPersistenceManager().restoreSessionStateFromBookmark(sessionId);

      // Step 9: Update persistent data with successful recovery
      if (persistentData) {
        persistentData.connectionState.isConnected = true;
        persistentData.connectionState.lastConnectionTime = new Date();
        persistentData.recoveryMetadata.recoveryStrategiesUsed.push(
          'timeout-recovery-success'
        );
        persistentData.lastActivity = new Date();
      }

      // Reset recovery attempts on successful recovery
      this.recoveryAttempts.delete(sessionId);

      // Record successful recovery attempt in metrics
      const recoveryDuration = Date.now() - recoveryStartTime;
      this.recordRecoveryAttempt(
        sessionId,
        timeoutClassification.category,
        true,
        recoveryDuration
      );

      this.logger.info(
        `Successfully recovered SSH session ${sessionId} with state restoration and ${command.retryCount} retries`
      );
      return {
        success: true,
        restoredCommands: this.host.getCommandQueueManager().restoreCommandQueueFromPersistence(sessionId),
        metadata: {
          retryCount: command.retryCount,
          backoffDelay,
          stateRestored: true,
          recoveryDurationMs: recoveryDuration,
        },
      };
    } catch (error) {
      this.logger.error(
        `Enhanced timeout recovery failed for session ${sessionId}:`,
        error
      );

      // Update persistent data with failure
      if (persistentData) {
        persistentData.connectionState.isConnected = false;
        persistentData.connectionState.lastError =
          error instanceof Error ? error.message : String(error);
        persistentData.recoveryMetadata.recoveryStrategiesUsed.push(
          'timeout-recovery-failed'
        );
      }

      // Circuit breaker failure will be handled by retry mechanism

      // Update error context with actual error
      recoveryContext.error = error as Error;

      // Attempt error recovery as last resort
      const errorRecoveryResult =
        await this.host.getErrorRecovery().attemptRecovery(recoveryContext);
      if (errorRecoveryResult) {
        this.logger.info(
          `Error recovery system provided fallback recovery for session ${sessionId}`
        );
        return { success: true, error: 'Recovered via error recovery system' };
      }

      // Record failed recovery attempt in metrics
      const recoveryDuration = Date.now() - recoveryStartTime;
      this.recordRecoveryAttempt(
        sessionId,
        timeoutClassification.category,
        false,
        recoveryDuration,
        error instanceof Error ? error.message : String(error)
      );

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test SSH connection responsiveness with enhanced fallback mechanisms
   */
  private async testSSHResponsiveness(
    sessionId: string,
    channel: ClientChannel
  ): Promise<{ responsive: boolean; details?: string }> {
    return new Promise((resolve) => {
      const primaryTimeout = 2000;
      const fallbackTimeout = 5000;
      let responseReceived = false;
      let testPhase = 'primary';

      const cleanup = () => {
        channel.removeListener('data', onData);
        channel.removeListener('error', onError);
        channel.removeListener('close', onClose);
      };

      // Primary timeout (2 seconds)
      const primaryTimer = setTimeout(async () => {
        if (!responseReceived) {
          this.logger.warn(
            `Primary responsiveness test failed for session ${sessionId}, trying fallback`
          );
          testPhase = 'fallback';

          // Try a different command as fallback
          try {
            channel.write('\n'); // Just send a newline

            // Extended timeout for fallback
            setTimeout(() => {
              if (!responseReceived) {
                this.logger.warn(
                  `Fallback responsiveness test also failed for session ${sessionId}`
                );
                cleanup();
                resolve({
                  responsive: false,
                  details: 'Both primary and fallback tests failed',
                });
              }
            }, fallbackTimeout - primaryTimeout);
          } catch (error) {
            this.logger.error(
              `Error during fallback responsiveness test:`,
              error
            );
            cleanup();
            resolve({
              responsive: false,
              details: `Fallback test error: ${error}`,
            });
          }
        }
      }, primaryTimeout);

      const onData = (data: Buffer) => {
        if (!responseReceived) {
          responseReceived = true;
          clearTimeout(primaryTimer);
          cleanup();

          const dataStr = data.toString();
          this.logger.debug(
            `Responsiveness test ${testPhase} succeeded for session ${sessionId}: ${dataStr.substring(0, 50)}`
          );
          resolve({
            responsive: true,
            details: `${testPhase} test succeeded: ${dataStr.length} bytes received`,
          });
        }
      };

      const onError = (error: Error) => {
        if (!responseReceived) {
          responseReceived = true;
          clearTimeout(primaryTimer);
          cleanup();

          this.logger.error(
            `SSH channel error during responsiveness test for session ${sessionId}:`,
            error
          );
          resolve({
            responsive: false,
            details: `Channel error: ${error.message}`,
          });
        }
      };

      const onClose = () => {
        if (!responseReceived) {
          responseReceived = true;
          clearTimeout(primaryTimer);
          cleanup();

          this.logger.warn(
            `SSH channel closed during responsiveness test for session ${sessionId}`
          );
          resolve({ responsive: false, details: 'Channel closed during test' });
        }
      };

      // Set up event listeners
      channel.on('data', onData);
      channel.on('error', onError);
      channel.on('close', onClose);

      try {
        // Send a simple echo command that should respond immediately
        channel.write('echo "responsiveness-test-$(date +%s)"\n');
      } catch (error) {
        clearTimeout(primaryTimer);
        cleanup();
        resolve({ responsive: false, details: `Write error: ${error}` });
      }
    });
  }

  /**
   * Clear stale output from buffers
   */
  private async clearStaleOutput(sessionId: string): Promise<void> {
    // Clear command queue output buffer
    this.host.getCommandQueueManager().clearQueueOutputBuffer(sessionId);

    // Optional: Clear session output buffer if needed
    const outputBuffer = this.host.getOutputBuffer(sessionId);
    if (outputBuffer && outputBuffer.length > 50) {
      // Keep only recent outputs
      const recentOutputs = outputBuffer.slice(-10);
      this.host.setOutputBuffer(sessionId, recentOutputs);
    }
  }

  /**
   * Enhanced timeout error classification with specific timeout patterns
   */
  classifyTimeoutError(error: Error): {
    type: string;
    severity: string;
    category: string;
    recoverable: boolean;
  } {
    const errorMsg = error.message.toLowerCase();

    // Check for specific timeout patterns
    for (const [category, patterns] of Object.entries(
      TimeoutRecoveryManager.TIMEOUT_ERROR_PATTERNS
    )) {
      for (const pattern of patterns) {
        if (pattern.test(errorMsg)) {
          const classification = this.determineTimeoutSeverity(
            category,
            errorMsg
          );
          return {
            type: 'timeout',
            severity: classification.severity,
            category: `timeout_${category}`,
            recoverable: classification.recoverable,
          };
        }
      }
    }

    // Fallback to standard error recovery classification
    const standardClassification = this.host.getErrorRecovery().classifyError(error);
    return (
      standardClassification || {
        type: 'timeout',
        severity: 'medium',
        category: 'timeout_unknown',
        recoverable: true,
      }
    );
  }

  /**
   * Determine timeout severity and recoverability based on category
   */
  determineTimeoutSeverity(
    category: string,
    errorMsg: string
  ): { severity: string; recoverable: boolean } {
    const severityMap = {
      command_acknowledgment: { severity: 'medium', recoverable: true },
      ssh_connection: { severity: 'high', recoverable: true },
      network_latency: { severity: 'low', recoverable: true },
      ssh_responsiveness: { severity: 'medium', recoverable: true },
      command_execution: { severity: 'medium', recoverable: true },
      recovery_timeout: { severity: 'high', recoverable: false },
    };

    // Check for critical indicators that make errors less recoverable
    const criticalIndicators = [
      'max attempts',
      'circuit breaker',
      'permanent failure',
      'authentication failed',
      'host unreachable',
    ];

    const isCritical = criticalIndicators.some((indicator) =>
      errorMsg.includes(indicator)
    );

    const baseSeverity = severityMap[category as keyof typeof severityMap] || {
      severity: 'medium',
      recoverable: true,
    };

    return {
      severity: isCritical ? 'critical' : baseSeverity.severity,
      recoverable: isCritical ? false : baseSeverity.recoverable,
    };
  }

  /**
   * Record recovery attempt metrics
   */
  recordRecoveryAttempt(
    sessionId: string,
    category: string,
    success: boolean,
    durationMs: number,
    error?: string
  ): void {
    const timestamp = Date.now();

    // Update overall metrics
    this.recoveryMetrics.totalRecoveryAttempts++;
    if (success) {
      this.recoveryMetrics.successfulRecoveries++;
    } else {
      this.recoveryMetrics.failedRecoveries++;
    }

    // Update average recovery time
    const totalDuration =
      this.recoveryMetrics.averageRecoveryTimeMs *
        (this.recoveryMetrics.totalRecoveryAttempts - 1) +
      durationMs;
    this.recoveryMetrics.averageRecoveryTimeMs =
      totalDuration / this.recoveryMetrics.totalRecoveryAttempts;

    // Update category-specific metrics
    const categoryStats =
      this.recoveryMetrics.recoverySuccessRateByCategory.get(category) || {
        attempts: 0,
        successes: 0,
      };
    categoryStats.attempts++;
    if (success) {
      categoryStats.successes++;
    }
    this.recoveryMetrics.recoverySuccessRateByCategory.set(
      category,
      categoryStats
    );

    // Add to history (keep only recent 100 attempts)
    this.recoveryMetrics.recoveryAttemptHistory.push({
      timestamp,
      sessionId,
      category,
      success,
      durationMs,
      error,
    });

    if (this.recoveryMetrics.recoveryAttemptHistory.length > 100) {
      this.recoveryMetrics.recoveryAttemptHistory.shift();
    }

    this.recoveryMetrics.lastRecoveryTimestamp = timestamp;

    // Log metrics periodically
    if (this.recoveryMetrics.totalRecoveryAttempts % 10 === 0) {
      this.logRecoveryMetrics();
    }
  }

  /**
   * Get current recovery success rates and metrics
   */
  getTimeoutRecoveryMetrics() {
    const successRate =
      this.recoveryMetrics.totalRecoveryAttempts > 0
        ? (this.recoveryMetrics.successfulRecoveries /
            this.recoveryMetrics.totalRecoveryAttempts) *
          100
        : 0;

    const categoryRates = new Map<string, number>();
    for (const [category, stats] of Array.from(
      this.recoveryMetrics.recoverySuccessRateByCategory
    )) {
      const rate =
        stats.attempts > 0 ? (stats.successes / stats.attempts) * 100 : 0;
      categoryRates.set(category, rate);
    }

    return {
      overallSuccessRate: successRate,
      totalAttempts: this.recoveryMetrics.totalRecoveryAttempts,
      successfulRecoveries: this.recoveryMetrics.successfulRecoveries,
      failedRecoveries: this.recoveryMetrics.failedRecoveries,
      averageRecoveryTimeMs: this.recoveryMetrics.averageRecoveryTimeMs,
      categorySuccessRates: Object.fromEntries(categoryRates),
      recentHistory: this.recoveryMetrics.recoveryAttemptHistory.slice(-10),
      lastRecoveryTimestamp: this.recoveryMetrics.lastRecoveryTimestamp,
    };
  }

  /**
   * Log recovery metrics for monitoring and debugging
   */
  private logRecoveryMetrics(): void {
    const metrics = this.getTimeoutRecoveryMetrics();

    this.logger.info(`Recovery Metrics Summary:
      Overall Success Rate: ${metrics.overallSuccessRate.toFixed(1)}%
      Total Attempts: ${metrics.totalAttempts}
      Successful: ${metrics.successfulRecoveries}
      Failed: ${metrics.failedRecoveries}
      Avg Recovery Time: ${metrics.averageRecoveryTimeMs.toFixed(0)}ms`);

    if (Object.keys(metrics.categorySuccessRates).length > 0) {
      const categoryReport = Object.entries(metrics.categorySuccessRates)
        .map(([category, rate]) => `${category}: ${(rate as number).toFixed(1)}%`)
        .join(', ');

      this.logger.info(`Category Success Rates: ${categoryReport}`);
    }
  }

  /**
   * Validate session recovery by testing actual command execution
   */
  private async validateSessionRecovery(
    sessionId: string,
    channel: ClientChannel
  ): Promise<{ valid: boolean; error?: string }> {
    return new Promise((resolve) => {
      const validationTimeout = 3000;
      let validationReceived = false;
      const testId = Date.now().toString(36);

      const cleanup = () => {
        channel.removeListener('data', onValidationData);
        channel.removeListener('error', onValidationError);
        channel.removeListener('close', onValidationClose);
      };

      const timer = setTimeout(() => {
        if (!validationReceived) {
          validationReceived = true;
          cleanup();
          resolve({ valid: false, error: 'Validation command timeout' });
        }
      }, validationTimeout);

      const onValidationData = (data: Buffer) => {
        if (!validationReceived) {
          const dataStr = data.toString();

          // Check if we received our test response
          if (
            dataStr.includes(testId) ||
            dataStr.includes('validation-success')
          ) {
            validationReceived = true;
            clearTimeout(timer);
            cleanup();
            resolve({ valid: true });
          }
        }
      };

      const onValidationError = (error: Error) => {
        if (!validationReceived) {
          validationReceived = true;
          clearTimeout(timer);
          cleanup();
          resolve({
            valid: false,
            error: `Validation error: ${error.message}`,
          });
        }
      };

      const onValidationClose = () => {
        if (!validationReceived) {
          validationReceived = true;
          clearTimeout(timer);
          cleanup();
          resolve({ valid: false, error: 'Channel closed during validation' });
        }
      };

      // Set up listeners
      channel.on('data', onValidationData);
      channel.on('error', onValidationError);
      channel.on('close', onValidationClose);

      try {
        // Send a validation command that should respond quickly
        channel.write(`echo "validation-success-${testId}"\n`);
      } catch (error) {
        clearTimeout(timer);
        cleanup();
        resolve({
          valid: false,
          error: `Write error during validation: ${error}`,
        });
      }
    });
  }

  /**
   * Dispose of internal state and resources.
   */
  dispose(): void {
    this.recoveryAttempts.clear();
    this.recoveryMetrics.totalRecoveryAttempts = 0;
    this.recoveryMetrics.successfulRecoveries = 0;
    this.recoveryMetrics.failedRecoveries = 0;
    this.recoveryMetrics.averageRecoveryTimeMs = 0;
    this.recoveryMetrics.recoverySuccessRateByCategory.clear();
    this.recoveryMetrics.lastRecoveryTimestamp = 0;
    this.recoveryMetrics.recoveryAttemptHistory = [];
  }
}
