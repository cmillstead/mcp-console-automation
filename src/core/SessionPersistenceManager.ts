import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { SSHConnectionOptions } from '../types/index.js';

// Enhanced session persistence interfaces
export interface SessionPersistentData {
  sessionId: string;
  createdAt: Date;
  lastActivity: Date;
  sshOptions?: SSHConnectionOptions;
  environment: Record<string, string>;
  workingDirectory: string;
  commandHistory: string[];
  pendingCommands: SerializedQueuedCommand[];
  outputHistory: string[];
  sessionState: any;
  connectionState: {
    isConnected: boolean;
    lastConnectionTime?: Date;
    connectionAttempts: number;
    lastError?: string;
  };
  recoveryMetadata: {
    timeoutRecoveryAttempts: number;
    lastRecoveryTime?: Date;
    recoveryStrategiesUsed: string[];
  };
}

export interface SerializedQueuedCommand {
  id: string;
  sessionId: string;
  input: string;
  timestamp: string;
  retryCount: number;
  acknowledged: boolean;
  sent: boolean;
  priority?: number;
  context?: any;
}

export interface SessionBookmark {
  id: string;
  sessionId: string;
  timestamp: Date;
  description: string;
  sessionState: any;
  commandQueueSnapshot: SerializedQueuedCommand[];
  outputSnapshot: string[];
  environmentSnapshot: Record<string, string>;
  metadata?: any;
}

export interface SessionContinuityConfig {
  enablePersistence: boolean;
  persistenceInterval: number;
  maxBookmarks: number;
  bookmarkStrategy: 'periodic' | 'on-command' | 'on-timeout' | 'hybrid';
  recoveryTimeout: number;
  enableSessionMigration: boolean;
}

/**
 * Data provider interface for accessing session data from ConsoleManager
 */
export interface SessionDataProvider {
  getCommandQueueSnapshot(sessionId: string): SerializedQueuedCommand[] | undefined;
  getOutputHistory(sessionId: string): string[] | undefined;
}

export class SessionPersistenceManager {
  private sessionPersistenceData: Map<string, SessionPersistentData> = new Map();
  private sessionBookmarks: Map<string, SessionBookmark[]> = new Map();
  private continuityConfig: SessionContinuityConfig;
  private persistenceTimer: NodeJS.Timeout | null = null;
  private bookmarkTimers: Map<string, NodeJS.Timeout> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.continuityConfig = {
      enablePersistence: true,
      persistenceInterval: 30000, // 30 seconds
      maxBookmarks: 10,
      bookmarkStrategy: 'hybrid',
      recoveryTimeout: 60000, // 1 minute
      enableSessionMigration: true,
    };
  }

  /**
   * Initialize session continuity system
   */
  initializeSessionContinuity(dataProvider: SessionDataProvider): void {
    if (!this.continuityConfig.enablePersistence) {
      return;
    }

    // Start periodic persistence (guard against double-initialization)
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
    }
    this.persistenceTimer = setInterval(() => {
      this.persistAllSessionData(dataProvider);
    }, this.continuityConfig.persistenceInterval);

    // Load any existing persistent data
    this.loadPersistedSessionData();

    this.logger.info(
      'Session continuity system initialized with SessionRecovery integration'
    );
  }

  /**
   * Initialize persistent session data for a session
   */
  initializeSessionPersistence(
    sessionId: string,
    options: { sshOptions?: SSHConnectionOptions; env?: Record<string, string>; cwd?: string }
  ): void {
    const persistentData: SessionPersistentData = {
      sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
      sshOptions: options.sshOptions,
      environment: options.env || {},
      workingDirectory: options.cwd || process.cwd(),
      commandHistory: [],
      pendingCommands: [],
      outputHistory: [],
      sessionState: {},
      connectionState: {
        isConnected: true,
        lastConnectionTime: new Date(),
        connectionAttempts: 0,
      },
      recoveryMetadata: {
        timeoutRecoveryAttempts: 0,
        recoveryStrategiesUsed: [],
      },
    };

    this.sessionPersistenceData.set(sessionId, persistentData);
    this.sessionBookmarks.set(sessionId, []);

    // Start bookmark creation based on strategy
    this.initializeBookmarkStrategy(sessionId);

    this.logger.debug(`Initialized session persistence for ${sessionId}`);
  }

  /**
   * Initialize bookmark strategy for a session
   */
  initializeBookmarkStrategy(sessionId: string): void {
    const strategy = this.continuityConfig.bookmarkStrategy;

    if (strategy === 'periodic' || strategy === 'hybrid') {
      // Create periodic bookmarks
      const timer = setInterval(() => {
        this.createSessionBookmark(sessionId, 'periodic');
      }, 60000); // Every minute

      this.bookmarkTimers.set(sessionId, timer);
    }
  }

  /**
   * Create a session bookmark for recovery purposes
   */
  async createSessionBookmark(
    sessionId: string,
    trigger: string,
    commandQueueSnapshot?: SerializedQueuedCommand[],
    queueLength?: number
  ): Promise<void> {
    const persistentData = this.sessionPersistenceData.get(sessionId);

    if (!persistentData) {
      return;
    }

    const bookmark: SessionBookmark = {
      id: uuidv4(),
      sessionId,
      timestamp: new Date(),
      description: `${trigger} bookmark`,
      sessionState: { ...persistentData.sessionState },
      commandQueueSnapshot: commandQueueSnapshot || [],
      outputSnapshot: [...persistentData.outputHistory],
      environmentSnapshot: { ...persistentData.environment },
      metadata: {
        trigger,
        connectionState: { ...persistentData.connectionState },
        queueLength: queueLength ?? 0,
      },
    };

    const bookmarks = this.sessionBookmarks.get(sessionId) || [];
    bookmarks.push(bookmark);

    // Keep only the latest N bookmarks
    if (bookmarks.length > this.continuityConfig.maxBookmarks) {
      bookmarks.shift();
    }

    this.sessionBookmarks.set(sessionId, bookmarks);

    // Update persistent data
    persistentData.lastActivity = new Date();

    this.logger.debug(`Created ${trigger} bookmark for session ${sessionId}`);
  }

  /**
   * Restore session state from the most recent bookmark
   */
  async restoreSessionStateFromBookmark(sessionId: string): Promise<void> {
    const bookmarks = this.sessionBookmarks.get(sessionId);
    if (!bookmarks || bookmarks.length === 0) {
      this.logger.debug(
        `No bookmarks available for session ${sessionId} restoration`
      );
      return;
    }

    // Get the most recent bookmark
    const latestBookmark = bookmarks[bookmarks.length - 1];
    const persistentData = this.sessionPersistenceData.get(sessionId);

    if (persistentData) {
      // Restore session state
      persistentData.sessionState = { ...latestBookmark.sessionState };
      persistentData.environment = { ...latestBookmark.environmentSnapshot };
      persistentData.outputHistory = [...latestBookmark.outputSnapshot];

      this.logger.info(
        `Restored session state for ${sessionId} from bookmark: ${latestBookmark.description}`
      );
    }
  }

  /**
   * Get pending commands from persistence data for restoration.
   * Returns the serialized commands, or empty array if none found.
   */
  restoreCommandQueueFromPersistence(sessionId: string): SerializedQueuedCommand[] {
    const persistentData = this.sessionPersistenceData.get(sessionId);

    if (!persistentData || persistentData.pendingCommands.length === 0) {
      return [];
    }

    return persistentData.pendingCommands;
  }

  /**
   * Persist all session data to storage
   */
  async persistAllSessionData(dataProvider: SessionDataProvider): Promise<void> {
    if (!this.continuityConfig.enablePersistence) {
      return;
    }

    try {
      for (const [sessionId, persistentData] of Array.from(
        this.sessionPersistenceData
      )) {
        // Update current command queue state
        const queueSnapshot = dataProvider.getCommandQueueSnapshot(sessionId);
        if (queueSnapshot) {
          persistentData.pendingCommands = queueSnapshot;
        }

        // Update output history
        const outputHistory = dataProvider.getOutputHistory(sessionId);
        if (outputHistory) {
          persistentData.outputHistory = outputHistory;
        }

        // Save to disk (implement based on your storage preference)
        await this.persistSessionData(sessionId, persistentData);
      }

      this.logger.debug(
        `Persisted data for ${this.sessionPersistenceData.size} sessions`
      );
    } catch (error) {
      this.logger.error('Failed to persist session data:', error);
    }
  }

  /**
   * Persist session data to storage (placeholder - implement based on storage choice)
   */
  async persistSessionData(
    sessionId: string,
    _data: SessionPersistentData
  ): Promise<void> {
    // This would typically save to file system, database, or other storage
    // For now, it's a placeholder that could be implemented based on requirements
    this.logger.debug(`Persisting session data for ${sessionId}`);
  }

  /**
   * Load persisted session data from storage
   */
  async loadPersistedSessionData(): Promise<void> {
    // This would typically load from file system, database, or other storage
    // For now, it's a placeholder that could be implemented based on requirements
    this.logger.debug('Loading persisted session data');
  }

  /**
   * Get persistence data for a session
   */
  getPersistenceData(sessionId: string): SessionPersistentData | undefined {
    return this.sessionPersistenceData.get(sessionId);
  }

  /**
   * Get bookmarks for a session
   */
  getBookmarks(sessionId: string): SessionBookmark[] {
    return this.sessionBookmarks.get(sessionId) || [];
  }

  /**
   * Get continuity configuration
   */
  getContinuityConfig(): SessionContinuityConfig {
    return this.continuityConfig;
  }

  /**
   * Delete persistence data for a session
   */
  deleteSessionData(sessionId: string): void {
    this.sessionPersistenceData.delete(sessionId);
    this.sessionBookmarks.delete(sessionId);

    const bookmarkTimer = this.bookmarkTimers.get(sessionId);
    if (bookmarkTimer) {
      clearInterval(bookmarkTimer);
      this.bookmarkTimers.delete(sessionId);
    }
  }

  /**
   * Dispose of all timers and clean up resources
   */
  dispose(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }

    for (const [, timer] of this.bookmarkTimers) {
      clearInterval(timer);
    }
    this.bookmarkTimers.clear();

    this.sessionPersistenceData.clear();
    this.sessionBookmarks.clear();
  }
}
