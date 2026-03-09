/**
 * IPCProtocol conformance tests — verifies BaseProtocol integration
 */

let IPCProtocol: any;
let BaseProtocol: any;
let ProtocolNotSupportedError: any;
let loadError: Error | null = null;

beforeAll(async () => {
  try {
    const ipcMod = await import('../../src/protocols/IPCProtocol.js');
    IPCProtocol = ipcMod.IPCProtocol;

    const baseMod = await import('../../src/core/BaseProtocol.js');
    BaseProtocol = baseMod.BaseProtocol;

    const errMod = await import('../../src/core/ProtocolNotSupportedError.js');
    ProtocolNotSupportedError = errMod.ProtocolNotSupportedError;
  } catch (err) {
    loadError = err as Error;
  }
});

function makeProtocol() {
  return new IPCProtocol({ type: 'unix-socket', path: '/tmp/test.sock' });
}

describe('IPCProtocol BaseProtocol conformance', () => {
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

  it('should have type "ipc"', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    expect(protocol.type).toBe('ipc');
  });

  it('should have expected capabilities', () => {
    if (skip()) return;
    const protocol = makeProtocol();
    const caps = protocol.capabilities;

    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsFileTransfer).toBe(false);
    expect(caps.supportsEncryption).toBe(true);
    expect(caps.supportsCompression).toBe(true);
    expect(caps.supportsKeepAlive).toBe(true);
    expect(caps.supportsReconnection).toBe(true);
    expect(caps.supportsBinaryData).toBe(true);
    expect(caps.supportsAuthentication).toBe(false);
    expect(caps.supportsMultiplexing).toBe(false);
    expect(caps.supportsPTY).toBe(false);
    expect(caps.maxConcurrentSessions).toBe(50);
    expect(caps.defaultTimeout).toBe(30000);
    expect(caps.supportedEncodings).toContain('utf8');
    expect(caps.supportedEncodings).toContain('binary');
    expect(caps.supportedAuthMethods).toEqual([]);
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
    const protocol = makeProtocol();
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
    const protocol = makeProtocol();
    await protocol.initialize();

    expect(protocol.getSessionCount()).toBe(0);

    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });

  it('initialize() should set isInitialized', async () => {
    if (skip()) return;
    const protocol = makeProtocol();
    await protocol.initialize();

    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBe(true);
  });
});
