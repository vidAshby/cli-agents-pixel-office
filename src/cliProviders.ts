import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

// ── CLI Type ────────────────────────────────────────────────
export const CLI_TYPES = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type CliType = typeof CLI_TYPES[number];

// ── CLI Provider Interface ──────────────────────────────────
export interface CliProvider {
	/** Unique identifier */
	id: CliType;
	/** Display name (e.g. "Claude Code") */
	label: string;
	/** Binary/command name (e.g. "claude") */
	command: string;
	/** Terminal name prefix (e.g. "Claude Code") */
	terminalPrefix: string;

	/** Build the command string to send to the terminal */
	buildCommand(sessionId: string): string;

	/**
	 * Get the expected transcript file path after launching.
	 * Returns null if the CLI doesn't write file-based transcripts.
	 */
	getTranscriptPath(sessionId: string, cwd?: string): string | null;

	/**
	 * Get the project directory used for transcript storage.
	 * Returns null if not applicable.
	 */
	getProjectDir(cwd?: string): string | null;

	/** Whether this CLI produces watchable transcript files */
	hasFileTranscripts: boolean;
}

// ── Helpers ─────────────────────────────────────────────────

function hashProjectPath(workspacePath: string): string {
	return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function getWorkspacePath(cwd?: string): string | undefined {
	return cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ── Claude Code Provider ────────────────────────────────────
const claudeProvider: CliProvider = {
	id: 'claude',
	label: 'Claude Code',
	command: 'claude',
	terminalPrefix: 'Claude Code',
	hasFileTranscripts: true,

	buildCommand(sessionId: string): string {
		return `claude --session-id ${sessionId}`;
	},

	getTranscriptPath(sessionId: string, cwd?: string): string | null {
		const projectDir = this.getProjectDir(cwd);
		if (!projectDir) return null;
		return path.join(projectDir, `${sessionId}.jsonl`);
	},

	getProjectDir(cwd?: string): string | null {
		const workspacePath = getWorkspacePath(cwd);
		if (!workspacePath) return null;
		const dirName = hashProjectPath(workspacePath);
		return path.join(os.homedir(), '.claude', 'projects', dirName);
	},
};

// ── Codex Provider ──────────────────────────────────────────
const codexProvider: CliProvider = {
	id: 'codex',
	label: 'Codex',
	command: 'codex',
	terminalPrefix: 'Codex',
	hasFileTranscripts: true,

	buildCommand(_sessionId: string): string {
		// Codex doesn't support --session-id; sessions are auto-generated
		return 'codex';
	},

	getTranscriptPath(_sessionId: string, _cwd?: string): string | null {
		// Codex uses date-sharded paths; we discover files by watching the sessions dir
		return null;
	},

	getProjectDir(_cwd?: string): string | null {
		const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
		return path.join(codexHome, 'sessions');
	},
};

// ── Gemini Provider ─────────────────────────────────────────
const geminiProvider: CliProvider = {
	id: 'gemini',
	label: 'Gemini',
	command: 'gemini',
	terminalPrefix: 'Gemini',
	hasFileTranscripts: true,

	buildCommand(_sessionId: string): string {
		// Gemini doesn't support --session-id at launch
		return 'gemini';
	},

	getTranscriptPath(_sessionId: string, _cwd?: string): string | null {
		// Gemini uses project-hash-based paths; we discover session files by watching
		return null;
	},

	getProjectDir(cwd?: string): string | null {
		const workspacePath = getWorkspacePath(cwd);
		if (!workspacePath) return null;
		const dirName = hashProjectPath(workspacePath);
		return path.join(os.homedir(), '.gemini', 'tmp', dirName, 'chats');
	},
};

// ── Cursor Provider ─────────────────────────────────────────
const cursorProvider: CliProvider = {
	id: 'cursor',
	label: 'Cursor',
	command: 'agent',
	terminalPrefix: 'Cursor',
	hasFileTranscripts: false,

	buildCommand(_sessionId: string): string {
		// Cursor CLI binary is 'agent'; no session-id flag
		return 'agent';
	},

	getTranscriptPath(_sessionId: string, _cwd?: string): string | null {
		// Cursor doesn't write file-based transcripts
		return null;
	},

	getProjectDir(_cwd?: string): string | null {
		// No project dir for transcript watching
		return null;
	},
};

// ── Provider Registry ───────────────────────────────────────
export const CLI_PROVIDERS: ReadonlyMap<CliType, CliProvider> = new Map([
	['claude', claudeProvider],
	['codex', codexProvider],
	['gemini', geminiProvider],
	['cursor', cursorProvider],
]);

export function getCliProvider(type: CliType): CliProvider {
	const provider = CLI_PROVIDERS.get(type);
	if (!provider) {
		throw new Error(`Unknown CLI type: ${type}`);
	}
	return provider;
}

export function getCliProviderByPrefix(terminalName: string): CliProvider | undefined {
	for (const provider of CLI_PROVIDERS.values()) {
		if (terminalName.startsWith(provider.terminalPrefix)) {
			return provider;
		}
	}
	return undefined;
}
