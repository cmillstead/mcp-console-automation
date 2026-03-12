import { IPMISessionManager } from '../../src/core/IPMISessionManager';
import { ProtocolSessionHost } from '../../src/core/ProtocolSessionManagerBase';
import { Logger } from '../../src/utils/logger';
import { EventEmitter } from 'events';

// A mock IPMI session object (returned by protocol.createSession)
function createMockIPMISession() {
  return new EventEmitter() as EventEmitter & { sessionId: string };
}

function createMockProtocol(ipmiSession?: any) {
  const session = ipmiSession ?? createMockIPMISession();
  return {
    type: 'ipmi' as const,
    capabilities: { supportsStreaming: true },
    createSession: jest.fn().mockResolvedValue(session),
    sendInput: jest.fn().mockResolvedValue(undefined),
    executeCommand: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
    _mockSession: session,
  };
}

function createMockHost(mockProtocol: any): ProtocolSessionHost {
  const mockFactory = {
    createProtocol: jest.fn().mockResolvedValue(mockProtocol),
  };
  return {
    getSession: jest.fn().mockReturnValue({ id: 'test', status: 'starting' }),
    setSession: jest.fn(),
    deleteSession: jest.fn(),
    getOutputBuffer: jest.fn().mockReturnValue([]),
    setOutputBuffer: jest.fn(),
    getMaxBufferSize: jest.fn().mockReturnValue(10000),
    createStreamManager: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    setStreamManager: jest.fn(),
    getStreamManager: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    deleteStreamManager: jest.fn(),
    updateSessionStatus: jest.fn().mockResolvedValue(undefined),
    registerSessionWithHealthMonitoring: jest.fn().mockResolvedValue(undefined),
    emitEvent: jest.fn(),
    emitTypedEvent: jest.fn(),
    getProtocolFactory: jest.fn().mockReturnValue(mockFactory),
    getOrCreateProtocol: jest.fn().mockResolvedValue(mockProtocol),
    getErrorDetector: jest.fn().mockReturnValue({ processOutput: jest.fn() }),
    addErrorPatterns: jest.fn(),
    getPromptDetector: jest.fn().mockReturnValue(null),
    getPaginationManager: jest.fn().mockReturnValue({ removeSession: jest.fn() }),
    isSelfHealingEnabled: jest.fn().mockReturnValue(false),
    getNextSequenceNumber: jest.fn().mockReturnValue(1),
    getLogger: jest.fn().mockReturnValue(new Logger('test')),
  };
}

function createMockLogger(): Logger {
  const logger = new Logger('test');
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  return logger;
}

function makeIPMIOptions(overrides?: Partial<any>) {
  return {
    host: '192.168.1.100',
    port: 623,
    username: 'admin',
    password: 'password',
    ipmiVersion: '2.0' as const,
    privilegeLevel: 'admin' as const,
    cipherSuite: 3,
    interface: 'lanplus',
    ...overrides,
  };
}

// Helper: seed a session into ipmiSessions by triggering a real createSession then
// accessing the private map via a workaround. Since the map is private, we'll
// create an IPMISessionState by directly calling createSession (which internally
// does NOT add to ipmiSessions — that's done externally by ConsoleManager).
// So for methods that guard on ipmiSessions, we need to inject state another way.
// We expose the map via a test subclass.
class TestIPMISessionManager extends IPMISessionManager {
  // Expose private maps for test seeding
  seedIPMISession(sessionId: string, state: any): void {
    (this as any).ipmiSessions.set(sessionId, state);
  }

  seedIPMIProtocol(sessionId: string, protocol: any): void {
    (this as any).ipmiProtocols.set(sessionId, protocol);
  }
}

const MOCK_IPMI_STATE = {
  sessionId: 'ipmi-1',
  connectionState: 'connected' as const,
  ipmiVersion: '2.0' as const,
  cipherSuite: 3,
  authType: 0,
  privilegeLevel: 'admin' as const,
};

describe('IPMISessionManager', () => {
  let manager: TestIPMISessionManager;
  let host: ProtocolSessionHost;
  let mockProtocol: ReturnType<typeof createMockProtocol>;
  let logger: Logger;

  beforeEach(() => {
    mockProtocol = createMockProtocol();
    host = createMockHost(mockProtocol);
    logger = createMockLogger();
    manager = new TestIPMISessionManager(host, logger);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await manager.destroy();
  });

  // ── constructor ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create an instance of IPMISessionManager', () => {
      expect(manager).toBeInstanceOf(IPMISessionManager);
    });

    it('should start with zero sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  // ── createSession ───────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('should throw when ipmiOptions is missing', async () => {
      const session = { id: 'ipmi-no', status: 'starting' } as any;
      await expect(
        manager.createSession('ipmi-no', session, {} as any)
      ).rejects.toThrow('IPMI options are required for IPMI session');
    });

    it('should create a protocol instance per session', async () => {
      const session = { id: 'ipmi-1', status: 'starting' } as any;
      const options = { ipmiOptions: makeIPMIOptions() } as any;

      await manager.createSession('ipmi-1', session, options);

      expect(host.getProtocolFactory).toHaveBeenCalled();
      expect(
        (host.getProtocolFactory() as any).createProtocol
      ).toHaveBeenCalledWith('ipmi');
    });

    it('should set up event handlers on ipmiSession (not protocol)', async () => {
      const ipmiSession = createMockIPMISession();
      jest.spyOn(ipmiSession, 'on');
      const proto = createMockProtocol(ipmiSession);
      const localHost = createMockHost(proto);
      const localManager = new TestIPMISessionManager(localHost, logger);

      const session = { id: 'ipmi-evt', status: 'starting' } as any;
      await localManager.createSession(
        'ipmi-evt',
        session,
        { ipmiOptions: makeIPMIOptions() } as any
      );

      expect(ipmiSession.on).toHaveBeenCalledWith('output', expect.any(Function));
      expect(ipmiSession.on).toHaveBeenCalledWith('sol-data', expect.any(Function));
      expect(ipmiSession.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(ipmiSession.on).toHaveBeenCalledWith('close', expect.any(Function));
      await localManager.destroy();
    });

    it('should update session status via host', async () => {
      const session = { id: 'ipmi-2', status: 'starting' } as any;
      const options = { ipmiOptions: makeIPMIOptions() } as any;

      await manager.createSession('ipmi-2', session, options);

      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'ipmi-2',
        'running',
        expect.objectContaining({ host: '192.168.1.100' })
      );
      expect(session.status).toBe('running');
    });

    it('should start monitoring when options.monitoring.enableMetrics is true', async () => {
      jest.useFakeTimers();
      const session = { id: 'ipmi-mon', status: 'starting' } as any;
      const options = {
        ipmiOptions: makeIPMIOptions(),
        monitoring: { enableMetrics: true },
      } as any;

      await manager.createSession('ipmi-mon', session, options);

      // Two intervals should have been set
      expect((manager as any).ipmiMonitoringIntervals.has('ipmi-mon')).toBe(true);
      expect(
        (manager as any).ipmiMonitoringIntervals.get('ipmi-mon')
      ).toHaveLength(2);
    });

    it('should mark session as crashed and rethrow on failure', async () => {
      mockProtocol.createSession.mockRejectedValue(new Error('IPMI unreachable'));
      const session = { id: 'ipmi-fail', status: 'starting' } as any;
      const options = { ipmiOptions: makeIPMIOptions() } as any;

      await expect(
        manager.createSession('ipmi-fail', session, options)
      ).rejects.toThrow('IPMI unreachable');

      expect(session.status).toBe('crashed');
      expect(host.updateSessionStatus).toHaveBeenCalledWith(
        'ipmi-fail',
        'failed',
        expect.objectContaining({ error: 'IPMI unreachable' })
      );
    });
  });

  // ── setupIPMIEventHandlers ───────────────────────────────────────────────────

  describe('setupIPMIEventHandlers (via createSession)', () => {
    let ipmiSession: EventEmitter;

    beforeEach(async () => {
      ipmiSession = createMockIPMISession();
      const proto = createMockProtocol(ipmiSession);
      const localHost = createMockHost(proto);
      const localManager = new TestIPMISessionManager(localHost, logger);
      await localManager.createSession(
        'ipmi-h',
        { id: 'ipmi-h', status: 'starting' } as any,
        { ipmiOptions: makeIPMIOptions() } as any
      );
      // Replace manager/host with the local ones for event assertions
      (manager as any) = localManager;
      host = localHost;
    });

    it('should emit output on output event', () => {
      ipmiSession.emit('output', { type: 'stdout', data: 'hello' });
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({ sessionId: 'ipmi-h', type: 'stdout', data: 'hello' })
      );
    });

    it('should emit output on sol-data event (buffer to string)', () => {
      const buf = Buffer.from('sol-console-data');
      ipmiSession.emit('sol-data', buf);
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'output',
        expect.objectContaining({ sessionId: 'ipmi-h', type: 'stdout', data: 'sol-console-data' })
      );
    });

    it('should emit sensor-data on sensor-data event', () => {
      const sensorData = { temp: 42 };
      ipmiSession.emit('sensor-data', sensorData);
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'sensor-data',
        expect.objectContaining({ sessionId: 'ipmi-h', sensorData })
      );
    });

    it('should emit power-state-change on power-state-change event', () => {
      ipmiSession.emit('power-state-change', 'on');
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'power-state-change',
        expect.objectContaining({ sessionId: 'ipmi-h', powerState: 'on' })
      );
    });

    it('should emit ipmi-event on ipmi-event event', () => {
      const event = { code: 0x01 };
      ipmiSession.emit('ipmi-event', event);
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'ipmi-event',
        expect.objectContaining({ sessionId: 'ipmi-h', event })
      );
    });

    it('should emit sessionError on error event', () => {
      const err = new Error('sensor failure');
      ipmiSession.emit('error', err);
      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'sessionError',
        expect.objectContaining({ sessionId: 'ipmi-h', error: 'sensor failure' })
      );
    });

    it('should trigger handleIPMISessionClosed on close event', async () => {
      ipmiSession.emit('close');
      // Give the async handler a tick to settle
      await new Promise((r) => setTimeout(r, 0));
      expect(host.emitTypedEvent).toHaveBeenCalledWith('sessionClosed', 'ipmi-h');
    });
  });

  // ── startIPMIMonitoring ─────────────────────────────────────────────────────

  describe('startIPMIMonitoring', () => {
    it('should create two intervals for sensor and event polling', async () => {
      jest.useFakeTimers();
      const session = { id: 'ipmi-m', status: 'starting' } as any;
      await manager.createSession(
        'ipmi-m',
        session,
        { ipmiOptions: makeIPMIOptions(), monitoring: { enableMetrics: true } } as any
      );

      const intervals = (manager as any).ipmiMonitoringIntervals.get('ipmi-m');
      expect(intervals).toHaveLength(2);
    });

    it('should poll sensors every 30 seconds', async () => {
      jest.useFakeTimers();
      // Seed a session state so readIPMISensors guard passes
      manager.seedIPMISession('ipmi-sp', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-sp', mockProtocol);

      const session = { id: 'ipmi-sp', status: 'starting' } as any;
      await manager.createSession(
        'ipmi-sp',
        session,
        { ipmiOptions: makeIPMIOptions(), monitoring: { enableMetrics: true } } as any
      );

      mockProtocol.executeCommand.mockClear();
      jest.advanceTimersByTime(30000);
      await Promise.resolve(); // flush microtasks

      // The sensor interval calls readIPMISensors → executeCommand with 'sensor'
      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-sp',
        'sensor',
        ['reading', 'all']
      );
    });

    it('should poll event log every 60 seconds', async () => {
      jest.useFakeTimers();
      manager.seedIPMISession('ipmi-ep', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-ep', mockProtocol);

      const session = { id: 'ipmi-ep', status: 'starting' } as any;
      await manager.createSession(
        'ipmi-ep',
        session,
        { ipmiOptions: makeIPMIOptions(), monitoring: { enableMetrics: true } } as any
      );

      mockProtocol.executeCommand.mockClear();
      jest.advanceTimersByTime(60000);
      await Promise.resolve();

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-ep',
        'sel',
        ['list']
      );
    });

    it('should clean up intervals on destroy', async () => {
      jest.useFakeTimers();
      const session = { id: 'ipmi-cd', status: 'starting' } as any;
      await manager.createSession(
        'ipmi-cd',
        session,
        { ipmiOptions: makeIPMIOptions(), monitoring: { enableMetrics: true } } as any
      );

      expect((manager as any).ipmiMonitoringIntervals.size).toBe(1);
      await manager.destroy();
      expect((manager as any).ipmiMonitoringIntervals.size).toBe(0);
    });
  });

  // ── handleIPMISessionClosed ─────────────────────────────────────────────────

  describe('handleIPMISessionClosed', () => {
    it('should clear array of monitoring intervals', async () => {
      const t1 = setInterval(() => {}, 99999);
      const t2 = setInterval(() => {}, 99999);
      (manager as any).ipmiMonitoringIntervals.set('ipmi-c', [t1, t2]);

      await (manager as any).handleIPMISessionClosed('ipmi-c');

      expect((manager as any).ipmiMonitoringIntervals.has('ipmi-c')).toBe(false);
    });

    it('should clear a single monitoring interval', async () => {
      const t1 = setInterval(() => {}, 99999);
      (manager as any).ipmiMonitoringIntervals.set('ipmi-s', t1);

      await (manager as any).handleIPMISessionClosed('ipmi-s');

      expect((manager as any).ipmiMonitoringIntervals.has('ipmi-s')).toBe(false);
    });

    it('should update session status to closed', async () => {
      const session = { id: 'ipmi-cl', status: 'running' };
      (host.getSession as jest.Mock).mockReturnValue(session);

      await (manager as any).handleIPMISessionClosed('ipmi-cl');

      expect(session.status).toBe('closed');
      expect(host.setSession).toHaveBeenCalledWith('ipmi-cl', session);
    });

    it('should delete session from ipmiSessions map', async () => {
      manager.seedIPMISession('ipmi-del', MOCK_IPMI_STATE);

      await (manager as any).handleIPMISessionClosed('ipmi-del');

      expect((manager as any).ipmiSessions.has('ipmi-del')).toBe(false);
    });

    it('should emit sessionClosed event', async () => {
      await (manager as any).handleIPMISessionClosed('ipmi-ev');

      expect(host.emitTypedEvent).toHaveBeenCalledWith('sessionClosed', 'ipmi-ev');
    });
  });

  // ── sendIPMIInput ───────────────────────────────────────────────────────────

  describe('sendIPMIInput', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(
        manager.sendIPMIInput('ipmi-no', 'hello')
      ).rejects.toThrow('IPMI session ipmi-no not found or inactive');
    });

    it('should throw when protocol is not found', async () => {
      manager.seedIPMISession('ipmi-np', MOCK_IPMI_STATE);

      await expect(
        manager.sendIPMIInput('ipmi-np', 'hello')
      ).rejects.toThrow('IPMI protocol not found for session ipmi-np');
    });

    it('should send input through the protocol', async () => {
      manager.seedIPMISession('ipmi-in', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-in', mockProtocol);

      await manager.sendIPMIInput('ipmi-in', 'reboot');

      expect(mockProtocol.sendInput).toHaveBeenCalledWith('ipmi-in', 'reboot');
    });

    it('should propagate errors from protocol', async () => {
      manager.seedIPMISession('ipmi-err', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-err', mockProtocol);
      mockProtocol.sendInput.mockRejectedValue(new Error('send failed'));

      await expect(
        manager.sendIPMIInput('ipmi-err', 'test')
      ).rejects.toThrow('send failed');
    });
  });

  // ── executeIPMIPowerControl ─────────────────────────────────────────────────

  describe('executeIPMIPowerControl', () => {
    const ops = ['on', 'off', 'reset', 'cycle', 'status'] as const;

    ops.forEach((op) => {
      it(`should execute power operation: ${op}`, async () => {
        manager.seedIPMISession('ipmi-pw', MOCK_IPMI_STATE);
        manager.seedIPMIProtocol('ipmi-pw', mockProtocol);

        await manager.executeIPMIPowerControl('ipmi-pw', op);

        expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
          'ipmi-pw',
          'chassis',
          ['power', op]
        );
        expect(host.emitTypedEvent).toHaveBeenCalledWith(
          'power-state-change',
          expect.objectContaining({ sessionId: 'ipmi-pw', operation: op })
        );
      });
    });
  });

  // ── readIPMISensors ─────────────────────────────────────────────────────────

  describe('readIPMISensors', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(manager.readIPMISensors('ipmi-no')).rejects.toThrow(
        'IPMI session ipmi-no not found or inactive'
      );
    });

    it('should call executeCommand with sensor reading', async () => {
      manager.seedIPMISession('ipmi-sr', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-sr', mockProtocol);

      const result = await manager.readIPMISensors('ipmi-sr');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-sr',
        'sensor',
        ['reading', 'all']
      );
      expect(result).toEqual([]);
    });

    it('should propagate errors', async () => {
      manager.seedIPMISession('ipmi-sre', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-sre', mockProtocol);
      mockProtocol.executeCommand.mockRejectedValue(new Error('sensor error'));

      await expect(manager.readIPMISensors('ipmi-sre')).rejects.toThrow(
        'sensor error'
      );
    });
  });

  // ── getIPMIEventLog ─────────────────────────────────────────────────────────

  describe('getIPMIEventLog', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(manager.getIPMIEventLog('ipmi-no')).rejects.toThrow(
        'IPMI session ipmi-no not found or inactive'
      );
    });

    it('should call executeCommand with sel list', async () => {
      manager.seedIPMISession('ipmi-el', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-el', mockProtocol);

      const result = await manager.getIPMIEventLog('ipmi-el');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-el',
        'sel',
        ['list']
      );
      expect(result).toEqual([]);
    });

    it('should propagate errors', async () => {
      manager.seedIPMISession('ipmi-ele', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-ele', mockProtocol);
      mockProtocol.executeCommand.mockRejectedValue(new Error('sel error'));

      await expect(manager.getIPMIEventLog('ipmi-ele')).rejects.toThrow(
        'sel error'
      );
    });
  });

  // ── mountIPMIVirtualMedia ───────────────────────────────────────────────────

  describe('mountIPMIVirtualMedia', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(
        manager.mountIPMIVirtualMedia('ipmi-no', 'cd', 'iso-url')
      ).rejects.toThrow('IPMI session ipmi-no not found or inactive');
    });

    it('should call executeCommand with sol mount', async () => {
      manager.seedIPMISession('ipmi-vm', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-vm', mockProtocol);

      await manager.mountIPMIVirtualMedia('ipmi-vm', 'cd', 'http://server/boot.iso');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-vm',
        'sol',
        ['mount', 'cd', 'http://server/boot.iso']
      );
    });

    it('should emit virtual-media-mounted event', async () => {
      manager.seedIPMISession('ipmi-vme', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-vme', mockProtocol);

      await manager.mountIPMIVirtualMedia('ipmi-vme', 'usb', 'usb.img');

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'virtual-media-mounted',
        expect.objectContaining({
          sessionId: 'ipmi-vme',
          mediaType: 'usb',
          imageUrl: 'usb.img',
        })
      );
    });

    it('should propagate errors', async () => {
      manager.seedIPMISession('ipmi-vmerr', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-vmerr', mockProtocol);
      mockProtocol.executeCommand.mockRejectedValue(new Error('mount failed'));

      await expect(
        manager.mountIPMIVirtualMedia('ipmi-vmerr', 'floppy', 'floppy.img')
      ).rejects.toThrow('mount failed');
    });
  });

  // ── unmountIPMIVirtualMedia ─────────────────────────────────────────────────

  describe('unmountIPMIVirtualMedia', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(
        manager.unmountIPMIVirtualMedia('ipmi-no', 'cd')
      ).rejects.toThrow('IPMI session ipmi-no not found or inactive');
    });

    it('should call executeCommand with sol unmount', async () => {
      manager.seedIPMISession('ipmi-um', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-um', mockProtocol);

      await manager.unmountIPMIVirtualMedia('ipmi-um', 'cd');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-um',
        'sol',
        ['unmount', 'cd']
      );
    });

    it('should emit virtual-media-unmounted event', async () => {
      manager.seedIPMISession('ipmi-ume', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-ume', mockProtocol);

      await manager.unmountIPMIVirtualMedia('ipmi-ume', 'usb');

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'virtual-media-unmounted',
        expect.objectContaining({ sessionId: 'ipmi-ume', mediaType: 'usb' })
      );
    });
  });

  // ── updateIPMIFirmware ──────────────────────────────────────────────────────

  describe('updateIPMIFirmware', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(
        manager.updateIPMIFirmware('ipmi-no', 'bmc', '/fw.bin')
      ).rejects.toThrow('IPMI session ipmi-no not found or inactive');
    });

    it('should call executeCommand with hpm upgrade', async () => {
      manager.seedIPMISession('ipmi-fw', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-fw', mockProtocol);

      await manager.updateIPMIFirmware('ipmi-fw', 'bmc', '/firmware/bmc.bin');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-fw',
        'hpm',
        ['upgrade', '/firmware/bmc.bin', 'component', 'bmc']
      );
    });

    it('should emit firmware-update-completed event', async () => {
      manager.seedIPMISession('ipmi-fwe', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-fwe', mockProtocol);

      await manager.updateIPMIFirmware('ipmi-fwe', 'bios', '/bios.bin');

      expect(host.emitTypedEvent).toHaveBeenCalledWith(
        'firmware-update-completed',
        expect.objectContaining({
          sessionId: 'ipmi-fwe',
          firmwareType: 'bios',
          firmwarePath: '/bios.bin',
        })
      );
    });
  });

  // ── getIPMISystemInfo ───────────────────────────────────────────────────────

  describe('getIPMISystemInfo', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(manager.getIPMISystemInfo('ipmi-no')).rejects.toThrow(
        'IPMI session ipmi-no not found or inactive'
      );
    });

    it('should call executeCommand with mc info', async () => {
      const sysInfo = { manufacturer: 'SuperMicro', version: '1.0' };
      mockProtocol.executeCommand.mockResolvedValue(sysInfo);
      manager.seedIPMISession('ipmi-si', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-si', mockProtocol);

      const result = await manager.getIPMISystemInfo('ipmi-si');

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-si',
        'mc',
        ['info']
      );
      expect(result).toBe(sysInfo);
    });

    it('should propagate errors', async () => {
      manager.seedIPMISession('ipmi-sie', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-sie', mockProtocol);
      mockProtocol.executeCommand.mockRejectedValue(new Error('mc info failed'));

      await expect(manager.getIPMISystemInfo('ipmi-sie')).rejects.toThrow(
        'mc info failed'
      );
    });
  });

  // ── configureIPMILAN ────────────────────────────────────────────────────────

  describe('configureIPMILAN', () => {
    it('should throw when session is not in ipmiSessions', async () => {
      await expect(
        manager.configureIPMILAN('ipmi-no', 1, {})
      ).rejects.toThrow('IPMI session ipmi-no not found or inactive');
    });

    it('should iterate settings and call executeCommand for each', async () => {
      manager.seedIPMISession('ipmi-lan', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-lan', mockProtocol);

      await manager.configureIPMILAN('ipmi-lan', 1, {
        'ip-address': '10.0.0.1',
        'subnet-mask': '255.255.255.0',
      });

      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-lan',
        'lan',
        ['set', '1', 'ip-address', '10.0.0.1']
      );
      expect(mockProtocol.executeCommand).toHaveBeenCalledWith(
        'ipmi-lan',
        'lan',
        ['set', '1', 'subnet-mask', '255.255.255.0']
      );
    });

    it('should propagate errors', async () => {
      manager.seedIPMISession('ipmi-lane', MOCK_IPMI_STATE);
      manager.seedIPMIProtocol('ipmi-lane', mockProtocol);
      mockProtocol.executeCommand.mockRejectedValue(new Error('lan set failed'));

      await expect(
        manager.configureIPMILAN('ipmi-lane', 1, { key: 'value' })
      ).rejects.toThrow('lan set failed');
    });
  });

  // ── destroy ─────────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('should clear all monitoring intervals (array)', async () => {
      jest.useFakeTimers();
      const t1 = setInterval(() => {}, 99999);
      const t2 = setInterval(() => {}, 99999);
      (manager as any).ipmiMonitoringIntervals.set('ipmi-d1', [t1, t2]);

      await manager.destroy();

      expect((manager as any).ipmiMonitoringIntervals.size).toBe(0);
    });

    it('should clear a single monitoring interval', async () => {
      jest.useFakeTimers();
      const t1 = setInterval(() => {}, 99999);
      (manager as any).ipmiMonitoringIntervals.set('ipmi-d2', t1);

      await manager.destroy();

      expect((manager as any).ipmiMonitoringIntervals.size).toBe(0);
    });

    it('should call cleanup on all protocol instances', async () => {
      const proto2 = createMockProtocol();
      manager.seedIPMIProtocol('ipmi-da', mockProtocol);
      manager.seedIPMIProtocol('ipmi-db', proto2);

      await manager.destroy();

      expect(mockProtocol.cleanup).toHaveBeenCalled();
      expect(proto2.cleanup).toHaveBeenCalled();
    });

    it('should clear ipmiProtocols map', async () => {
      manager.seedIPMIProtocol('ipmi-dc', mockProtocol);

      await manager.destroy();

      expect((manager as any).ipmiProtocols.size).toBe(0);
    });

    it('should clear ipmiSessions map', async () => {
      manager.seedIPMISession('ipmi-dd', MOCK_IPMI_STATE);

      await manager.destroy();

      expect((manager as any).ipmiSessions.size).toBe(0);
    });
  });
});
