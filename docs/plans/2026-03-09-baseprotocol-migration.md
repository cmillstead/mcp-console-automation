# BaseProtocol Migration Implementation Plan (CODE-CRIT-3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate WSLProtocol, WebSocketTerminalProtocol, SFTPProtocol, IPCProtocol, and RDPProtocol to extend BaseProtocol, using capability-gated method stubs for unsupported operations.

**Architecture:** Each protocol extends BaseProtocol (which extends EventEmitter and implements IProtocol). Supported methods get real implementations; unsupported methods throw ProtocolNotSupportedError. The `capabilities` property honestly reflects what each protocol supports.

**Tech Stack:** TypeScript, Jest, BaseProtocol/IProtocol from src/core/

---

### Task 1: Create ProtocolNotSupportedError

**Files:**
- Create: `src/core/ProtocolNotSupportedError.ts`
- Modify: `src/core/IProtocol.ts` (re-export)

**Step 1: Create the error class**

```typescript
// src/core/ProtocolNotSupportedError.ts
export class ProtocolNotSupportedError extends Error {
  public readonly method: string;
  public readonly protocolType: string;

  constructor(method: string, protocolType: string) {
    super(`${method} is not supported by ${protocolType} protocol`);
    this.name = 'ProtocolNotSupportedError';
    this.method = method;
    this.protocolType = protocolType;
  }
}
```

**Step 2: Re-export from IProtocol.ts**

Add to end of `src/core/IProtocol.ts`:
```typescript
export { ProtocolNotSupportedError } from './ProtocolNotSupportedError.js';
```

**Step 3: Verify typecheck passes**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS (no errors related to the new file)

**Step 4: Commit**

```bash
git add src/core/ProtocolNotSupportedError.ts src/core/IProtocol.ts
git commit -m "feat: add ProtocolNotSupportedError for capability-gated protocol methods"
```

---

### Task 2: Migrate RDPProtocol (smallest delta — already partially implements IProtocol)

**Files:**
- Modify: `src/protocols/RDPProtocol.ts`
- Test: `tests/unit/rdp-protocol-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// tests/unit/rdp-protocol-conformance.test.ts
import { BaseProtocol } from '../../src/core/BaseProtocol';
import { ProtocolNotSupportedError } from '../../src/core/ProtocolNotSupportedError';

// Dynamic import to handle optional dependencies
let RDPProtocol: any;
beforeAll(async () => {
  try {
    const mod = await import('../../src/protocols/RDPProtocol');
    RDPProtocol = mod.RDPProtocol;
  } catch {
    // Skip if dependencies missing
  }
});

describe('RDPProtocol BaseProtocol conformance', () => {
  let protocol: any;

  beforeEach(() => {
    if (!RDPProtocol) return;
    protocol = new RDPProtocol();
  });

  afterEach(async () => {
    if (protocol) await protocol.cleanup();
  });

  it('should be an instance of BaseProtocol', () => {
    if (!RDPProtocol) return;
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "rdp"', () => {
    if (!RDPProtocol) return;
    expect(protocol.type).toBe('rdp');
  });

  it('should have capabilities with supportsCommands false', () => {
    if (!RDPProtocol) return;
    expect(protocol.capabilities).toBeDefined();
    expect(protocol.capabilities.supportsStreaming).toBe(false);
  });

  it('should throw ProtocolNotSupportedError for getOutput', async () => {
    if (!RDPProtocol) return;
    await expect(protocol.getOutput('fake-session')).rejects.toThrow(ProtocolNotSupportedError);
  });

  it('should return health status', async () => {
    if (!RDPProtocol) return;
    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBeDefined();
  });

  it('should return resource usage', () => {
    if (!RDPProtocol) return;
    const usage = protocol.getResourceUsage();
    expect(usage.memory).toBeDefined();
    expect(usage.sessions).toBeDefined();
  });

  it('should clean up on dispose', async () => {
    if (!RDPProtocol) return;
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/rdp-protocol-conformance.test.ts --no-coverage`
Expected: FAIL — RDPProtocol is not instance of BaseProtocol

**Step 3: Migrate RDPProtocol**

Modify `src/protocols/RDPProtocol.ts`:

1. Replace `extends EventEmitter` with `extends BaseProtocol`
2. Remove `EventEmitter` import, add BaseProtocol imports
3. Change constructor to call `super('RDPProtocol')`
4. Add `readonly type: ConsoleType = 'rdp'`
5. Add `readonly capabilities: ProtocolCapabilities` with honest values
6. Change `initialize()` to return `Promise<void>` (not boolean)
7. Override `getOutput()` to throw `ProtocolNotSupportedError`
8. Implement `doCreateSession()` protected method
9. Move existing sessions Map usage to `this.sessions` (inherited from BaseProtocol)
10. Ensure `dispose()` calls `await this.cleanup()` to clean BaseProtocol state + clear `performanceMonitors` timers

Key capability flags for RDP:
```typescript
capabilities: ProtocolCapabilities = {
  supportsStreaming: false,
  supportsFileTransfer: true,
  supportsX11Forwarding: false,
  supportsPortForwarding: true,
  supportsAuthentication: true,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: true,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: false,
  supportsWorkingDirectory: false,
  supportsSignals: false,
  supportsResizing: true,
  supportsPTY: false,
  maxConcurrentSessions: 10,
  defaultTimeout: 30000,
  supportedEncodings: ['utf8'],
  supportedAuthMethods: ['password', 'smartcard', 'nla'],
  platformSupport: { windows: true, linux: true, macos: true, freebsd: false },
};
```

**Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/rdp-protocol-conformance.test.ts --no-coverage`
Expected: PASS

**Step 5: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/protocols/RDPProtocol.ts tests/unit/rdp-protocol-conformance.test.ts
git commit -m "refactor: migrate RDPProtocol to extend BaseProtocol (CODE-CRIT-3)"
```

---

### Task 3: Migrate IPCProtocol

**Files:**
- Modify: `src/protocols/IPCProtocol.ts`
- Test: `tests/unit/ipc-protocol-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// tests/unit/ipc-protocol-conformance.test.ts
import { BaseProtocol } from '../../src/core/BaseProtocol';
import { ProtocolNotSupportedError } from '../../src/core/ProtocolNotSupportedError';

let IPCProtocol: any;
beforeAll(async () => {
  try {
    const mod = await import('../../src/protocols/IPCProtocol');
    IPCProtocol = mod.IPCProtocol;
  } catch {
    // Skip if dependencies missing
  }
});

describe('IPCProtocol BaseProtocol conformance', () => {
  let protocol: any;

  beforeEach(() => {
    if (!IPCProtocol) return;
    protocol = new IPCProtocol({
      type: 'unix-socket',
      path: '/tmp/test.sock',
    });
  });

  afterEach(async () => {
    if (protocol) await protocol.cleanup();
  });

  it('should be an instance of BaseProtocol', () => {
    if (!IPCProtocol) return;
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "ipc"', () => {
    if (!IPCProtocol) return;
    expect(protocol.type).toBe('ipc');
  });

  it('should have capabilities reflecting IPC support', () => {
    if (!IPCProtocol) return;
    expect(protocol.capabilities.supportsEncryption).toBe(true);
    expect(protocol.capabilities.supportsCompression).toBe(true);
  });

  it('should return health status', async () => {
    if (!IPCProtocol) return;
    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBeDefined();
  });

  it('should return resource usage', () => {
    if (!IPCProtocol) return;
    const usage = protocol.getResourceUsage();
    expect(usage.memory).toBeDefined();
  });

  it('should clean up on dispose', async () => {
    if (!IPCProtocol) return;
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/ipc-protocol-conformance.test.ts --no-coverage`
Expected: FAIL

**Step 3: Migrate IPCProtocol**

Modify `src/protocols/IPCProtocol.ts`:

1. Replace `extends EventEmitter` with `extends BaseProtocol`
2. Remove `EventEmitter` import, add BaseProtocol and IProtocol imports
3. Change constructor: call `super('IPCProtocol')` first, then set `this.options = options` etc.
4. Add `readonly type: ConsoleType = 'ipc'`
5. Add `readonly capabilities: ProtocolCapabilities` — IPC supports commands and output via message passing
6. Add `initialize()` → sets `this.isInitialized = true`
7. Add `dispose()` → clears `reconnectTimer`, `keepAliveTimer`, closes socket/server, calls `await this.cleanup()`
8. Add `createSession()` → wraps connection setup, stores ConsoleSession in `this.sessions`
9. Add `closeSession()` → disconnects and removes from `this.sessions`
10. `executeCommand()` → wraps `sendMessage()` for request-response patterns
11. `sendInput()` → wraps `sendMessage()`
12. `doCreateSession()` → protected implementation

Key capabilities:
```typescript
capabilities: ProtocolCapabilities = {
  supportsStreaming: true,
  supportsFileTransfer: false,
  supportsX11Forwarding: false,
  supportsPortForwarding: false,
  supportsAuthentication: false,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: false,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: false,
  supportsWorkingDirectory: false,
  supportsSignals: false,
  supportsResizing: false,
  supportsPTY: false,
  maxConcurrentSessions: 50,
  defaultTimeout: 30000,
  supportedEncodings: ['utf8', 'binary'],
  supportedAuthMethods: [],
  platformSupport: { windows: true, linux: true, macos: true, freebsd: true },
};
```

**Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/ipc-protocol-conformance.test.ts --no-coverage`
Expected: PASS

**Step 5: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/protocols/IPCProtocol.ts tests/unit/ipc-protocol-conformance.test.ts
git commit -m "refactor: migrate IPCProtocol to extend BaseProtocol (CODE-CRIT-3)"
```

---

### Task 4: Migrate SFTPProtocol

**Files:**
- Modify: `src/protocols/SFTPProtocol.ts`
- Test: `tests/unit/sftp-protocol-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// tests/unit/sftp-protocol-conformance.test.ts
import { BaseProtocol } from '../../src/core/BaseProtocol';
import { ProtocolNotSupportedError } from '../../src/core/ProtocolNotSupportedError';

let SFTPProtocol: any;
beforeAll(async () => {
  try {
    const mod = await import('../../src/protocols/SFTPProtocol');
    SFTPProtocol = mod.SFTPProtocol;
  } catch {
    // Skip if dependencies missing
  }
});

describe('SFTPProtocol BaseProtocol conformance', () => {
  let protocol: any;

  beforeEach(() => {
    if (!SFTPProtocol) return;
    protocol = new SFTPProtocol({
      host: 'localhost',
      port: 22,
      username: 'test',
    });
  });

  afterEach(async () => {
    if (protocol) await protocol.cleanup();
  });

  it('should be an instance of BaseProtocol', () => {
    if (!SFTPProtocol) return;
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "sftp"', () => {
    if (!SFTPProtocol) return;
    expect(protocol.type).toBe('sftp');
  });

  it('should have capabilities with file transfer true', () => {
    if (!SFTPProtocol) return;
    expect(protocol.capabilities.supportsFileTransfer).toBe(true);
    expect(protocol.capabilities.supportsStreaming).toBe(false);
  });

  it('should throw ProtocolNotSupportedError for executeCommand', async () => {
    if (!SFTPProtocol) return;
    await expect(protocol.executeCommand('fake', 'ls')).rejects.toThrow(ProtocolNotSupportedError);
  });

  it('should throw ProtocolNotSupportedError for sendInput', async () => {
    if (!SFTPProtocol) return;
    await expect(protocol.sendInput('fake', 'data')).rejects.toThrow(ProtocolNotSupportedError);
  });

  it('should throw ProtocolNotSupportedError for getOutput', async () => {
    if (!SFTPProtocol) return;
    await expect(protocol.getOutput('fake')).rejects.toThrow(ProtocolNotSupportedError);
  });

  it('should return resource usage', () => {
    if (!SFTPProtocol) return;
    const usage = protocol.getResourceUsage();
    expect(usage.memory).toBeDefined();
  });

  it('should clean up on dispose', async () => {
    if (!SFTPProtocol) return;
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/sftp-protocol-conformance.test.ts --no-coverage`
Expected: FAIL

**Step 3: Migrate SFTPProtocol**

Modify `src/protocols/SFTPProtocol.ts`:

1. Replace `extends EventEmitter` with `extends BaseProtocol`
2. Remove `EventEmitter` import, add BaseProtocol and IProtocol imports
3. Change constructor: remove `sessionId` param (managed by BaseProtocol), take only `options: SFTPSessionOptions`. Call `super('SFTPProtocol')` first.
4. Add `readonly type: ConsoleType = 'sftp'`
5. Add `readonly capabilities: ProtocolCapabilities` — file transfer focused
6. `initialize()` → sets `this.isInitialized = true`
7. `dispose()` → clears `keepAliveTimer`, `healthCheckTimer`, disconnects SSH, calls `await this.cleanup()`
8. `createSession()` → wraps `connect()`, stores ConsoleSession in `this.sessions`
9. `closeSession()` → wraps `disconnect()`, removes from `this.sessions`
10. `executeCommand()` → throw `ProtocolNotSupportedError`
11. `sendInput()` → throw `ProtocolNotSupportedError`
12. Override `getOutput()` → throw `ProtocolNotSupportedError`
13. `doCreateSession()` → protected implementation wrapping connect

Key capabilities:
```typescript
capabilities: ProtocolCapabilities = {
  supportsStreaming: false,
  supportsFileTransfer: true,
  supportsX11Forwarding: false,
  supportsPortForwarding: false,
  supportsAuthentication: true,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: false,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: false,
  supportsWorkingDirectory: false,
  supportsSignals: false,
  supportsResizing: false,
  supportsPTY: false,
  maxConcurrentSessions: 5,
  defaultTimeout: 30000,
  supportedEncodings: ['utf8', 'binary'],
  supportedAuthMethods: ['password', 'publickey', 'agent'],
  platformSupport: { windows: true, linux: true, macos: true, freebsd: true },
};
```

**Important:** SFTPProtocol's constructor currently takes `sessionId` as first param. After migration, session IDs are managed by BaseProtocol. The constructor should only take `options`. Callers that pass `sessionId` need to be updated — check `src/core/ConsoleManager.ts` and `src/core/ProtocolFactory.ts` for usages.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/sftp-protocol-conformance.test.ts --no-coverage`
Expected: PASS

**Step 5: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/protocols/SFTPProtocol.ts tests/unit/sftp-protocol-conformance.test.ts
git commit -m "refactor: migrate SFTPProtocol to extend BaseProtocol (CODE-CRIT-3)"
```

---

### Task 5: Migrate WebSocketTerminalProtocol

**Files:**
- Modify: `src/protocols/WebSocketTerminalProtocol.ts`
- Test: `tests/unit/websocket-protocol-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// tests/unit/websocket-protocol-conformance.test.ts
import { BaseProtocol } from '../../src/core/BaseProtocol';

let WebSocketTerminalProtocol: any;
beforeAll(async () => {
  try {
    const mod = await import('../../src/protocols/WebSocketTerminalProtocol');
    WebSocketTerminalProtocol = mod.WebSocketTerminalProtocol;
  } catch {
    // Skip if dependencies missing
  }
});

describe('WebSocketTerminalProtocol BaseProtocol conformance', () => {
  let protocol: any;

  beforeEach(() => {
    if (!WebSocketTerminalProtocol) return;
    protocol = new WebSocketTerminalProtocol();
  });

  afterEach(async () => {
    if (protocol) await protocol.cleanup();
  });

  it('should be an instance of BaseProtocol', () => {
    if (!WebSocketTerminalProtocol) return;
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "websocket-term"', () => {
    if (!WebSocketTerminalProtocol) return;
    expect(protocol.type).toBe('websocket-term');
  });

  it('should have capabilities with streaming true', () => {
    if (!WebSocketTerminalProtocol) return;
    expect(protocol.capabilities.supportsStreaming).toBe(true);
    expect(protocol.capabilities.supportsReconnection).toBe(true);
  });

  it('should return health status', async () => {
    if (!WebSocketTerminalProtocol) return;
    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBeDefined();
  });

  it('should return resource usage', () => {
    if (!WebSocketTerminalProtocol) return;
    const usage = protocol.getResourceUsage();
    expect(usage.memory).toBeDefined();
  });

  it('should clean up on dispose', async () => {
    if (!WebSocketTerminalProtocol) return;
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/websocket-protocol-conformance.test.ts --no-coverage`
Expected: FAIL

**Step 3: Migrate WebSocketTerminalProtocol**

Modify `src/protocols/WebSocketTerminalProtocol.ts`:

1. Replace `extends EventEmitter` with `extends BaseProtocol`
2. Remove `EventEmitter` import, add BaseProtocol and IProtocol imports
3. Change constructor: call `super('WebSocketTerminalProtocol')` first, then config setup
4. Add `readonly type: ConsoleType = 'websocket-term'`
5. Add `readonly capabilities: ProtocolCapabilities` — full console capabilities
6. Add `initialize()` → sets `this.isInitialized = true`
7. Add `dispose()` → clears all `reconnectTimers`, `pingIntervals`, closes sessions, calls `await this.cleanup()`
8. Adapt existing `createSession/closeSession/executeCommand/sendInput` to match BaseProtocol signatures
9. Move internal sessions Map to use `this.sessions` from BaseProtocol (note: internal type is `WebSocketTerminalSession` — may need a parallel map or cast)
10. `doCreateSession()` → protected implementation wrapping WebSocket connection

Key capabilities:
```typescript
capabilities: ProtocolCapabilities = {
  supportsStreaming: true,
  supportsFileTransfer: true,
  supportsX11Forwarding: false,
  supportsPortForwarding: false,
  supportsAuthentication: true,
  supportsEncryption: true,
  supportsCompression: true,
  supportsMultiplexing: true,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: false,
  supportsWorkingDirectory: false,
  supportsSignals: false,
  supportsResizing: true,
  supportsPTY: true,
  maxConcurrentSessions: 20,
  defaultTimeout: 30000,
  supportedEncodings: ['utf8'],
  supportedAuthMethods: ['token', 'password', 'certificate'],
  platformSupport: { windows: true, linux: true, macos: true, freebsd: true },
};
```

**Note on session maps:** WebSocketTerminalProtocol has its own `sessions: Map<string, WebSocketTerminalSession>`. Since BaseProtocol has `sessions: Map<string, ConsoleSession>`, keep a parallel `wsSessionDetails: Map<string, WebSocketTerminalSession>` for WebSocket-specific state and store the ConsoleSession wrapper in `this.sessions`.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/websocket-protocol-conformance.test.ts --no-coverage`
Expected: PASS

**Step 5: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/protocols/WebSocketTerminalProtocol.ts tests/unit/websocket-protocol-conformance.test.ts
git commit -m "refactor: migrate WebSocketTerminalProtocol to extend BaseProtocol (CODE-CRIT-3)"
```

---

### Task 6: Migrate WSLProtocol

**Files:**
- Modify: `src/protocols/WSLProtocol.ts`
- Test: `tests/unit/wsl-protocol-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// tests/unit/wsl-protocol-conformance.test.ts
import { BaseProtocol } from '../../src/core/BaseProtocol';

let WSLProtocol: any;
beforeAll(async () => {
  try {
    const mod = await import('../../src/protocols/WSLProtocol');
    WSLProtocol = mod.WSLProtocol;
  } catch {
    // Skip if dependencies missing
  }
});

describe('WSLProtocol BaseProtocol conformance', () => {
  let protocol: any;

  beforeEach(() => {
    if (!WSLProtocol) return;
    protocol = new WSLProtocol();
  });

  afterEach(async () => {
    if (protocol) await protocol.cleanup();
  });

  it('should be an instance of BaseProtocol', () => {
    if (!WSLProtocol) return;
    expect(protocol).toBeInstanceOf(BaseProtocol);
  });

  it('should have type "wsl"', () => {
    if (!WSLProtocol) return;
    expect(protocol.type).toBe('wsl');
  });

  it('should have capabilities with PTY support', () => {
    if (!WSLProtocol) return;
    expect(protocol.capabilities.supportsPTY).toBe(true);
    expect(protocol.capabilities.supportsStreaming).toBe(true);
  });

  it('should return health status', async () => {
    if (!WSLProtocol) return;
    const health = await protocol.getHealthStatus();
    expect(health.isHealthy).toBeDefined();
  });

  it('should return resource usage', () => {
    if (!WSLProtocol) return;
    const usage = protocol.getResourceUsage();
    expect(usage.memory).toBeDefined();
  });

  it('should clean up on dispose', async () => {
    if (!WSLProtocol) return;
    await protocol.dispose();
    expect(protocol.getSessionCount()).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/wsl-protocol-conformance.test.ts --no-coverage`
Expected: FAIL

**Step 3: Migrate WSLProtocol**

Modify `src/protocols/WSLProtocol.ts`:

1. Replace standalone class with `extends BaseProtocol`
2. Remove `EventEmitter` import (if present), add BaseProtocol and IProtocol imports
3. **Drop singleton pattern**: make constructor public, call `super('WSLProtocol')`. Keep `getInstance()` as a convenience static that creates/returns a cached instance, but the class itself is no longer locked to singleton.
4. Add `readonly type: ConsoleType = 'wsl'`
5. Add `readonly capabilities: ProtocolCapabilities` — full console capabilities
6. Change `initialize()` return type from `Promise<boolean>` to `Promise<void>` (throw on failure instead of returning false)
7. Add `dispose()` → clears `healthCheckIntervals`, closes all sessions, calls `await this.cleanup()`
8. Adapt `createSession()` to return `ConsoleSession` (wrap WSLSession into ConsoleSession, keep WSLSession in parallel map `wslSessionDetails`)
9. Adapt `executeCommand()` to match `Promise<void>` signature (currently returns `{stdout, stderr, exitCode}` — store output in `this.outputBuffers` instead)
10. Add `sendInput()` implementation
11. `doCreateSession()` → protected implementation
12. Move `activeSessions` usage to `this.sessions` from BaseProtocol

Key capabilities:
```typescript
capabilities: ProtocolCapabilities = {
  supportsStreaming: true,
  supportsFileTransfer: true,
  supportsX11Forwarding: true,
  supportsPortForwarding: true,
  supportsAuthentication: false,
  supportsEncryption: false,
  supportsCompression: false,
  supportsMultiplexing: false,
  supportsKeepAlive: true,
  supportsReconnection: true,
  supportsBinaryData: true,
  supportsCustomEnvironment: true,
  supportsWorkingDirectory: true,
  supportsSignals: true,
  supportsResizing: true,
  supportsPTY: true,
  maxConcurrentSessions: 20,
  defaultTimeout: 30000,
  supportedEncodings: ['utf8'],
  supportedAuthMethods: [],
  platformSupport: { windows: true, linux: false, macos: false, freebsd: false },
};
```

**Important signature changes:**
- `initialize(): Promise<boolean>` → `initialize(): Promise<void>` (throw on failure)
- `executeCommand()` return: `{stdout, stderr, exitCode}` → `void` (output goes to buffer). Keep original as `executeCommandWithResult()` for callers that need the return value.
- Check `src/core/ConsoleManager.ts` for callers of `WSLProtocol.getInstance()` and `executeCommand()` that depend on return values.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/wsl-protocol-conformance.test.ts --no-coverage`
Expected: PASS

**Step 5: Run typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/protocols/WSLProtocol.ts tests/unit/wsl-protocol-conformance.test.ts
git commit -m "refactor: migrate WSLProtocol to extend BaseProtocol (CODE-CRIT-3)"
```

---

### Task 7: Update callers and final verification

**Files:**
- Modify: `src/core/ConsoleManager.ts` (if needed)
- Modify: `src/core/ProtocolFactory.ts` (if needed)

**Step 1: Search for callers that depend on old signatures**

Check for:
- `WSLProtocol.getInstance()` calls
- `SFTPProtocol` constructor with `sessionId` first param
- `executeCommand()` callers expecting return values from WSL
- Direct `instanceof EventEmitter` checks on these protocols

**Step 2: Update callers**

Adapt any callers in ConsoleManager.ts or ProtocolFactory.ts to:
- Use new constructor signatures
- Not depend on `executeCommand()` return values (use `getOutput()` instead)
- Handle `ProtocolNotSupportedError` where capability checks are missing

**Step 3: Run full typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: PASS

**Step 4: Run all conformance tests**

Run: `npx jest tests/unit/*-conformance.test.ts --no-coverage`
Expected: All 5 PASS

**Step 5: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: update callers for BaseProtocol migration (CODE-CRIT-3)"
```
