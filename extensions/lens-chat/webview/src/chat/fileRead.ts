import { fileBasename, languageBadge, languageId } from './fileChange';
import type { ChatPart } from './types';

export type ReadPreview = {
	kind: 'file' | 'directory';
	path: string;
	displayName: string;
	language: string;
	languageBadge?: string;
	text: string;
	entries: string[];
	truncated?: boolean;
	lineStart?: number;
	lineEnd?: number;
	totalLines?: number;
};

export function isReadTool(tool?: string): boolean {
	return tool === 'read' || tool === 'read_file' || tool === 'read_files';
}

export function isQuestionTool(tool?: string): boolean {
	return tool === 'question' || tool === 'ask_question' || tool === 'ask_followup_question';
}

export function readPreviewFromPart(part: ChatPart): ReadPreview | undefined {
	if (part.type !== 'tool' || !isReadTool(part.tool)) {
		return undefined;
	}
	const input = asRecord(part.state?.input);
	const meta = asRecord(part.state?.metadata);
	const display = asRecord(meta.display);
	const path = firstString(display.path, input.filePath, input.path, part.filename, part.state?.title);
	const kind = display.type === 'directory' || str(meta.type) === 'directory' ? 'directory' : 'file';
	if (kind === 'directory') {
		const entries = Array.isArray(display.entries)
			? display.entries.map(item => String(item)).filter(Boolean)
			: parseDirectoryEntries(str(part.state?.output));
		const dirPath = path || parseTagged(str(part.state?.output), 'path');
		if (!dirPath && !entries.length) {
			return undefined;
		}
		return {
			kind: 'directory',
			path: dirPath,
			displayName: fileBasename(dirPath) || dirPath || 'directory',
			language: 'plaintext',
			entries,
			truncated: display.truncated === true,
			text: entries.join('\n'),
		};
	}

	const rawText = firstString(display.text, meta.preview);
	const parsed = rawText || parseFileBody(str(part.state?.output));
	const filePath = path || parseTagged(str(part.state?.output), 'path');
	if (!filePath && !parsed) {
		return undefined;
	}
	const language = languageId(filePath);
	return {
		kind: 'file',
		path: filePath,
		displayName: fileBasename(filePath) || filePath || 'file',
		language: language === 'plaintext' && /\.(md|markdown)$/i.test(filePath) ? 'markdown' : language,
		languageBadge: languageBadge(filePath),
		text: parsed,
		entries: [],
		truncated: display.truncated === true,
		lineStart: num(display.lineStart),
		lineEnd: num(display.lineEnd),
		totalLines: num(display.totalLines),
	};
}

function parseFileBody(output: string): string {
	const content = parseTagged(output, 'content');
	const source = content || output;
	return source
		.split('\n')
		.map(line => line.replace(/^\d+: /, ''))
		.join('\n')
		.replace(/<\/?content>/g, '')
		.replace(/<path>[\s\S]*?<\/path>/g, '')
		.replace(/<type>[\s\S]*?<\/type>/g, '')
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
		.replace(/\(End of file[\s\S]*$/g, '')
		.replace(/\(Showing lines[\s\S]*$/g, '')
		.replace(/\(Output capped[\s\S]*$/g, '')
		.trim();
}

function parseDirectoryEntries(output: string): string[] {
	const entries = parseTagged(output, 'entries');
	if (!entries) {
		return [];
	}
	return entries
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('('));
}

function parseTagged(output: string, tag: string): string {
	const match = output.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
	return match?.[1]?.trim() ?? '';
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return '';
}
