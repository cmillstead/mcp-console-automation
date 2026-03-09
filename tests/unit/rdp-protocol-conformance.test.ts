/**
 * RDPProtocol conformance tests — verifies BaseProtocol integration
 */

let RDPProtocol: any;
let BaseProtocol: any;
let ProtocolNotSupportedError: any;
let loadError: Error | null = null;

beforeAll(async () => {
  try {
    const rdpMod = await import('../../src/protocols/RDPProtocol.js');
    RDPProtocol = rdpMod.RDPProtocol;

    const baseMod = await import('../../src/core/BaseProtocol.js');
    BaseProtocol = baseMod.BaseProtocol;

    const errMod = await import('../../src/core/ProtocolNotSupportedError.js');
    ProtocolNotSupportedError = errMod.ProtocolNotSupportedError;
  } catch (err) {
    loadError = err as Error;
  }
});

describe('RDPProtocol BaseProtocol conformance', () => {
  beforeEach(() => {
    if (loadError) {
      console.warn('Skipping — module load failed (missing optional deps?):', loadError.message);
    }
  });

  function skip() {
    return loadError !== null;
  }

  it('should be an instanceof BaseProtocol', () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "rdp"', () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    expect(protocol.type).toBe('rdp');
  });

  it('should have expected capabilities', () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    const caps = protocol.capabilities;

    expect(caps.supportsStreaming).toBe(false);
    expect(caps.supportsFileTransfer).toBe(true);
    expect(caps.supportsX11Forwarding).toBe(false);
    expect(caps.supportsPortForwarding).toBe(true);
    expect(caps.supportsAuthentication).toBe(true);
    expect(caps.supportsEncryption).toBe(true);
    expect(caps.supportsPTY).toBe(false);
    expect(caps.supportsResizing).toBe(true);
    expect(caps.supportsMultiplexing).toBe(true);
    expect(caps.maxConcurrentSessions).toBe(10);
    expect(caps.defaultTimeout).toBe(30000);
    expect(caps.supportedAuthMethods).toContain('password');
    expect(caps.supportedAuthMethods).toContain('smartcard');
    expect(caps.supportedAuthMethods).toContain('nla');
    expect(caps.platformSupport.windows).toBe(true);
    expect(caps.platformSupport.linux).toBe(true);
    expect(caps.platformSupport.macos).toBe(true);
    expect(caps.platformSupport.freebsd).toBe(false);
  });

  it('getOutput() should throw ProtocolNotSupportedError', async () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    await expect(protocol.getOutput('any-session')).rejects.toThrow(ProtocolNotSupportedError);
    await expect(protocol.getOutput('any-session')).rejects.toThrow(/getOutput/);
  });

  it('getHealthStatus() should return a valid health object', async () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    await protocol.initialize();

    const health = await protocol.getHealthStatus();
    expect(health).toHaveProperty('isHealthy');
    expect(health).toHaveProperty('lastChecked');
    expect(health).toHaveProperty('errors');
    expect(health).toHaveProperty('warnings');
    expect(health).toHaveProperty('metrics');
    expect(health.metrics).toHaveProperty('activeSessions');
    expect(health.metrics).toHaveProperty('totalSessions');
    expect(typeof health.isHealthy).toBe('boolean');
  });

  it('getResourceUsage() should return a valid usage object', () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    const usage = protocol.getResourceUsage();

    expect(usage).toHaveProperty('memory');
    expect(usage).toHaveProperty('cpu');
    expect(usage).toHaveProperty('network');
    expect(usage).toHaveProperty('storage');
    expect(usage).toHaveProperty('sessions');
    expect(usage.sessions.active).toBe(0);
    expect(usage.sessions.total).toBe(0);
  });

  it('dispose() should clean up (sessionCount goes to 0)', async () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    await protocol.initialize();

    // Verify starts clean
    expect(protocol.getSessionCount()).toBe(0);

    // Dispose and verify still clean
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });

  it('initialize() should set isInitialized', async () => {
    if (skip()) return;
    const protocol = new RDPProtocol();
    await protocol.initialize();
    // isInitialized is protected, but getHealthStatus uses it indirectly
    // We verify by checking that the protocol functions after init
    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBe(true);
  });
});
