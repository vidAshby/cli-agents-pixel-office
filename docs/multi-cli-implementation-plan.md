# Multi-CLI Implementation Plan

## Goal

Extend Pixel Agents to support Claude Code, OpenAI Codex, Google Gemini CLI, and
Cursor CLI simultaneously. The "+ Agent" button gets a dropdown arrow to select
which CLI to spawn. All four CLIs can run at the same time.

---

## Architecture Overview

### CLI Provider Abstraction

A new `src/cliProviders.ts` module defines a `CliProvider` interface and a registry
of all supported CLIs:

```typescript
interface CliProvider {
  id: CliType;           // 'claude' | 'codex' | 'gemini' | 'cursor'
  label: string;         // Display name: 'Claude Code', 'Codex', etc.
  command: string;       // Binary name: 'claude', 'codex', 'gemini', 'agent'
  terminalPrefix: string; // Terminal name prefix: 'Claude Code', 'Codex', etc.

  // Build the command string to send to the terminal
  buildCommand(sessionId: string, cwd?: string): string;

  // Get the expected transcript file path (null if no file-based transcripts)
  getTranscriptPath(sessionId: string, cwd?: string): string | null;

  // Get the project directory for watching
  getProjectDir(cwd?: string): string | null;

  // Parse a transcript line into normalized events
  parseTranscriptLine(line: string): NormalizedToolEvent[];
}
```

### Data Flow Changes

1. **Webview → Extension**: `openClaude` message gains a `cliType` field
2. **Extension → Webview**: `agentCreated` message gains a `cliType` field
3. **AgentState / PersistedAgent**: Both gain a `cliType` field
4. **BottomToolbar**: Split button with CLI selector dropdown

---

## File-by-File Changes

### New Files

1. **`src/cliProviders.ts`** — CLI provider registry
   - `CliType` type union
   - `CliProvider` interface
   - `CLI_PROVIDERS` map with implementations for each CLI
   - `getCliProvider(type)` helper

### Modified Files

2. **`src/types.ts`** — Add `cliType` field to `AgentState` and `PersistedAgent`

3. **`src/constants.ts`** — Add `DEFAULT_CLI_TYPE`, `GLOBAL_KEY_SELECTED_CLI`

4. **`src/agentManager.ts`**
   - `launchNewTerminal()` takes `cliType` parameter
   - Uses provider to build command, get transcript path, set terminal name
   - Different JSONL polling logic per provider
   - `persistAgents()` saves `cliType`
   - `restoreAgents()` restores `cliType`, matches terminals by prefix+index

5. **`src/transcriptParser.ts`**
   - `processTranscriptLine()` takes `cliType` parameter
   - Routes to CLI-specific parsing function
   - `processClaudeTranscriptLine()` — existing logic (renamed)
   - `processCodexTranscriptLine()` — Codex event_msg parsing
   - `processGeminiTranscriptLine()` — Gemini JSON session parsing
   - `processCursorTranscriptLine()` — Cursor stream-json parsing (future)

6. **`src/fileWatcher.ts`**
   - Pass `cliType` to `processTranscriptLine()`
   - Codex: different file discovery (date-sharded path)
   - Gemini: watch JSON files (full re-read on change, diff against known state)

7. **`src/PixelAgentsViewProvider.ts`**
   - Pass `cliType` from message to `launchNewTerminal()`
   - Send `cliType` in `existingAgents` and `agentCreated` messages
   - Persist selected CLI type in `globalState`

8. **`webview-ui/src/components/BottomToolbar.tsx`**
   - Split button: main button spawns currently selected CLI
   - Dropdown arrow shows CLI picker (Claude, Codex, Gemini, Cursor)
   - Each option shows CLI name
   - Selected CLI persisted via `setSelectedCli` message

9. **`webview-ui/src/hooks/useExtensionMessages.ts`**
   - Track `cliType` per agent for display purposes
   - Pass through `cliType` from `agentCreated`/`existingAgents`

10. **`webview-ui/src/office/components/ToolOverlay.tsx`**
    - Show CLI type indicator on agent label (optional)

---

## Per-CLI Implementation Details

### Claude Code (existing, refactored)
- Command: `claude --session-id ${sessionId}`
- Transcript: `~/.claude/projects/<hash>/<sessionId>.jsonl`
- Parser: existing `processTranscriptLine` logic
- No changes needed to parsing logic

### Codex CLI
- Command: `codex` (no session-id flag, auto-generated)
- Transcript: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Discovery: Poll `~/.codex/sessions/` for new rollout files after launch
- Parser: Normalize `event_msg` events → `response_item` with `tool_call`/`tool_result`
- Turn end: `turn.completed` event
- Limitation: Cannot pre-specify session ID; must discover rollout file by timestamp

### Gemini CLI
- Command: `gemini` (no session-id flag)
- Transcript: `~/.gemini/tmp/<hash>/chats/session-*.json` (monolithic JSON)
- Discovery: Watch for new session files in project-hash directory
- Parser: Parse full JSON, diff against previous state to find new messages
- Turn end: Infer from message array length changes and content
- Limitation: Monolithic JSON means full re-read on every change

### Cursor CLI
- Command: `agent` (no file-based transcripts)
- Transcript: None (SQLite-based internal storage)
- Discovery: Terminal-only — agent appears in office but without tool tracking
- Parser: No transcript parsing (agent shows as idle/active based on terminal state)
- Turn end: No signal available
- Limitation: No tool tracking; character appears but won't show activity status
- Future: Could pipe `--output-format stream-json` but requires non-interactive mode

---

## UI Design: CLI Selector

The "+ Agent" button becomes a split button:

```
┌──────────────┬───┐
│  + Agent     │ ▾ │
└──────────────┴───┘
```

Clicking the main area spawns an agent with the currently selected CLI.
Clicking the arrow opens a dropdown:

```
┌──────────────────┐
│ ● Claude Code    │
│ ○ Codex          │
│ ○ Gemini         │
│ ○ Cursor         │
└──────────────────┘
```

The selected CLI is persisted. When multi-root workspace folders exist,
the folder picker appears after CLI selection (or CLI selection appears
as a sub-menu within the folder picker).

---

## Migration & Backwards Compatibility

- Existing persisted agents without `cliType` default to `'claude'`
- Terminal name matching in `restoreAgents()` checks all known prefixes
- All existing JSONL parsing logic preserved as `processClaudeTranscriptLine()`
- No breaking changes to layout or settings persistence

---

## Testing Strategy

1. Manual: Launch each CLI type, verify terminal creation and naming
2. Verify transcript file discovery for Claude and Codex
3. Verify Gemini JSON file watching
4. Verify Cursor agent appears without tool tracking
5. Verify persistence/restoration across VS Code reloads
6. Verify CLI selector dropdown behavior
7. Build succeeds: `npm run build`
