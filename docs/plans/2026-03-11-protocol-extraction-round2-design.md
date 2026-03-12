# Protocol Extraction Round 2 — Design Doc

**Date:** 2026-03-11
**Status:** Approved
**Scope:** Extract 6 remaining protocol clusters from ConsoleManager.ts (8,268 → ~6,600 lines)

## Overview

Extract IPMI, VNC, WinRM, SFTP, WSL, and IPC protocol methods into standalone session managers extending `ProtocolSessionManagerBase`. This is the same pattern used in 8 prior extractions.

## Key Design Decisions

### Per-Session vs Singleton Protocol

Unlike previous extractions (which used the singleton `ensureProtocol()` pattern), 4 of 6 clusters use **per-session protocol instances**:

| Manager | Pattern | Protocol Map |
|---------|---------|-------------|
| IPMI | Per-session | `ipmiProtocols: Map<string, IProtocol>` |
| VNC | Per-session | `vncProtocols: Map<string, IProtocol>` |
| WinRM | Per-session | `winrmProtocols: Map<string, IProtocol>` |
| SFTP | Per-session | `sftpProtocols: Map<string, IProtocol>` |
| WSL | **Singleton** | Uses base `this.protocol` via `ensureProtocol()` |
| IPC | Per-session (stub) | `ipcProtocols: Map<string, IProtocol>` |

For per-session managers, `setupEventHandlers()` is a no-op (events are wired per-session in `createSession()`). Each manager owns its own `Map<string, IProtocol>` for per-session instances, using `host.getProtocolFactory().createProtocol(type)` directly.

### Host Interface Extensions

Only **VNC** needs an extended host interface:

```typescript
export interface VNCSessionHost extends ProtocolSessionHost {
  handleSessionError(sessionId: string, error: Error, operation: string): Promise<boolean>;
}
```

All other managers use the base `ProtocolSessionHost` as-is.

### Fields Relocating to Managers

| Field | → Manager |
|-------|-----------|
| `ipmiProtocols`, `ipmiSessions`, `ipmiMonitoringIntervals` | IPMISessionManager |
| `vncProtocols`, `vncSessions`, `vncFramebuffers` | VNCSessionManager |
| `winrmProtocols`, `winrmSessions` | WinRMSessionManager |
| `sftpProtocols`, `fileTransferSessions` | SFTPSessionManager |
| `wslProtocol` | WSLSessionManager |
| `ipcProtocols`, `ipcSessions` | IPCSessionManager |

Destructor cleanup for each field set moves to the respective manager's `destroy()` override.

### `any` Reduction Opportunities

- All `*Protocols: Map<string, any>` → `Map<string, IProtocol>`
- VNC: 4× `(connectedSession as any).X` → `VNCConnectedSession` interface
- WSL: `wslProtocol?: any` → declare `WSLProtocol extends IProtocol` with WSL-specific methods
- IPMI: `ipmiSession: any` parameter → `EventEmitter` or typed `IPMISessionHandle`

### SFTP `createSession` Location

SFTP's `createSFTPSession` is at lines ~2580-2667 (within the main session creation block), separate from the SFTP utility methods at ~7086-7177. Both sections move into `SFTPSessionManager`.

## Test Strategy

~225 new unit tests across 6 files, following the established mock Host + mock Protocol pattern:

| Manager | Est. Tests | Key Complexity |
|---------|-----------|----------------|
| IPMI | ~65 | Monitoring intervals, dual Map guards, ipmiSession events |
| VNC | ~40 | VNCSession construction, framebuffer tracking, auth mapping |
| WinRM | ~38 | Perf counter mutations, port/protocol defaults |
| SFTP | ~35 | Transfer stats via events, sshOptions requirement |
| WSL | ~35 | Singleton protocol, executeCommand for input, graceful unavailability |
| IPC | ~12 | Stub — scaffold only |

## Execution Plan

6 phases, one per manager, using subagent-driven development. Order by complexity (simplest first):
1. IPC (stub)
2. SFTP
3. WinRM
4. WSL
5. VNC
6. IPMI
