/**
 * Parameterized BaseProtocol conformance tests for ALL protocol implementations.
 *
 * Validates that every protocol:
 *  1. Module loads successfully
 *  2. Can be instantiated
 *  3. Is an instanceof BaseProtocol
 *  4. Has a non-empty `type` string
 *  5. Has a well-formed `capabilities` object
 *  6. Returns valid health status from getHealthStatus()
 *  7. Returns valid resource usage from getResourceUsage()
 *  8. Reports sessionCount correctly
 *
 * Note: These tests verify the structural BaseProtocol contract WITHOUT calling
 * initialize()/dispose(), since many protocols check for real tools/services
 * during initialization. Integration tests should cover the full lifecycle.
 */

import { BaseProtocol } from '../../src/core/BaseProtocol.js';

// --- Protocol factory registry ---
// Each entry: [displayName, modulePath, className, factoryArgs]

interface ProtocolEntry {
  name: string;
  modulePath: string;
  className: string;
  args: () => any[];
  /** Constructor requires external dependencies not available in test env */
  requiresExternalDeps?: boolean;
}

const PROTOCOLS: ProtocolEntry[] = [
  // Remote Access
  { name: 'SSHProtocol', modulePath: '../../src/protocols/SSHProtocol.js', className: 'SSHProtocol', args: () => [] },
  { name: 'TelnetProtocol', modulePath: '../../src/protocols/TelnetProtocol.js', className: 'TelnetProtocol', args: () => [] },
  { name: 'SFTPProtocol', modulePath: '../../src/protocols/SFTPProtocol.js', className: 'SFTPProtocol', args: () => [{ host: 'localhost', username: 'test' }] },

  // Container & Orchestration
  { name: 'DockerProtocol', modulePath: '../../src/protocols/DockerProtocol.js', className: 'DockerProtocol', args: () => [{
    connection: {}, containerDefaults: {}, execDefaults: {},
    healthCheck: { enabled: false, interval: 30000, timeout: 5000, retries: 3, startPeriod: 0 },
    autoCleanup: true,
    logStreaming: { enabled: false, bufferSize: 1024, maxLines: 100, timestamps: false },
    networking: { createNetworks: false, allowPrivileged: false },
    security: { allowPrivileged: false, allowHostNetwork: false, allowHostPid: false, restrictedCapabilities: [] },
    performance: { connectionPoolSize: 5, requestTimeout: 30000, keepAliveTimeout: 60000, maxConcurrentOperations: 5 },
    monitoring: { enableMetrics: false, enableTracing: false, enableHealthChecks: false, alertOnFailures: false },
  }] },
  { name: 'KubernetesProtocol', modulePath: '../../src/protocols/KubernetesProtocol.js', className: 'KubernetesProtocol', args: () => [{ connectionOptions: {} }], requiresExternalDeps: true },
  { name: 'PodmanProtocol', modulePath: '../../src/protocols/PodmanProtocol.js', className: 'PodmanProtocol', args: () => [] },
  { name: 'ContainerdProtocol', modulePath: '../../src/protocols/ContainerdProtocol.js', className: 'ContainerdProtocol', args: () => [] },
  { name: 'LXCProtocol', modulePath: '../../src/protocols/LXCProtocol.js', className: 'LXCProtocol', args: () => [] },

  // Cloud
  { name: 'AzureProtocol', modulePath: '../../src/protocols/AzureProtocol.js', className: 'AzureProtocol', args: () => [] },
  { name: 'GCPProtocol', modulePath: '../../src/protocols/GCPProtocol.js', className: 'GCPProtocol', args: () => [] },
  { name: 'AWSSSMProtocol', modulePath: '../../src/protocols/AWSSSMProtocol.js', className: 'AWSSSMProtocol', args: () => [{ region: 'us-east-1' }], requiresExternalDeps: true },

  // Virtualization
  { name: 'WSLProtocol', modulePath: '../../src/protocols/WSLProtocol.js', className: 'WSLProtocol', args: () => [] },
  { name: 'HyperVProtocol', modulePath: '../../src/protocols/HyperVProtocol.js', className: 'HyperVProtocol', args: () => [] },
  { name: 'VMwareProtocol', modulePath: '../../src/protocols/VMwareProtocol.js', className: 'VMwareProtocol', args: () => [] },
  { name: 'VirtualBoxProtocol', modulePath: '../../src/protocols/VirtualBoxProtocol.js', className: 'VirtualBoxProtocol', args: () => [] },
  { name: 'QEMUProtocol', modulePath: '../../src/protocols/QEMUProtocol.js', className: 'QEMUProtocol', args: () => [] },
  { name: 'XenProtocol', modulePath: '../../src/protocols/XenProtocol.js', className: 'XenProtocol', args: () => [] },

  // Hardware
  { name: 'SerialProtocol', modulePath: '../../src/protocols/SerialProtocol.js', className: 'SerialProtocol', args: () => [] },
  { name: 'IPMIProtocol', modulePath: '../../src/protocols/IPMIProtocol.js', className: 'IPMIProtocol', args: () => [] },
  { name: 'BMCProtocol', modulePath: '../../src/protocols/BMCProtocol.js', className: 'BMCProtocol', args: () => [] },
  { name: 'iDRACProtocol', modulePath: '../../src/protocols/iDRACProtocol.js', className: 'iDRACProtocol', args: () => [] },
  { name: 'ILOProtocol', modulePath: '../../src/protocols/ILOProtocol.js', className: 'ILOProtocol', args: () => [] },
  { name: 'JTAGProtocol', modulePath: '../../src/protocols/JTAGProtocol.js', className: 'JTAGProtocol', args: () => [] },

  // Remote Desktop
  { name: 'RDPProtocol', modulePath: '../../src/protocols/RDPProtocol.js', className: 'RDPProtocol', args: () => [] },
  { name: 'VNCProtocol', modulePath: '../../src/protocols/VNCProtocol.js', className: 'VNCProtocol', args: () => [] },
  { name: 'SPICEProtocol', modulePath: '../../src/protocols/SPICEProtocol.js', className: 'SPICEProtocol', args: () => [] },
  { name: 'X11VNCProtocol', modulePath: '../../src/protocols/X11VNCProtocol.js', className: 'X11VNCProtocol', args: () => [] },

  // Network Terminal
  { name: 'WebSocketTerminalProtocol', modulePath: '../../src/protocols/WebSocketTerminalProtocol.js', className: 'WebSocketTerminalProtocol', args: () => [] },
  { name: 'GoTTYProtocol', modulePath: '../../src/protocols/GoTTYProtocol.js', className: 'GoTTYProtocol', args: () => [] },
  { name: 'WeTTYProtocol', modulePath: '../../src/protocols/WeTTYProtocol.js', className: 'WeTTYProtocol', args: () => [] },
  { name: 'TTYDProtocol', modulePath: '../../src/protocols/TTYDProtocol.js', className: 'TTYDProtocol', args: () => [] },
  { name: 'GuacamoleProtocol', modulePath: '../../src/protocols/GuacamoleProtocol.js', className: 'GuacamoleProtocol', args: () => [] },

  // Windows Remote Management
  { name: 'WinRMProtocol', modulePath: '../../src/protocols/WinRMProtocol.js', className: 'WinRMProtocol', args: () => [] },
  { name: 'PSRemotingProtocol', modulePath: '../../src/protocols/PSRemotingProtocol.js', className: 'PSRemotingProtocol', args: () => [] },
  { name: 'WMIProtocol', modulePath: '../../src/protocols/WMIProtocol.js', className: 'WMIProtocol', args: () => [] },
  { name: 'PSExecProtocol', modulePath: '../../src/protocols/PSExecProtocol.js', className: 'PSExecProtocol', args: () => [] },
  { name: 'PowerShellDirectProtocol', modulePath: '../../src/protocols/PowerShellDirectProtocol.js', className: 'PowerShellDirectProtocol', args: () => [] },

  // IPC & Local Communication
  { name: 'NamedPipeProtocol', modulePath: '../../src/protocols/NamedPipeProtocol.js', className: 'NamedPipeProtocol', args: () => [] },
  { name: 'UnixSocketProtocol', modulePath: '../../src/protocols/UnixSocketProtocol.js', className: 'UnixSocketProtocol', args: () => [] },
  { name: 'IPCProtocol', modulePath: '../../src/protocols/IPCProtocol.js', className: 'IPCProtocol', args: () => [{ path: '/tmp/test.sock' }] },
  { name: 'DBusProtocol', modulePath: '../../src/protocols/DBusProtocol.js', className: 'DBusProtocol', args: () => [] },
  { name: 'MessageQueueProtocol', modulePath: '../../src/protocols/MessageQueueProtocol.js', className: 'MessageQueueProtocol', args: () => [] },

  // Automation & Configuration Management
  { name: 'AnsibleProtocol', modulePath: '../../src/protocols/AnsibleProtocol.js', className: 'AnsibleProtocol', args: () => [] },
  { name: 'PuppetProtocol', modulePath: '../../src/protocols/PuppetProtocol.js', className: 'PuppetProtocol', args: () => [] },
  { name: 'ChefProtocol', modulePath: '../../src/protocols/ChefProtocol.js', className: 'ChefProtocol', args: () => [] },
  { name: 'SaltStackProtocol', modulePath: '../../src/protocols/SaltStackProtocol.js', className: 'SaltStackProtocol', args: () => [] },
  { name: 'TerraformProtocol', modulePath: '../../src/protocols/TerraformProtocol.js', className: 'TerraformProtocol', args: () => [] },
  { name: 'VagrantProtocol', modulePath: '../../src/protocols/VagrantProtocol.js', className: 'VagrantProtocol', args: () => [] },

  // Database
  { name: 'MySQLProtocol', modulePath: '../../src/protocols/MySQLProtocol.js', className: 'MySQLProtocol', args: () => [] },
  { name: 'PostgreSQLProtocol', modulePath: '../../src/protocols/PostgreSQLProtocol.js', className: 'PostgreSQLProtocol', args: () => [] },
  { name: 'SQLiteProtocol', modulePath: '../../src/protocols/SQLiteProtocol.js', className: 'SQLiteProtocol', args: () => [] },
  { name: 'MongoDBProtocol', modulePath: '../../src/protocols/MongoDBProtocol.js', className: 'MongoDBProtocol', args: () => [] },
  { name: 'RedisProtocol', modulePath: '../../src/protocols/RedisProtocol.js', className: 'RedisProtocol', args: () => [] },
  { name: 'CassandraProtocol', modulePath: '../../src/protocols/CassandraProtocol.js', className: 'CassandraProtocol', args: () => [] },

  // Application Runtime
  { name: 'JavaProtocol', modulePath: '../../src/protocols/JavaProtocol.js', className: 'JavaProtocol', args: () => [] },
  { name: 'PythonProtocol', modulePath: '../../src/protocols/PythonProtocol.js', className: 'PythonProtocol', args: () => [] },
  { name: 'NodeProtocol', modulePath: '../../src/protocols/NodeProtocol.js', className: 'NodeProtocol', args: () => [] },
  { name: 'RubyProtocol', modulePath: '../../src/protocols/RubyProtocol.js', className: 'RubyProtocol', args: () => [] },
  { name: 'DotNetProtocol', modulePath: '../../src/protocols/DotNetProtocol.js', className: 'DotNetProtocol', args: () => [] },
  { name: 'PHPProtocol', modulePath: '../../src/protocols/PHPProtocol.js', className: 'PHPProtocol', args: () => [] },
  { name: 'GoLangProtocol', modulePath: '../../src/protocols/GoLangProtocol.js', className: 'GoLangProtocol', args: () => [] },
  { name: 'RustProtocol', modulePath: '../../src/protocols/RustProtocol.js', className: 'RustProtocol', args: () => [] },

  // Local Shell (special — requires ConsoleType arg)
  { name: 'LocalProtocol', modulePath: '../../src/protocols/LocalProtocol.js', className: 'LocalProtocol', args: () => ['bash'] },
];

// --- Loaded protocol classes (populated in beforeAll) ---
const loaded: Map<string, { ProtocolClass: any; loadError: Error | null }> = new Map();

beforeAll(async () => {
  const imports = PROTOCOLS.map(async (entry) => {
    try {
      const mod = await import(entry.modulePath);
      loaded.set(entry.name, { ProtocolClass: mod[entry.className], loadError: null });
    } catch (err) {
      loaded.set(entry.name, { ProtocolClass: null, loadError: err as Error });
    }
  });
  await Promise.all(imports);
});

// Required capability keys
const CAPABILITY_BOOLEAN_KEYS = [
  'supportsStreaming', 'supportsFileTransfer', 'supportsEncryption',
  'supportsCompression', 'supportsKeepAlive', 'supportsReconnection',
  'supportsBinaryData', 'supportsAuthentication', 'supportsMultiplexing', 'supportsPTY',
] as const;

const CAPABILITY_PLATFORM_KEYS = ['windows', 'linux', 'macos', 'freebsd'] as const;

// --- Parameterized tests ---
describe.each(PROTOCOLS.map(p => [p.name, p]))('%s BaseProtocol conformance', (_name, entry) => {
  const { name, args, requiresExternalDeps } = entry as ProtocolEntry;

  function getClass() {
    const info = loaded.get(name);
    if (!info || info.loadError) return null;
    return info.ProtocolClass;
  }

  function makeInstance() {
    const Cls = getClass();
    if (!Cls) return null;
    try {
      return new Cls(...args());
    } catch {
      return null;
    }
  }

  it('module loads successfully', () => {
    const info = loaded.get(name);
    expect(info?.loadError).toBeNull();
    expect(info?.ProtocolClass).toBeDefined();
  });

  it('can be instantiated', () => {
    if (requiresExternalDeps) return; // k8s mock / AWS SDK incomplete in test env
    const instance = makeInstance();
    expect(instance).not.toBeNull();
  });

  it('is an instanceof BaseProtocol', () => {
    const instance = makeInstance();
    if (!instance) return;
    expect(instance).toBeInstanceOf(BaseProtocol);
  });

  it('has a non-empty type string', () => {
    const instance = makeInstance();
    if (!instance) return;
    expect(typeof instance.type).toBe('string');
    expect(instance.type.length).toBeGreaterThan(0);
  });

  it('has well-formed capabilities object', () => {
    const instance = makeInstance();
    if (!instance) return;
    const caps = instance.capabilities;
    expect(caps).toBeDefined();

    for (const key of CAPABILITY_BOOLEAN_KEYS) {
      expect(typeof caps[key]).toBe('boolean');
    }

    expect(typeof caps.maxConcurrentSessions).toBe('number');
    expect(caps.maxConcurrentSessions).toBeGreaterThan(0);
    expect(typeof caps.defaultTimeout).toBe('number');
    expect(caps.defaultTimeout).toBeGreaterThan(0);

    expect(Array.isArray(caps.supportedEncodings)).toBe(true);
    expect(caps.supportedEncodings.length).toBeGreaterThan(0);
    expect(Array.isArray(caps.supportedAuthMethods)).toBe(true);

    expect(caps.platformSupport).toBeDefined();
    for (const key of CAPABILITY_PLATFORM_KEYS) {
      expect(typeof caps.platformSupport[key]).toBe('boolean');
    }
  });

  it('getHealthStatus() returns valid health object (without initialize)', async () => {
    const instance = makeInstance();
    if (!instance) return;

    const health = await instance.getHealthStatus();
    expect(health).toHaveProperty('isHealthy');
    expect(health).toHaveProperty('lastChecked');
    expect(health).toHaveProperty('errors');
    expect(health).toHaveProperty('warnings');
    expect(health).toHaveProperty('metrics');
    expect(health.metrics).toHaveProperty('activeSessions');
    expect(health.metrics).toHaveProperty('totalSessions');
    expect(typeof health.isHealthy).toBe('boolean');
  });

  it('getResourceUsage() returns valid usage object', () => {
    const instance = makeInstance();
    if (!instance) return;
    const usage = instance.getResourceUsage();

    expect(usage).toHaveProperty('memory');
    expect(usage).toHaveProperty('cpu');
    expect(usage).toHaveProperty('network');
    expect(usage).toHaveProperty('storage');
    expect(usage).toHaveProperty('sessions');
    expect(usage.sessions.active).toBe(0);
    expect(usage.sessions.total).toBe(0);
  });

  it('getSessionCount() returns 0 on fresh instance', () => {
    const instance = makeInstance();
    if (!instance) return;
    expect(instance.getSessionCount()).toBe(0);
  });
});
