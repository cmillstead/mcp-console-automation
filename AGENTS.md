# Console Automation MCP — Agent Navigation

MCP server for managing console sessions with SSH support.

## Quick Reference

- **Full details**: See `CLAUDE.md` for project rules, code organization, and session management

## 1. Environment — Check Before Starting

- **Repository state**: `git status`, `git stash list`, `git branch`
- **CI/PR state**: `gh run list --limit 5`, `gh pr list`, `gh pr view`
- **Recent history**: `git log --oneline -20`
- **Escalation**: If CI is already failing on an unrelated issue, note it and proceed

## 2. Memory — Check Prior Knowledge

- **Git memory**: `git log --oneline -- <file>`, `git blame -L <start>,<end> <file>`
- **QMD vault**: Use QMD `search` and `vector_search` tools. QMD indexes `~/src/**/*.md`
- **ContextKeep**: `list_all_memories`, `retrieve_memory` (when configured, skip if unavailable)
- **Escalation**: If Memory reveals a prior decision that contradicts the current task, surface to user

## 3. Task — Assemble Context for the Work

- **Find code**: Use Grep/Glob to find functions and classes before modifying them
- Read specific functions, not whole files
- Read test files if they exist for the component you're changing
- Check prior analysis: scan reports in `docs/`
- Don't pre-load — load incrementally

## Key Components

| Component | Purpose |
|-----------|---------|
| ConsoleManager | Core session management |
| DiagnosticsManager | Diagnostic tracking and reporting |
| SessionValidator | Session health validation |

## Commands

```bash
npm run lint                      # Lint
npm run typecheck                 # Type check
```

## Key Rules

- Never create separate "Improved"/"Enhanced" versions — modify originals directly
- Use git for tracking changes, not file duplication
- Always run lint and typecheck after changes
- Handle both one-shot and persistent sessions properly

## 4. Validation — Before Claiming Done

- **Self-review**: `git diff --stat`, `git diff`, re-read task/issue for acceptance criteria
- **Local verification**: `npm run lint && npm run typecheck`
- **After pushing**: `gh run list --limit 1`, `gh run view <id>`, fix CI failures immediately
- **Common CI failures**: type errors
- **Note**: No test suite currently
- **Don't claim done until**: lint/typecheck pass, CI green, diff is intentional only
