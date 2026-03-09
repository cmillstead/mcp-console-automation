import { Client as SSHClient } from 'ssh2';
import { Logger } from '../utils/logger.js';

// Network performance monitoring for adaptive timeouts
export interface NetworkMetrics {
  latency: number;
  jitter: number;
  packetLoss: number;
  connectionQuality: 'excellent' | 'good' | 'fair' | 'poor';
  lastUpdated: Date;
  sampleCount: number;
}

// Adaptive timeout configuration
export interface AdaptiveTimeoutConfig {
  baseTimeout: number;
  maxTimeout: number;
  minTimeout: number;
  latencyMultiplier: number;
  jitterTolerance: number;
  qualityThresholds: {
    excellent: number;
    good: number;
    fair: number;
  };
}

// Connection health check result
export interface ConnectionHealthCheck {
  isHealthy: boolean;
  latency: number;
  error?: string;
  timestamp: Date;
  consecutiveFailures: number;
}

export class NetworkMetricsManager {
  private networkMetrics: Map<string, NetworkMetrics> = new Map();
  private latencyMeasurements: Map<string, number[]> = new Map();
  private adaptiveTimeoutConfig: AdaptiveTimeoutConfig;
  private connectionHealthChecks: Map<string, ConnectionHealthCheck> = new Map();
  private networkMonitoringTimer: NodeJS.Timeout | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;

    this.adaptiveTimeoutConfig = {
      baseTimeout: 10000, // 10 seconds base timeout
      maxTimeout: 3600000, // 1 hour maximum timeout (configurable)
      minTimeout: 3000, // 3 seconds minimum timeout
      latencyMultiplier: 5, // Multiply measured latency by this factor
      jitterTolerance: 0.3, // 30% jitter tolerance
      qualityThresholds: {
        excellent: 50, // < 50ms latency
        good: 200, // < 200ms latency
        fair: 1000, // < 1000ms latency
      },
    };
  }

  /**
   * Get metrics for a specific host
   */
  public getMetrics(host: string): NetworkMetrics | undefined {
    return this.networkMetrics.get(host);
  }

  /**
   * Get health check for a specific host
   */
  public getHealthCheck(host: string): ConnectionHealthCheck | undefined {
    return this.connectionHealthChecks.get(host);
  }

  /**
   * Measure network latency to a host
   */
  public async measureNetworkLatency(
    host: string,
    port: number = 22
  ): Promise<number> {
    const startTime = Date.now();

    try {
      // Use a simple TCP connection test for latency measurement
      const client = new SSHClient();

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          client.destroy();
          resolve(5000); // Return high latency on timeout
        }, 5000);

        client.on('ready', () => {
          clearTimeout(timeout);
          const latency = Date.now() - startTime;
          client.destroy();
          resolve(latency);
        });

        client.on('error', () => {
          clearTimeout(timeout);
          client.destroy();
          resolve(5000); // Return high latency on error
        });

        // Minimal connection attempt just for timing
        client.connect({
          host,
          port,
          username: 'test', // This will fail but still measure connection time
          timeout: 5000,
        });
      });
    } catch (error) {
      return 5000; // Return high latency on exception
    }
  }

  /**
   * Update network metrics for a host
   */
  public updateNetworkMetrics(host: string, latency: number): void {
    const existing = this.networkMetrics.get(host);
    const measurements = this.latencyMeasurements.get(host) || [];

    // Keep last 10 measurements for jitter calculation
    measurements.push(latency);
    if (measurements.length > 10) {
      measurements.shift();
    }
    this.latencyMeasurements.set(host, measurements);

    // Calculate jitter (variance in latency)
    const avgLatency =
      measurements.reduce((sum, lat) => sum + lat, 0) / measurements.length;
    const jitter =
      measurements.length > 1
        ? Math.sqrt(
            measurements.reduce(
              (sum, lat) => sum + Math.pow(lat - avgLatency, 2),
              0
            ) / measurements.length
          )
        : 0;

    // Determine connection quality
    let connectionQuality: 'excellent' | 'good' | 'fair' | 'poor';
    if (avgLatency < this.adaptiveTimeoutConfig.qualityThresholds.excellent) {
      connectionQuality = 'excellent';
    } else if (avgLatency < this.adaptiveTimeoutConfig.qualityThresholds.good) {
      connectionQuality = 'good';
    } else if (avgLatency < this.adaptiveTimeoutConfig.qualityThresholds.fair) {
      connectionQuality = 'fair';
    } else {
      connectionQuality = 'poor';
    }

    const metrics: NetworkMetrics = {
      latency: avgLatency,
      jitter,
      packetLoss: 0, // Would need more sophisticated testing for packet loss
      connectionQuality,
      lastUpdated: new Date(),
      sampleCount: (existing?.sampleCount || 0) + 1,
    };

    this.networkMetrics.set(host, metrics);
    this.logger.debug(`Updated network metrics for ${host}:`, {
      latency: avgLatency.toFixed(2) + 'ms',
      jitter: jitter.toFixed(2) + 'ms',
      quality: connectionQuality,
    });
  }

  /**
   * Calculate adaptive timeout based on network conditions
   */
  public calculateAdaptiveTimeout(host: string): number {
    const metrics = this.networkMetrics.get(host);
    const config = this.adaptiveTimeoutConfig;

    if (!metrics) {
      return config.baseTimeout;
    }

    // Base calculation: base timeout + (latency * multiplier)
    let adaptiveTimeout =
      config.baseTimeout + metrics.latency * config.latencyMultiplier;

    // Adjust for jitter
    const jitterAdjustment = metrics.jitter * config.jitterTolerance;
    adaptiveTimeout += jitterAdjustment;

    // Apply connection quality adjustments
    switch (metrics.connectionQuality) {
      case 'poor':
        adaptiveTimeout *= 2.0; // Double timeout for poor connections
        break;
      case 'fair':
        adaptiveTimeout *= 1.5; // 50% increase for fair connections
        break;
      case 'good':
        adaptiveTimeout *= 1.1; // 10% increase for good connections
        break;
      case 'excellent':
        // No adjustment for excellent connections
        break;
    }

    // Ensure timeout stays within bounds
    adaptiveTimeout = Math.max(
      config.minTimeout,
      Math.min(config.maxTimeout, adaptiveTimeout)
    );

    this.logger.debug(
      `Calculated adaptive timeout for ${host}: ${adaptiveTimeout.toFixed(0)}ms (quality: ${metrics.connectionQuality})`
    );
    return Math.round(adaptiveTimeout);
  }

  /**
   * Perform connection health check
   */
  public async performConnectionHealthCheck(
    host: string,
    port: number = 22
  ): Promise<ConnectionHealthCheck> {
    const existing = this.connectionHealthChecks.get(host);

    try {
      const latency = await this.measureNetworkLatency(host, port);
      const healthCheck: ConnectionHealthCheck = {
        isHealthy: latency < this.adaptiveTimeoutConfig.qualityThresholds.fair,
        latency,
        timestamp: new Date(),
        consecutiveFailures: 0,
      };

      this.connectionHealthChecks.set(host, healthCheck);
      this.updateNetworkMetrics(host, latency);

      return healthCheck;
    } catch (error) {
      const healthCheck: ConnectionHealthCheck = {
        isHealthy: false,
        latency: 5000,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
        consecutiveFailures: (existing?.consecutiveFailures || 0) + 1,
      };

      this.connectionHealthChecks.set(host, healthCheck);
      return healthCheck;
    }
  }

  /**
   * Calculate adaptive maximum retries based on connection quality
   */
  public calculateAdaptiveMaxRetries(
    connectionQuality?: 'excellent' | 'good' | 'fair' | 'poor'
  ): number {
    switch (connectionQuality) {
      case 'excellent':
        return 2; // Fewer retries for excellent connections
      case 'good':
        return 3; // Standard retries for good connections
      case 'fair':
        return 4; // More retries for fair connections
      case 'poor':
        return 5; // Maximum retries for poor connections
      default:
        return 3; // Default for unknown quality
    }
  }

  /**
   * Calculate adaptive base delay based on connection quality
   */
  public calculateAdaptiveBaseDelay(
    connectionQuality?: 'excellent' | 'good' | 'fair' | 'poor'
  ): number {
    switch (connectionQuality) {
      case 'excellent':
        return 500; // 0.5 seconds for excellent connections
      case 'good':
        return 1000; // 1 second for good connections
      case 'fair':
        return 2000; // 2 seconds for fair connections
      case 'poor':
        return 3000; // 3 seconds for poor connections
      default:
        return 1000; // Default 1 second
    }
  }

  /**
   * Start periodic network performance monitoring
   */
  public startMonitoring(getKnownHosts: () => string[]): void {
    // Monitor all known hosts every 5 minutes
    const monitoringInterval = 5 * 60 * 1000; // 5 minutes

    this.networkMonitoringTimer = setInterval(async () => {
      const hosts = Array.from(
        new Set([
          ...Array.from(this.networkMetrics.keys()),
          ...getKnownHosts(),
        ])
      );

      for (const host of hosts) {
        try {
          await this.performConnectionHealthCheck(host);
          this.logger.debug(`Completed periodic health check for ${host}`);
        } catch (error) {
          this.logger.warn(`Failed periodic health check for ${host}:`, error);
        }
      }

      // Clean up old metrics (older than 24 hours)
      this.cleanupOldNetworkMetrics();
    }, monitoringInterval);

    this.logger.info('Started network performance monitoring');
  }

  /**
   * Clean up old network metrics and measurements
   */
  private cleanupOldNetworkMetrics(): void {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    Array.from(this.networkMetrics.entries()).forEach(([host, metrics]) => {
      if (now - metrics.lastUpdated.getTime() > maxAge) {
        this.networkMetrics.delete(host);
        this.latencyMeasurements.delete(host);
        this.connectionHealthChecks.delete(host);
        this.logger.debug(`Cleaned up old metrics for ${host}`);
      }
    });
  }

  /**
   * Get network performance summary for debugging
   */
  public getNetworkPerformanceSummary(): Array<{
    host: string;
    latency: number;
    jitter: number;
    quality: string;
    adaptiveTimeout: number;
    lastUpdated: Date;
    sampleCount: number;
  }> {
    return Array.from(this.networkMetrics.entries()).map(([host, metrics]) => ({
      host,
      latency: metrics.latency,
      jitter: metrics.jitter,
      quality: metrics.connectionQuality,
      adaptiveTimeout: this.calculateAdaptiveTimeout(host),
      lastUpdated: metrics.lastUpdated,
      sampleCount: metrics.sampleCount,
    }));
  }

  /**
   * Dispose of resources (clear monitoring timer)
   */
  public dispose(): void {
    if (this.networkMonitoringTimer) {
      clearInterval(this.networkMonitoringTimer);
      this.networkMonitoringTimer = null;
    }
  }
}
