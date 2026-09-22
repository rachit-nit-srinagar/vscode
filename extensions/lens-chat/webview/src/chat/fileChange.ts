import type { ChatPart } from './types';

export const FILE_CHANGE_TOOLS = new Set(['write', 'edit', 'patch', 'apply_patch', 'apply-patch']);

const PREVIEW_LIMIT = 12;
const PREVIEW_EXPANDED_LIMIT = 80;

const LANGUAGE_BADGE: Record<string, string> = {
	ts: 'TS',
	tsx: 'TS',
	js: 'JS',
	jsx: 'JS',
	mjs: 'JS',
	cjs: 'JS',
	py: 'PY',
	go: 'GO',
	rs: 'RS',
	md: 'MD',
	markdown: 'MD',
	json: 'JSON',
	css: 'CSS',
	scss: 'SCSS',
	html: 'HTML',
	htm: 'HTML',
	yml: 'YML',
	yaml: 'YML',
	sh: 'SH',
	bash: 'SH',
	zsh: 'SH',
	java: 'JAVA',
	kt: 'KT',
	cs: 'CS',
	sql: 'SQL',
	toml: 'TOML',
	vue: 'VUE',
	rb: 'RB',
	php: 'PHP',
	swift: 'SWIFT',
	c: 'C',
	h: 'H',
	cpp: 'C++',
	cc: 'C++',
	cxx: 'C++',
	xml: 'XML',
	svg: 'SVG',
	txt: 'TXT',
};

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export type DiffLine = {
	kind: DiffLineKind;
	text: string;
	marker: string;
	lineNumber?: number;
};

export type FileChange = {
	path: string;
	displayName: string;
	languageBadge?: string;
	language: string;
	additions: number;
	deletions: number;
	diff: string;
	lines: DiffLine[];
	addedLines: number[];
	isNew: boolean;
	deleted: boolean;
	label: string;
};

export function isFileChangeTool(tool?: string): boolean {
	return !!tool && FILE_CHANGE_TOOLS.has(tool);
}

export function fileChangesFromPart(part: ChatPart): FileChange[] {
	if (part.type !== 'tool' || !isFileChangeTool(part.tool)) {
		return [];
	}
	const input = asRecord(part.state?.input);
	const meta = asRecord(part.state?.metadata);
	const tool = part.tool || '';
	const files = Array.isArray(meta.files) ? meta.files : [];
	if (files.length) {
		return files.map(file => fromApplyPatchFile(file, tool)).filter((change): change is FileChange => !!change);
	}

	const path = firstString(
		meta.filepath,
		asRecord(meta.filediff)?.file,
		input.filePath,
		input.path,
		part.filename,
		part.state?.title,
	);
	if (tool === 'write') {
		const content = str(input.content);
		const exists = meta.exists === true;
		const diff = firstString(meta.diff, asRecord(meta.filediff)?.patch) || synthesizeAdditionDiff(content);
		return [toFileChange({
			path,
			tool,
			diff,
			additions: num(asRecord(meta.filediff)?.additions),
			deletions: num(asRecord(meta.filediff)?.deletions),
			isNew: !exists,
			fallbackLabel: exists ? 'Edited file' : 'Wrote file',
		})];
	}

	if (tool === 'edit') {
		const patch = firstString(meta.diff, asRecord(meta.filediff)?.patch)
			|| synthesizeEditDiff(str(input.oldString), str(input.newString));
		return [toFileChange({
			path: path || pathFromPatch(patch),
			tool,
			diff: patch,
			additions: num(asRecord(meta.filediff)?.additions),
			deletions: num(asRecord(meta.filediff)?.deletions),
			isNew: false,
			fallbackLabel: 'Edited file',
		})];
	}

	const patch = firstString(meta.diff, input.patchText, input.patch);
	const fromPatch = path || pathFromPatch(patch);
	if (!fromPatch && !patch) {
		return [];
	}
	return [toFileChange({
		path: fromPatch,
		tool,
		diff: patch,
		isNew: false,
		fallbackLabel: 'Edited file',
	})];
}

export function previewLines(lines: DiffLine[], expanded: boolean): { shown: DiffLine[]; hidden: number } {
	const visible = lines.filter(line => line.kind !== 'meta');
	const limit = expanded ? PREVIEW_EXPANDED_LIMIT : PREVIEW_LIMIT;
	if (visible.length <= PREVIEW_LIMIT) {
		return { shown: visible, hidden: 0 };
	}
	if (!expanded) {
		return { shown: visible.slice(0, PREVIEW_LIMIT), hidden: visible.length - PREVIEW_LIMIT };
	}
	if (visible.length <= limit) {
		return { shown: visible, hidden: 0 };
	}
	return { shown: visible.slice(0, limit), hidden: visible.length - limit };
}

export function fileBasename(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	return parts.at(-1) || filePath;
}

function fromApplyPatchFile(raw: unknown, tool: string): FileChange | undefined {
	const file = asRecord(raw);
	if (!file) {
		return undefined;
	}
	const path = firstString(file.filePath, file.relativePath, file.file, file.movePath);
	if (!path) {
		return undefined;
	}
	const kind = str(file.type);
	const patch = firstString(file.patch, file.diff);
		return toFileChange({
			path,
			tool,
			diff: patch,
			additions: num(file.additions),
			deletions: num(file.deletions),
			isNew: kind === 'add',
			deleted: kind === 'delete',
			fallbackLabel: kind === 'add' ? 'Wrote file' : kind === 'delete' ? 'Deleted file' : 'Edited file',
		});
}

function toFileChange(args: {
	path: string;
	tool: string;
	diff: string;
	additions?: number;
	deletions?: number;
	isNew: boolean;
	deleted?: boolean;
	fallbackLabel: string;
}): FileChange {
	const parsed = parseUnifiedDiff(args.diff);
	const additions = args.additions && args.additions > 0 ? args.additions : parsed.additions;
	const deletions = args.deletions && args.deletions > 0 ? args.deletions : parsed.deletions;
	const displayName = fileBasename(args.path) || 'file';
	return {
		path: args.path,
		displayName,
		languageBadge: languageBadge(args.path),
		language: languageId(args.path),
		additions,
		deletions,
		diff: args.diff,
		lines: parsed.lines,
		addedLines: parsed.addedLines,
		isNew: args.isNew,
		deleted: !!args.deleted,
		label: args.fallbackLabel,
	};
}

export function parseUnifiedDiff(diff: string): { lines: DiffLine[]; additions: number; deletions: number; addedLines: number[] } {
	const lines: DiffLine[] = [];
	const addedLines: number[] = [];
	if (!diff) {
		return { lines, additions: 0, deletions: 0, addedLines };
	}
	let additions = 0;
	let deletions = 0;
	let newLine = 0;
	let oldLine = 0;
	for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
		if (raw.startsWith('@@')) {
			const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				oldLine = Number(match[1]);
				newLine = Number(match[2]);
			}
			lines.push({ kind: 'hunk', text: raw, marker: '' });
			continue;
		}
		if (
			raw.startsWith('diff ')
			|| raw.startsWith('index ')
			|| raw.startsWith('--- ')
			|| raw.startsWith('+++ ')
			|| raw.startsWith('new file')
			|| raw.startsWith('deleted file')
			|| raw.startsWith('similarity ')
			|| raw.startsWith('rename ')
		) {
			lines.push({ kind: 'meta', text: raw, marker: '' });
			continue;
		}
		if (raw.startsWith('\\')) {
			continue;
		}
		if (raw.startsWith('+')) {
			additions += 1;
			if (newLine > 0) {
				addedLines.push(newLine);
			}
			lines.push({ kind: 'add', text: raw.slice(1), marker: '+', lineNumber: newLine || undefined });
			newLine += 1;
			continue;
		}
		if (raw.startsWith('-')) {
			deletions += 1;
			lines.push({ kind: 'del', text: raw.slice(1), marker: '-', lineNumber: oldLine || undefined });
			oldLine += 1;
			continue;
		}
		const text = raw.startsWith(' ') ? raw.slice(1) : raw;
		lines.push({ kind: 'ctx', text, marker: raw.startsWith(' ') ? ' ' : '', lineNumber: newLine || undefined });
		if (newLine > 0) {
			newLine += 1;
		}
		if (oldLine > 0) {
			oldLine += 1;
		}
	}
	return { lines, additions, deletions, addedLines };
}

function synthesizeAdditionDiff(content: string): string {
	if (!content) {
		return '';
	}
	const lines = content.split('\n');
	if (lines.length && lines.at(-1) === '') {
		lines.pop();
	}
	if (!lines.length) {
		return '';
	}
	const body = lines.map(line => `+${line}`).join('\n');
	return `@@ -0,0 +1,${lines.length} @@\n${body}`;
}

function synthesizeEditDiff(oldString: string, newString: string): string {
	if (!oldString && !newString) {
		return '';
	}
	const removed = oldString ? oldString.split('\n').map(line => `-${line}`).join('\n') : '';
	const added = newString ? newString.split('\n').map(line => `+${line}`).join('\n') : '';
	const hunks = [removed, added].filter(Boolean).join('\n');
	return `@@ -1 +1 @@\n${hunks}`;
}

function pathFromPatch(patch: string): string {
	const plus = patch.match(/^\+\+\+ [ab]\/(.+)$/m);
	if (plus?.[1] && plus[1] !== '/dev/null') {
		return plus[1].trim();
	}
	const minus = patch.match(/^--- [ab]\/(.+)$/m);
	if (minus?.[1] && minus[1] !== '/dev/null') {
		return minus[1].trim();
	}
	const addFile = patch.match(/\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
	return addFile?.[1]?.trim() ?? '';
}

export function languageBadge(filePath: string): string | undefined {
	const ext = extensionOf(filePath);
	return ext ? LANGUAGE_BADGE[ext] : undefined;
}

export function languageId(filePath: string): string {
	const ext = extensionOf(filePath);
	const map: Record<string, string> = {
		ts: 'typescript',
		tsx: 'typescript',
		js: 'javascript',
		jsx: 'javascript',
		mjs: 'javascript',
		cjs: 'javascript',
		py: 'python',
		json: 'json',
		yml: 'yaml',
		yaml: 'yaml',
		md: 'markdown',
		markdown: 'markdown',
		css: 'css',
		html: 'xml',
		svg: 'xml',
		xml: 'xml',
		go: 'go',
		rs: 'rust',
		java: 'java',
		cs: 'csharp',
		sql: 'sql',
		sh: 'bash',
		bash: 'bash',
		zsh: 'bash',
		toml: 'ini',
	};
	return (ext && map[ext]) || 'plaintext';
}

function extensionOf(filePath: string): string {
	const base = fileBasename(filePath).toLowerCase();
	if (base === 'dockerfile') {
		return 'dockerfile';
	}
	const dot = base.lastIndexOf('.');
	return dot >= 0 ? base.slice(dot + 1) : '';
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return '';
}
