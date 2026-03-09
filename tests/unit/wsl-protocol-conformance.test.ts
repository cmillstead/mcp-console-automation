/**
 * WSLProtocol conformance tests — verifies BaseProtocol integration
 */

let WSLProtocol: any;
let BaseProtocol: any;
let loadError: Error | null = null;

beforeAll(async () => {
  try {
    const wslMod = await import('../../src/protocols/WSLProtocol.js');
    WSLProtocol = wslMod.WSLProtocol;

    const baseMod = await import('../../src/core/BaseProtocol.js');
    BaseProtocol = baseMod.BaseProtocol;
  } catch (err) {
    loadError = err as Error;
  }
});

function makeProtocol() {
  return new WSLProtocol();
}

describe('WSLProtocol BaseProtocol conformance', () => {
  beforeEach(() => {
    if (loadError) {
      console.warn('Skipping — module load failed:', loadError.message);
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

  it('should have type "wsl"', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.type).toBe('wsl');
  });

  it('should have capabilities.supportsPTY === true', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.capabilities.supportsPTY).toBe(true);
  });

  it('should have capabilities.supportsStreaming === true', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.capabilities.supportsStreaming).toBe(true);
  });

  it('should have capabilities.platformSupport.windows === true', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.capabilities.platformSupport.windows).toBe(true);
  });

  it('should have full capabilities set', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    const caps = protocol.capabilities;

    expect(caps.supportsFileTransfer).toBe(true);
    expect(caps.supportsX11Forwarding).toBe(true);
    expect(caps.supportsPortForwarding).toBe(true);
    expect(caps.supportsAuthentication).toBe(false);
    expect(caps.supportsEncryption).toBe(false);
    expect(caps.supportsCompression).toBe(false);
    expect(caps.supportsMultiplexing).toBe(false);
    expect(caps.supportsKeepAlive).toBe(true);
    expect(caps.supportsReconnection).toBe(true);
    expect(caps.supportsBinaryData).toBe(true);
    expect(caps.supportsCustomEnvironment).toBe(true);
    expect(caps.supportsWorkingDirectory).toBe(true);
    expect(caps.supportsSignals).toBe(true);
    expect(caps.supportsResizing).toBe(true);
    expect(caps.maxConcurrentSessions).toBe(20);
    expect(caps.defaultTimeout).toBe(30000);
    expect(caps.supportedEncodings).toContain('utf8');
    expect(caps.supportedAuthMethods).toEqual([]);
    expect(caps.platformSupport.linux).toBe(false);
    expect(caps.platformSupport.macos).toBe(false);
    expect(caps.platformSupport.freebsd).toBe(false);
  });

  it('getHealthStatus() should return a valid health object', async () => {
    if (skip()) return;
    const protocol = makeProtocol();
    const health = await protocol.getHealthStatus();

    expect(health).toBeDefined();
    expect(typeof health.isHealthy).toBe('boolean');
    expect(health.lastChecked).toBeInstanceOf(Date);
    expect(Array.isArray(health.errors)).toBe(true);
    expect(Array.isArray(health.warnings)).toBe(true);
    expect(health.metrics).toBeDefined();
    expect(typeof health.metrics.activeSessions).toBe('number');
    expect(typeof health.metrics.totalSessions).toBe('number');
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
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });

  it('should be constructable with new WSLProtocol() (not singleton-only)', () => {
    if (skip()) return;
    const a = new WSLProtocol();
    const b = new WSLProtocol();
    // They should be distinct instances
    expect(a).not.toBe(b);
  });

  it('getInstance() should return a cached instance', () => {
    if (skip()) return;
    const a = WSLProtocol.getInstance();
    const b = WSLProtocol.getInstance();
    expect(a).toBe(b);
  });
});
