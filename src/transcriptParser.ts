import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);

// ── Codex tool name mapping ─────────────────────────────────
// Codex uses different tool names; map common ones to our display format
const CODEX_TOOL_NAME_MAP: Record<string, string> = {
	'shell': 'Bash',
	'read_file': 'Read',
	'write_file': 'Write',
	'edit_file': 'Edit',
	'list_directory': 'Glob',
	'search': 'Grep',
	'web_search': 'WebSearch',
};

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		default: return `Using ${toolName}`;
	}
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Route to CLI-specific parser
	if (agent.cliType === 'codex') {
		processCodexTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		return;
	}
	if (agent.cliType === 'gemini') {
		processGeminiTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
		return;
	}
	// cursor has no file transcripts, so this won't be called for cursor agents
	// Default: Claude format
	try {
		const record = JSON.parse(line);

		if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<{
				type: string; id?: string; name?: string; input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(b => b.type === 'tool_use');

			if (hasToolUse) {
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === 'tool_use' && block.id) {
						const toolName = block.name || '';
						const status = formatToolStatus(toolName, block.input || {});
						console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
							hasNonExemptTool = true;
						}
						webview?.postMessage({
							type: 'agentToolStart',
							id: agentId,
							toolId: block.id,
							status,
						});
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}
			} else if (blocks.some(b => b.type === 'text') && !agent.hadToolsInTurn) {
				// Text-only response in a turn that hasn't used any tools.
				// turn_duration handles tool-using turns reliably but is never
				// emitted for text-only turns, so we use a silence-based timer:
				// if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		} else if (record.type === 'progress') {
			processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
		} else if (record.type === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task, clear its subagent tools
							if (agent.activeToolNames.get(completedToolId) === 'Task') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								webview?.postMessage({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// All tools completed — allow text-idle timer as fallback
					// for turn-end detection when turn_duration is not emitted
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				} else {
					// New user text prompt — new turn starting
					cancelWaitingTimer(agentId, waitingTimers);
					clearAgentActivity(agent, agentId, permissionTimers, webview);
					agent.hadToolsInTurn = false;
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
			}
		} else if (record.type === 'system' && record.subtype === 'turn_duration') {
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);

			// Definitive turn-end: clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	} catch {
		// Ignore malformed lines
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) return;

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return;

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
	// Restart the permission timer to give the running tool another window.
	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
		return;
	}

	// Verify parent is an active Task tool (agent_progress handling)
	if (agent.activeToolNames.get(parentToolId) !== 'Task') return;

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) return;

	if (msgType === 'assistant') {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === 'tool_use' && block.id) {
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

				// Track sub-tool IDs
				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				// Track sub-tool names (for permission checking)
				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				webview?.postMessage({
					type: 'subagentToolStart',
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				// Remove from tracking
				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					webview?.postMessage({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		// If there are still active non-exempt sub-agent tools, restart the permission timer
		// (handles the case where one sub-agent completes but another is still stuck)
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) break;
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	}
}

// ── Codex Transcript Parser ─────────────────────────────────
// Codex JSONL uses event_msg wrappers. Key event types:
// - response_item with tool_call / tool_result / message payloads
// - turn.completed (turn end signal)
// - user_message (new user prompt)

function processCodexTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const record = JSON.parse(line);
		const eventType = record.type as string | undefined;

		// Handle event_msg wrapper format
		const payload = record.payload || record;
		const payloadType = payload.type as string | undefined;

		if (eventType === 'response_item' || payloadType === 'response_item') {
			const item = payload.item || payload;
			const itemType = item.type as string | undefined;

			if (itemType === 'tool_call' || itemType === 'function_call') {
				// Tool start
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

				const callId = item.call_id || item.id || crypto.randomUUID();
				const rawName = item.name || item.function?.name || 'unknown';
				const toolName = CODEX_TOOL_NAME_MAP[rawName] || rawName;
				const input = item.arguments ? (typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments) : {};
				const status = formatToolStatus(toolName, input);

				console.log(`[Pixel Agents] Agent ${agentId} (codex) tool start: ${callId} ${status}`);
				agent.activeToolIds.add(callId);
				agent.activeToolStatuses.set(callId, status);
				agent.activeToolNames.set(callId, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}

				webview?.postMessage({
					type: 'agentToolStart',
					id: agentId,
					toolId: callId,
					status,
				});
			} else if (itemType === 'tool_result' || itemType === 'function_call_output') {
				// Tool done
				const callId = item.call_id || item.id || '';
				if (callId && agent.activeToolIds.has(callId)) {
					console.log(`[Pixel Agents] Agent ${agentId} (codex) tool done: ${callId}`);
					agent.activeToolIds.delete(callId);
					agent.activeToolStatuses.delete(callId);
					agent.activeToolNames.delete(callId);
					const toolId = callId;
					setTimeout(() => {
						webview?.postMessage({
							type: 'agentToolDone',
							id: agentId,
							toolId,
						});
					}, TOOL_DONE_DELAY_MS);

					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				}
			} else if (itemType === 'message' && !agent.hadToolsInTurn) {
				// Text message — use text-idle timer
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		} else if (eventType === 'turn.completed' || payloadType === 'turn.completed') {
			// Definitive turn end
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);

			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		} else if (eventType === 'user_message' || payloadType === 'user_message') {
			// New user prompt — new turn
			cancelWaitingTimer(agentId, waitingTimers);
			clearAgentActivity(agent, agentId, permissionTimers, webview);
			agent.hadToolsInTurn = false;
		}
	} catch {
		// Ignore malformed lines (metadata headers, etc.)
	}
}

// ── Gemini Transcript Parser ────────────────────────────────
// Gemini uses monolithic JSON files (not JSONL). When the file changes,
// we re-read and process only new messages. The fileWatcher sends us the
// raw content. For Gemini, we treat the entire file as a single "line" to parse.
//
// Gemini session JSON structure:
// { messages: [ { role: "user"|"model", parts: [ { text, functionCall, functionResponse } ] } ] }
//
// We track the message count and only process new messages.

function processGeminiTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const record = JSON.parse(line);

		// Gemini session files may have various structures
		// Try to identify tool calls in the content
		const messages = record.messages || record.history || [];
		if (!Array.isArray(messages)) return;

		// We use fileOffset as a message index counter for Gemini
		// (overloading the field since Gemini uses full re-reads)
		const lastProcessed = agent.fileOffset;
		if (messages.length <= lastProcessed) return;

		// Process only new messages
		for (let i = lastProcessed; i < messages.length; i++) {
			const msg = messages[i];
			const role = msg.role as string;
			const parts = msg.parts || msg.content || [];

			if (role === 'model' || role === 'gemini' || role === 'assistant') {
				if (!Array.isArray(parts)) continue;
				let hasToolCall = false;

				for (const part of parts) {
					if (part.functionCall) {
						hasToolCall = true;
						cancelWaitingTimer(agentId, waitingTimers);
						agent.isWaiting = false;
						agent.hadToolsInTurn = true;
						webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

						const callId = part.functionCall.id || `gemini-${crypto.randomUUID()}`;
						const rawName = part.functionCall.name || 'unknown';
						const args = part.functionCall.args || {};
						const status = formatToolStatus(rawName, args);

						console.log(`[Pixel Agents] Agent ${agentId} (gemini) tool start: ${callId} ${status}`);
						agent.activeToolIds.add(callId);
						agent.activeToolStatuses.set(callId, status);
						agent.activeToolNames.set(callId, rawName);

						webview?.postMessage({
							type: 'agentToolStart',
							id: agentId,
							toolId: callId,
							status,
						});

						startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
					} else if (part.functionResponse) {
						const callId = part.functionResponse.id || '';
						if (callId && agent.activeToolIds.has(callId)) {
							agent.activeToolIds.delete(callId);
							agent.activeToolStatuses.delete(callId);
							agent.activeToolNames.delete(callId);
							const toolId = callId;
							setTimeout(() => {
								webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
				}

				if (!hasToolCall && !agent.hadToolsInTurn) {
					startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
				}
			} else if (role === 'user') {
				// New user prompt — new turn
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
			}
		}

		// Update offset to track how many messages we've seen
		agent.fileOffset = messages.length;
	} catch {
		// Ignore parse errors
	}
}
