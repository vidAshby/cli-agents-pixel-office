import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState, PersistedAgent } from './types.js';
import type { CliType } from './cliProviders.js';
import { getCliProvider, getCliProviderByPrefix } from './cliProviders.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS, DEFAULT_CLI_TYPE } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

export function getProjectDirPath(cwd?: string, cliType?: CliType): string | null {
	const type = cliType || (DEFAULT_CLI_TYPE as CliType);
	const provider = getCliProvider(type);
	const projectDir = provider.getProjectDir(cwd);
	if (projectDir) {
		console.log(`[Pixel Agents] Project dir (${type}): ${projectDir}`);
	}
	return projectDir;
}

export async function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	folderPath?: string,
	cliType?: CliType,
): Promise<void> {
	const type = cliType || (DEFAULT_CLI_TYPE as CliType);
	const provider = getCliProvider(type);

	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const idx = nextTerminalIndexRef.current++;
	const terminal = vscode.window.createTerminal({
		name: `${provider.terminalPrefix} #${idx}`,
		cwd,
	});
	terminal.show();

	const sessionId = crypto.randomUUID();
	const command = provider.buildCommand(sessionId);
	terminal.sendText(command);

	const projectDir = provider.getProjectDir(cwd);
	// For CLIs without project dirs (cursor), use a placeholder
	const effectiveProjectDir = projectDir || '';

	// Determine expected transcript file
	const expectedFile = provider.getTranscriptPath(sessionId, cwd) || '';

	if (expectedFile) {
		// Pre-register expected JSONL file so project scan won't treat it as a /clear file
		knownJsonlFiles.add(expectedFile);
	}

	// Create agent immediately (before JSONL file exists)
	const id = nextAgentIdRef.current++;
	const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		projectDir: effectiveProjectDir,
		jsonlFile: expectedFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		cliType: type,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Pixel Agents] Agent ${id} (${type}): created for terminal ${terminal.name}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName, cliType: type });

	if (type === 'claude' && projectDir) {
		// Claude: known project dir + known JSONL file path
		ensureProjectScan(
			projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);

		// Poll for the specific JSONL file to appear
		const pollTimer = setInterval(() => {
			try {
				if (fs.existsSync(agent.jsonlFile)) {
					console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
					clearInterval(pollTimer);
					jsonlPollTimers.delete(id);
					startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
					readNewLines(id, agents, waitingTimers, permissionTimers, webview);
				}
			} catch { /* file may not exist yet */ }
		}, JSONL_POLL_INTERVAL_MS);
		jsonlPollTimers.set(id, pollTimer);
	} else if (type === 'codex' && projectDir) {
		// Codex: discover rollout files by watching the sessions directory
		pollForCodexTranscript(
			id, agent, projectDir,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			jsonlPollTimers, webview,
		);
	} else if (type === 'gemini' && projectDir) {
		// Gemini: discover session files by watching the chats directory
		pollForGeminiTranscript(
			id, agent, projectDir,
			agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			jsonlPollTimers, webview,
		);
	}
	// Cursor: no file-based transcripts, agent just appears in the office
}

/** Poll for new Codex rollout JSONL files in the sessions directory */
function pollForCodexTranscript(
	agentId: number,
	agent: AgentState,
	sessionsDir: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	webview: vscode.Webview | undefined,
): void {
	// Snapshot existing rollout files so we can detect new ones
	const knownFiles = new Set<string>();
	try {
		collectCodexRolloutFiles(sessionsDir, knownFiles);
	} catch { /* dir may not exist yet */ }

	const pollTimer = setInterval(() => {
		try {
			const currentFiles = new Set<string>();
			collectCodexRolloutFiles(sessionsDir, currentFiles);
			for (const file of currentFiles) {
				if (!knownFiles.has(file)) {
					knownFiles.add(file);
					// Found a new rollout file — assign it to this agent
					console.log(`[Pixel Agents] Agent ${agentId} (codex): found rollout ${path.basename(file)}`);
					agent.jsonlFile = file;
					agent.fileOffset = 0;
					clearInterval(pollTimer);
					jsonlPollTimers.delete(agentId);
					startFileWatching(agentId, file, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
					readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
					return;
				}
			}
		} catch { /* dir may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(agentId, pollTimer);
}

/** Recursively collect rollout JSONL files from Codex sessions directory */
function collectCodexRolloutFiles(dir: string, out: Set<string>): void {
	if (!fs.existsSync(dir)) return;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectCodexRolloutFiles(fullPath, out);
		} else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
			out.add(fullPath);
		}
	}
}

/** Poll for new Gemini session JSON files in the chats directory */
function pollForGeminiTranscript(
	agentId: number,
	agent: AgentState,
	chatsDir: string,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	webview: vscode.Webview | undefined,
): void {
	// Snapshot existing session files
	const knownFiles = new Set<string>();
	try {
		if (fs.existsSync(chatsDir)) {
			for (const f of fs.readdirSync(chatsDir)) {
				if (f.endsWith('.json')) {
					knownFiles.add(path.join(chatsDir, f));
				}
			}
		}
	} catch { /* dir may not exist yet */ }

	const pollTimer = setInterval(() => {
		try {
			if (!fs.existsSync(chatsDir)) return;
			for (const f of fs.readdirSync(chatsDir)) {
				if (!f.endsWith('.json')) continue;
				const fullPath = path.join(chatsDir, f);
				if (!knownFiles.has(fullPath)) {
					knownFiles.add(fullPath);
					// Found a new session file
					console.log(`[Pixel Agents] Agent ${agentId} (gemini): found session ${f}`);
					agent.jsonlFile = fullPath;
					agent.fileOffset = 0;
					clearInterval(pollTimer);
					jsonlPollTimers.delete(agentId);
					startFileWatching(agentId, fullPath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
					readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
					return;
				}
			}
		} catch { /* dir may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(agentId, pollTimer);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			cliType: agent.cliType,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;
	let restoredProjectDir: string | null = null;

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) continue;

		// Default to 'claude' for agents persisted before multi-CLI support
		const cliType = p.cliType || (DEFAULT_CLI_TYPE as CliType);

		const agent: AgentState = {
			id: p.id,
			terminalRef: terminal,
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			cliType,
			folderName: p.folderName,
		};

		agents.set(p.id, agent);
		knownJsonlFiles.add(p.jsonlFile);
		console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}"`);

		if (p.id > maxId) maxId = p.id;
		// Extract terminal index from name like "Claude Code #3" or "Codex #5"
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}
		// Also try detecting CLI type from terminal name prefix for legacy agents
		if (!p.cliType) {
			const detectedProvider = getCliProviderByPrefix(p.terminalName);
			if (detectedProvider) {
				agent.cliType = detectedProvider.id;
			}
		}

		restoredProjectDir = p.projectDir;

		// Start file watching if JSONL exists, skipping to end of file
		try {
			if (fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else {
				// Poll for the file to appear
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch { /* file may not exist yet */ }
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch { /* ignore errors during restore */ }
	}

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes entries whose terminals are gone)
	doPersist();

	// Start project scan for /clear detection
	if (restoredProjectDir) {
		ensureProjectScan(
			restoredProjectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	// Include folderName and cliType per agent
	const folderNames: Record<number, string> = {};
	const cliTypes: Record<number, string> = {};
	for (const [id, agent] of agents) {
		if (agent.folderName) {
			folderNames[id] = agent.folderName;
		}
		cliTypes[id] = agent.cliType;
	}
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
		cliTypes,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
