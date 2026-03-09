# TypeScript Strict Mode — noImplicitAny + Explicit Any Reduction (CODE-HIGH-3)

**Date**: 2026-03-09

## Problem

TypeScript strict mode is disabled. `noImplicitAny` is off, allowing 59 implicit `any` errors. The codebase has 1,159 occurrences of `any` across src/, with the top 4 files accounting for ~254 explicit usages.

## Approach

Two phases:
1. Fix all 59 `noImplicitAny` errors, enable the flag in tsconfig.json
2. Reduce explicit `any` in the top 4 offender files by ~50%

## Phase 1: noImplicitAny

### ConsoleManager.ts (35 errors)
- Add types to callback parameters (destructured bindings, event handlers)
- Mostly `string`, `Error`, and domain-specific types already defined in types/index.ts

### src/tests/ (16 errors)
- Type `assertions` properties in object literals (all `any[]` → typed arrays)

### Other files (8 errors)
- SSHConnectionKeepAlive.ts: type `code` and `error` params
- SSHSessionHandler.ts: type `err` param
- TriggerManager.ts: install `@types/node-cron` or add declaration
- server.ts: type `o` param
- RDPProtocol.ts: install `@types/node-forge` or add declaration

### tsconfig.json change
Set `"noImplicitAny": true`

## Phase 2: Explicit Any Reduction (top 4 files)

### types/index.ts (34 → ~15)
- Replace `metadata?: any` with `metadata?: Record<string, unknown>`
- Replace `Record<string, any>` with `Record<string, unknown>` where shape is truly unknown
- Add specific types where shape is knowable

### server.ts (89 → ~45)
- Type MCP tool handler input params with interfaces
- Replace catch block `any` with `unknown`
- Type known return shapes

### ConsoleManager.ts (72 → ~35)
- Type event handler params
- `unknown` for catch blocks
- Leave protocol-specific `any` where type info unavailable

### DataPipelineManager.ts (59 → ~30)
- `unknown` for pipeline data flowing through transforms
- Typed wrappers for known shapes

## Ground Rules

- `any` → `unknown` when shape is truly unknown
- `any` → proper type when shape is knowable
- Don't invent complex generics just to avoid `any`
- Don't touch files outside the top 4 for explicit any reduction
- No `strict: true` (strictNullChecks is a separate task)
- No `noUnusedLocals` / `noUnusedParameters` changes

## Success Criteria

- `noImplicitAny: true` in tsconfig.json
- Zero implicit any errors
- Top 4 files reduced by ~50% explicit `any`
- Typecheck passes
