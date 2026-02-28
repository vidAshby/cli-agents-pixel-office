# Multi-CLI Research: Codex, Gemini, and Cursor CLI

## Overview

This document captures research findings for integrating three additional CLI agents
alongside Claude Code in Pixel Agents. The goal is to support all four CLIs
simultaneously, with a dropdown selector on the "+ Agent" button.

---

## 1. Claude Code (Existing)

| Property | Value |
|---|---|
| **Package** | `@anthropic-ai/claude-code` |
| **Command** | `claude` |
| **Session flag** | `--session-id <uuid>` |
| **Working dir** | Terminal `cwd` option |
| **Transcript path** | `~/.claude/projects/<project-hash>/<session-id>.jsonl` |
| **Transcript format** | JSONL (append-only) |
| **Record types** | `assistant` (tool_use blocks), `user` (tool_result), `system` (turn_duration), `progress` (agent/bash/mcp) |
| **Tool identification** | `tool_use` blocks with `name`, `id`, `input` |
| **Tool completion** | `tool_result` blocks with `tool_use_id` |
| **Turn end signal** | `system` record with `subtype: "turn_duration"` |

---

## 2. OpenAI Codex CLI

| Property | Value |
|---|---|
| **Package** | `@openai/codex` |
| **Command** | `codex` |
| **Session flag** | None (auto-generated). Resume via `codex resume <SESSION_ID>` |
| **Working dir** | `--cd <path>` / `-C <path>` flag, or terminal `cwd` |
| **Transcript path** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **Transcript format** | JSONL (append-only, date-sharded) |
| **Key flags** | `--full-auto`, `--sandbox <mode>`, `--json` (stream JSONL to stdout) |
| **Record types** | Events wrapped in `event_msg`: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` (response_item with tool_call/tool_result/message) |
| **Tool identification** | `response_item` events with `tool_call` type |
| **Tool completion** | `response_item` events with `tool_result` type |
| **Turn end signal** | `turn.completed` event (includes usage stats) |
| **Config home** | `~/.codex/` (override with `CODEX_HOME`) |

### Key Differences from Claude
- No `--session-id` flag; session IDs are auto-generated
- Date-sharded transcript path (YYYY/MM/DD) vs project-hash
- Different JSONL record structure (event-based vs message-based)
- Uses `tool_call`/`tool_result` instead of `tool_use`/`tool_result`

### Sources
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex Non-interactive Mode](https://developers.openai.com/codex/noninteractive/)
- [GitHub: openai/codex](https://github.com/openai/codex)

---

## 3. Google Gemini CLI

| Property | Value |
|---|---|
| **Package** | `@google/gemini-cli` |
| **Command** | `gemini` |
| **Session flag** | `--resume <uuid>` (resume existing). No session-id-at-launch flag. |
| **Working dir** | Terminal `cwd` (no explicit flag) |
| **Transcript path** | `~/.gemini/tmp/<project-hash>/chats/` (JSON files, not JSONL) |
| **Transcript format** | Monolithic JSON (full rewrite per turn). JSONL migration proposed but not shipped. |
| **Key flags** | `-p <prompt>` (non-interactive), `--model <model>`, `--yolo` (auto-approve), `--sandbox`, `--debug` |
| **Record types** | JSON with message array: `user` and `gemini` message objects with `content` arrays |
| **Tool identification** | `functionCall` blocks in content (Gemini API format) |
| **Tool completion** | `functionResponse` blocks in content |
| **Turn end signal** | None explicit; infer from message boundaries |
| **Config home** | `~/.gemini/` |

### Key Differences from Claude
- No JSONL format yet (monolithic JSON files)
- Uses Google's `functionCall`/`functionResponse` format
- Session management via `--resume` with index or UUID
- Sessions are project-specific (auto-detected from cwd)
- No explicit turn-end signal

### Sources
- [Gemini CLI Session Management](https://geminicli.com/docs/cli/session-management/)
- [Gemini CLI Reference](https://geminicli.com/docs/cli/cli-reference/)
- [GitHub: google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- [GitHub Issue #15292: JSONL Migration](https://github.com/google-gemini/gemini-cli/issues/15292)

---

## 4. Cursor CLI (Agent)

| Property | Value |
|---|---|
| **Package** | Binary install via `curl https://cursor.com/install` |
| **Command** | `agent` |
| **Session flag** | `--resume [chatId]` or `--continue` (most recent) |
| **Working dir** | `--workspace <path>` flag, or terminal `cwd` |
| **Transcript path** | No JSONL files on disk. SQLite-based internal storage. |
| **Transcript format** | Stream JSON via `--output-format stream-json` (NDJSON to stdout) |
| **Key flags** | `-p` (non-interactive), `--force`/`--yolo`, `--model <model>`, `--trust`, `--cloud` |
| **Stream record types** | `system` (init), `user`, `assistant`, `tool_call` (subtype: started/completed), `result` |
| **Tool identification** | `tool_call` events with `subtype: "started"`, `call_id`, and `tool_call` object |
| **Tool completion** | `tool_call` events with `subtype: "completed"` and matching `call_id` |
| **Turn end signal** | `result` event with duration and final result |
| **Config home** | `~/.cursor/` |

### Key Differences from Claude
- Binary named `agent`, not `cursor`
- No JSONL files written to disk (must use `stream-json` output)
- SQLite-based internal storage (not accessible)
- Different event format (`tool_call` with subtypes vs `tool_use`/`tool_result`)
- Requires `--trust` flag for automated workspace trust

### Sources
- [Cursor CLI Overview](https://cursor.com/docs/cli/overview)
- [Using Agent in CLI](https://cursor.com/docs/cli/using)
- [Cursor CLI Parameters](https://cursor.com/docs/cli/reference/parameters)
- [Cursor CLI Output Format](https://cursor.com/docs/cli/reference/output-format)

---

## Transcript Monitoring Strategy

### Approach per CLI

| CLI | Strategy | Path Pattern |
|---|---|---|
| Claude | Watch JSONL file (existing) | `~/.claude/projects/<hash>/<session>.jsonl` |
| Codex | Watch JSONL rollout file | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini | Watch JSON session file | `~/.gemini/tmp/<hash>/chats/session-*.json` |
| Cursor | Not file-watchable. Terminal-only observation. | N/A |

### Unified Parsing Approach

Since each CLI has a different transcript format, we need a **CLI-specific parser** that
normalizes events into a common internal format:

```typescript
interface NormalizedToolEvent {
  type: 'toolStart' | 'toolDone' | 'turnEnd' | 'textMessage';
  toolId?: string;
  toolName?: string;
  status?: string;
  input?: Record<string, unknown>;
}
```

Each CLI provider implements a `parseTranscriptLine(line: string): NormalizedToolEvent[]`
method that converts its native format into these normalized events.

For CLIs without file-based transcripts (Cursor), the agent will appear in the office
but tool tracking will be limited to terminal observation (spawn + idle detection only).
