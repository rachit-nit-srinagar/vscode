import { languageId } from './fileChange';
import { parseMcpToolName } from './mcpTool';
import type { ChatPart, TodoItem } from './types';

const DEFAULT_TITLE = /^(New session|Child session) - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
// Snapshot `patch` parts are `{ hash, files: string[] }` with no diff. File cards
// come from write/edit/apply_patch tool parts instead, so these stay hidden.
const HIDDEN_PARTS = new Set(['step-start', 'step-finish', 'snapshot', 'patch']);

export function formatSessionTitle(title?: string): string {
	if (!title) {
		return 'Chat';
	}
	const match = title.match(DEFAULT_TITLE);
	if (!match) {
		return title;
	}
	const date = new Date(match[2]);
	if (Number.isNaN(date.getTime())) {
		return match[1];
	}
	const formatted = date.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
	return `${match[1]} - ${formatted}`;
}

export function isVisiblePart(part: ChatPart): boolean {
	if (HIDDEN_PARTS.has(part.type)) {
		return false;
	}
	if (part.type === 'text' && !part.text?.trim()) {
		return false;
	}
	if (part.type === 'reasoning' && !part.text?.trim()) {
		return false;
	}
	return true;
}

export function messageRole(message: { info?: { role?: string }; role?: string }): 'user' | 'assistant' {
	return message.info?.role === 'user' || message.role === 'user' ? 'user' : 'assistant';
}

export function isCancelledStatus(status?: string): boolean {
	return status === 'error' || status === 'aborted' || status === 'rejected' || status === 'cancelled' || status === 'canceled';
}

export function isActiveStatus(status?: string): boolean {
	return status === 'running' || status === 'pending';
}

export function toolLabel(tool: string, status?: string): string {
	const running = isActiveStatus(status);
	const failed = isCancelledStatus(status);
	switch (tool) {
		case 'bash':
			return failed ? 'Command failed' : running ? 'Running command' : 'Ran command';
		case 'read':
			return running ? 'Reading file' : 'Read file';
		case 'write':
			return running ? 'Writing file' : 'Wrote file';
		case 'edit':
			return running ? 'Editing file' : 'Edited file';
		case 'grep':
			return running ? 'Searching' : 'Searched files';
		case 'glob':
			return running ? 'Finding files' : 'Found files';
		case 'list':
			return running ? 'Listing files' : 'Listed files';
		case 'webfetch':
			return running ? 'Fetching URL' : 'Fetched URL';
		case 'todowrite':
		case 'todoread':
			return running ? 'Updating plan' : 'Updated plan';
		case 'task':
			return running ? 'Running task' : 'Task';
		case 'question':
		case 'ask_question':
		case 'ask_followup_question':
			return failed ? 'Question cancelled' : running ? 'Asking a question' : 'Asked a question';
		default: {
			const parsed = parseMcpToolName(tool);
			const label = parsed.isMcp && parsed.server ? parsed.tool : tool;
			return running ? `Running ${label}` : failed ? `${label} failed` : label;
		}
	}
}

export function statusLabel(status?: string): string {
	switch (status) {
		case 'running':
			return 'Running';
		case 'pending':
			return 'Pending';
		case 'completed':
			return 'Completed';
		case 'error':
			return 'Error';
		default:
			return status ? status : '';
	}
}

export function toolTarget(part: ChatPart): string {
	const input = part.state?.input ?? {};
	const value = input.command
		?? input.filePath
		?? input.path
		?? input.pattern
		?? input.url
		?? input.description
		?? part.filename
		?? part.state?.title
		?? '';
	return String(value);
}

export function toolOutput(part: ChatPart): string {
	const state = part.state;
	if (!state) {
		return '';
	}
	if (state.status === 'error') {
		return String(state.error ?? state.output ?? '');
	}
	const meta = state.metadata ?? {};
	const value = state.output ?? meta.output ?? meta.stdout ?? meta.preview ?? '';
	return String(value);
}

export function toolLanguage(part: ChatPart): string {
	if (part.tool === 'bash') {
		return 'bash';
	}
	const path = String(part.state?.input?.filePath ?? part.state?.input?.path ?? part.filename ?? '');
	if (!path) {
		return 'plaintext';
	}
	const language = languageId(path);
	if (language === 'plaintext' && /\.(md|markdown)$/i.test(path)) {
		return 'markdown';
	}
	return language;
}

export function asTodos(part: ChatPart): TodoItem[] {
	const raw = part.state?.input?.todos;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((item): item is TodoItem => !!item && typeof item === 'object' && typeof (item as TodoItem).content === 'string');
}

export function lineCount(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split('\n').length;
}

export function shortPath(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length <= 2) {
		return path;
	}
	return parts.slice(-2).join('/');
}
