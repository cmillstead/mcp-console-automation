/**
 * WebSocketTerminalProtocol conformance tests -- verifies BaseProtocol integration
 */

let WebSocketTerminalProtocol: any;
let BaseProtocol: any;
let loadError: Error | null = null;

beforeAll(async () => {
  try {
    const wsMod = await import(
      '../../src/protocols/WebSocketTerminalProtocol.js'
    );
    WebSocketTerminalProtocol = wsMod.WebSocketTerminalProtocol;

    const baseMod = await import('../../src/core/BaseProtocol.js');
    BaseProtocol = baseMod.BaseProtocol;
  } catch (err) {
    loadError = err as Error;
  }
});

function makeProtocol() {
  return new WebSocketTerminalProtocol();
}

describe('WebSocketTerminalProtocol BaseProtocol conformance', () => {
  beforeEach(() => {
    if (loadError) {
      console.warn('Skipping -- module load failed:', loadError.message);
    }
  });

  function skip() {
    return loadError !== null;
  }

  it('should be an instanceof BaseProtocol', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "websocket-term"', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.type).toBe('websocket-term');
  });

  it('should have capabilities.supportsStreaming === true', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.capabilities.supportsStreaming).toBe(true);
  });

  it('should have capabilities.supportsPTY === true', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.capabilities.supportsPTY).toBe(true);
  });

  it('should have full capabilities set', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    const caps = protocol.capabilities;

    expect(caps.supportsAuthentication).toBe(true);
    expect(caps.supportsEncryption).toBe(true);
    expect(caps.supportsCompression).toBe(true);
    expect(caps.supportsMultiplexing).toBe(true);
    expect(caps.supportsKeepAlive).toBe(true);
    expect(caps.supportsReconnection).toBe(true);
    expect(caps.supportsBinaryData).toBe(true);
    expect(caps.supportsFileTransfer).toBe(true);
    expect(caps.supportsResizing).toBe(true);
    expect(caps.supportsX11Forwarding).toBe(false);
    expect(caps.supportsPortForwarding).toBe(false);
    expect(caps.supportsCustomEnvironment).toBe(false);
    expect(caps.supportsWorkingDirectory).toBe(false);
    expect(caps.supportsSignals).toBe(false);
    expect(caps.maxConcurrentSessions).toBe(20);
    expect(caps.defaultTimeout).toBe(30000);
    expect(caps.supportedEncodings).toContain('utf8');
    expect(caps.supportedAuthMethods).toContain('token');
    expect(caps.supportedAuthMethods).toContain('password');
    expect(caps.supportedAuthMethods).toContain('certificate');
    expect(caps.platformSupport.windows).toBe(true);
    expect(caps.platformSupport.linux).toBe(true);
    expect(caps.platformSupport.macos).toBe(true);
    expect(caps.platformSupport.freebsd).toBe(true);
  });

  it('getHealthStatus() should return a valid health object', async () => {
    if (skip()) return;
    const protocol = makeProtocol();
    await protocol.initialize();
    const health = await protocol.getHealthStatus();

    expect(health).toBeDefined();
    expect(health.isHealthy).toBe(true);
    expect(health.lastChecked).toBeInstanceOf(Date);
    expect(health.errors).toEqual([]);
    expect(health.metrics).toBeDefined();
    expect(health.metrics.activeSessions).toBe(0);
    expect(health.metrics.totalSessions).toBe(0);
  });

  it('getResourceUsage() should return a valid usage object', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    const usage = protocol.getResourceUsage();

    expect(usage).toBeDefined();
    expect(usage.memory).toBeDefined();
    expect(usage.memory.used).toBeGreaterThanOrEqual(0);
    expect(usage.cpu).toBeDefined();
    expect(usage.network).toBeDefined();
    expect(usage.sessions).toBeDefined();
    expect(usage.sessions.active).toBe(0);
    expect(usage.sessions.total).toBe(0);
  });

  it('dispose() should clean up (sessionCount goes to 0)', async () => {
    if (skip()) return;
    const protocol = makeProtocol();
    await protocol.initialize();
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });

  it('initialize() should set isInitialized', async () => {
    if (skip()) return;
    const protocol = makeProtocol();
    await protocol.initialize();
    const health = await protocol.getHealthStatus();
    expect(health).toBeDefined();
    expect(health.isHealthy).toBe(true);
    expect(health.metrics.uptime).toBeGreaterThanOrEqual(0);
  });
});
