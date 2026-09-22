import type { ChatPart } from './types';

const BUILTIN_TOOLS = new Set([
	'bash',
	'read',
	'read_file',
	'read_files',
	'write',
	'edit',
	'patch',
	'apply_patch',
	'apply-patch',
	'grep',
	'glob',
	'list',
	'webfetch',
	'websearch',
	'todowrite',
	'todoread',
	'task',
	'question',
	'ask_question',
	'ask_followup_question',
	'execute',
	'list_mcp_resources',
	'list_mcp_resource_templates',
	'read_mcp_resource',
]);

const OUTPUT_LIMIT = 1200;

export type ParsedMcpToolName = {
	raw: string;
	server?: string;
	tool: string;
	isMcp: boolean;
};

export type ToolCardStatusKind = 'pending' | 'running' | 'completed' | 'error';

export type ToolCardStatus = {
	kind: ToolCardStatusKind;
	label: string;
};

export type AssistantPartGroup =
	| { kind: 'tools'; parts: ChatPart[] }
	| { kind: 'part'; part: ChatPart };

/**
 * Decode opencode MCP tool ids `{SanitizedServer}_{tool}`.
 * `Example Docs` + `search_example_docs` → `Example_Docs_search_example_docs`.
 */
export function parseMcpToolName(raw?: string): ParsedMcpToolName {
	const name = (raw ?? '').trim();
	if (!name) {
		return { raw: 'tool', tool: 'tool', isMcp: false };
	}
	if (BUILTIN_TOOLS.has(name) || !name.includes('_')) {
		return { raw: name, tool: name, isMcp: false };
	}

	const tokens = name.split('_').filter(Boolean);
	if (tokens.length < 2) {
		return { raw: name, tool: name, isMcp: true };
	}

	let splitAt = 0;
	while (splitAt < tokens.length - 1 && /^[A-Z]/.test(tokens[splitAt] ?? '')) {
		splitAt += 1;
	}
	if (splitAt === 0) {
		splitAt = 1;
	}

	const serverRaw = tokens.slice(0, splitAt).join('_');
	const tool = tokens.slice(splitAt).join('_') || name;
	return {
		raw: name,
		server: humanizeServerName(serverRaw),
		tool,
		isMcp: true,
	};
}

export function humanizeServerName(server: string): string {
	return server.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function toolCardStatus(status?: string): ToolCardStatus {
	switch (status) {
		case 'pending':
			return { kind: 'pending', label: 'Pending' };
		case 'running':
			return { kind: 'running', label: 'Running' };
		case 'completed':
			return { kind: 'completed', label: 'Completed' };
		case 'error':
			return { kind: 'error', label: 'Error' };
		case 'aborted':
		case 'rejected':
		case 'cancelled':
		case 'canceled':
			return { kind: 'error', label: 'Error' };
		default:
			if (!status) {
				return { kind: 'completed', label: 'Completed' };
			}
			return { kind: 'completed', label: titleCase(status) };
	}
}

export function toolCallHeading(raw?: string): { server?: string; tool: string; isMcp: boolean; label: string } {
	const parsed = parseMcpToolName(raw);
	if (parsed.isMcp && parsed.server) {
		return {
			server: parsed.server,
			tool: parsed.tool,
			isMcp: true,
			label: `${parsed.server} → ${parsed.tool}`,
		};
	}
	return { tool: parsed.tool, isMcp: parsed.isMcp, label: parsed.tool };
}

export function toolInputSummary(part: ChatPart): string {
	const input = part.state?.input ?? {};
	const value = firstString(
		input.query,
		input.q,
		input.pattern,
		input.path,
		input.filePath,
		input.file,
		input.uri,
		input.url,
		input.command,
		input.description,
		part.state?.title,
	);
	return value;
}

export function toolOutputPreview(output: string, maxChars = OUTPUT_LIMIT): { text: string; truncated: boolean } {
	const normalized = normalizeToolOutput(output);
	if (!normalized) {
		return { text: '', truncated: false };
	}
	if (normalized.length <= maxChars) {
		return { text: normalized, truncated: false };
	}
	return { text: `${normalized.slice(0, maxChars).replace(/\s+$/, '')}\n…`, truncated: true };
}

export function groupAssistantParts(parts: ChatPart[]): AssistantPartGroup[] {
	const groups: AssistantPartGroup[] = [];
	for (const part of parts) {
		if (isToolishPart(part)) {
			const last = groups[groups.length - 1];
			if (last?.kind === 'tools') {
				last.parts.push(part);
			} else {
				groups.push({ kind: 'tools', parts: [part] });
			}
			continue;
		}
		groups.push({ kind: 'part', part });
	}
	return groups;
}

export function isToolishPart(part: ChatPart): boolean {
	return part.type === 'tool' || part.type === 'subtask';
}

function normalizeToolOutput(output: string): string {
	const trimmed = output.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const extracted = extractMcpText(parsed);
		if (extracted) {
			return extracted;
		}
		return JSON.stringify(parsed, null, 2);
	} catch {
		return output;
	}
}

function extractMcpText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const inner = value.trim();
		if ((inner.startsWith('{') || inner.startsWith('[')) && inner.length > 1) {
			try {
				return extractMcpText(JSON.parse(inner)) ?? value;
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		const texts = value
			.map(item => {
				if (item && typeof item === 'object' && 'text' in item) {
					return String((item as { text?: unknown }).text ?? '').trim();
				}
				if (typeof item === 'string') {
					return item.trim();
				}
				return '';
			})
			.filter(Boolean);
		return texts.length ? texts.join('\n\n') : undefined;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (record.content !== undefined) {
			return extractMcpText(record.content);
		}
		if (typeof record.text === 'string') {
			return record.text;
		}
		if (typeof record.output === 'string') {
			return extractMcpText(record.output) ?? record.output;
		}
	}
	return undefined;
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return '';
}

function titleCase(value: string): string {
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
