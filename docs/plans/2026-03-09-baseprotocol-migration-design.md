# BaseProtocol Migration Design — CODE-CRIT-3

**Date**: 2026-03-09
**Task**: Migrate 5 non-BaseProtocol protocols to extend BaseProtocol

## Problem

5 protocols bypass the BaseProtocol hierarchy: WSLProtocol, WebSocketTerminalProtocol, SFTPProtocol, IPCProtocol, RDPProtocol. They extend EventEmitter directly and do not conform to the IProtocol interface, making them inconsistent with the rest of the protocol system.

## Approach: Capability-Gated BaseProtocol Extension

All 5 protocols extend BaseProtocol. The `capabilities` property honestly reflects what each protocol supports. Unsupported abstract methods throw `ProtocolNotSupportedError`. Callers check capabilities before calling methods.

## ProtocolNotSupportedError

New error class (location TBD — new file or existing error location):

```typescript
class ProtocolNotSupportedError extends Error {
  constructor(method: string, protocolType: string) {
    super(`${method} is not supported by ${protocolType} protocol`);
    this.name = 'ProtocolNotSupportedError';
  }
}
```

## Per-Protocol Migration

### WSLProtocol (good fit)

- Full implementation of all abstract methods
- Drop singleton pattern — `getInstance()` becomes a standalone factory/helper
- `super('WSLProtocol')` in constructor
- `capabilities`: most flags `true`
- Session creation wraps existing WSL session logic, returns ConsoleSession
- Existing WSL-specific methods (distribution management, path translation) stay as public API

### WebSocketTerminalProtocol (good fit)

- Full implementation of all abstract methods
- Config object stays, passed after `super('WebSocketTerminalProtocol')`
- `capabilities`: most flags `true`
- Session creation wraps WebSocket connection + terminal session
- Existing config/latency/reconnect logic stays

### SFTPProtocol (file transfer — limited fit)

- `createSession` wraps `connect()` — creates ConsoleSession record for the connection
- `closeSession` wraps `disconnect()`
- `executeCommand`, `sendInput`, `getOutput` → throw `ProtocolNotSupportedError`
- `capabilities`: `supportsCommands: false, supportsOutput: false`
- All file transfer methods stay as protocol-specific public API

### IPCProtocol (message passing — moderate fit)

- `createSession` wraps connection setup (pipe / socket / dbus / etc.)
- `executeCommand` wraps `sendMessage()` for request-response
- `getOutput` returns received messages as ConsoleOutput
- `sendInput` wraps `sendMessage()`
- `capabilities`: `supportsCommands: true, supportsOutput: true`
- Server mode and protocol-specific methods stay as public API

### RDPProtocol (GUI desktop — limited fit)

- Already partially implements IProtocol — smallest delta
- `getOutput` → throw `ProtocolNotSupportedError` (binary/GUI protocol)
- `executeCommand` stays as event-emitting (best effort for GUI)
- `capabilities`: `supportsCommands: false, supportsOutput: false`
- All RDP-specific methods (input, clipboard, file transfer, recording) stay

## Timer Cleanup

All protocols register their timers with BaseProtocol's cleanup flow. `dispose()` calls `super.cleanup()` which handles session cleanup, then protocol-specific timer cleanup.

## What Changes

- Each protocol gains ~5-10 lines of abstract method stubs
- WSL loses singleton enforcement
- All gain standardized health/cleanup lifecycle from BaseProtocol
- New `ProtocolNotSupportedError` class

## What Is Preserved

- All existing protocol-specific public methods
- All existing types/interfaces (WSLSession, SFTPTransferProgress, etc.)
- Constructor options and config objects
- Internal state management patterns

## Testing

One conformance test per protocol (~10-15 assertions each):
- `instanceof BaseProtocol` is true
- `capabilities` flags are accurate
- Supported methods work (mocked connections)
- Unsupported methods throw `ProtocolNotSupportedError`
- `dispose()` cleans up all timers

Total: 5 test files, ~50-75 assertions.
