// Pure rules for sharing editor context (the active file and its selection) with Lens Chat.
// Kept free of the vscode API so they can be unit-tested; editorContextTracker.ts does the I/O.
// Everything here decides what may leave the editor, so it errs on the side of excluding.

/** A 1-based, inclusive line range. */
export interface LineRange {
	readonly startLine: number;
	readonly endLine: number;
}

export interface Position {
	readonly line: number;
	readonly character: number;
}

/** Glob settings as VS Code stores them (`files.exclude`, `search.exclude`). */
export type ExcludeGlobs = Record<string, boolean | { when?: string } | null | undefined>;

/** The text of one .gitignore file and the folder it sits in, relative to the workspace root ('' for the root). */
export interface GitignoreFile {
	readonly dir: string;
	readonly content: string;
}

export interface ExclusionInputs {
	readonly filesExclude?: ExcludeGlobs;
	readonly searchExclude?: ExcludeGlobs;
	readonly gitignores?: readonly GitignoreFile[];
}

/** What the chat composer shows as a chip and sends as a prompt part. */
export interface EditorContextInfo {
	readonly kind: 'selection' | 'file';
	/** Workspace-relative path with forward slashes. */
	readonly path: string;
	/** `file://` URL of the file, with `?start=&end=` for a selection (the engine reads that range). */
	readonly url: string;
	/** Short label for the chip and the sent message, e.g. `math.ts:5-10`. */
	readonly label: string;
	readonly range?: LineRange;
}

// Names of files that hold secrets. Matched against the base name, case-insensitively.
const SECRET_FILE_NAMES = new Set([
	'.npmrc', '.netrc', '_netrc', '.pypirc', '.pgpass', '.git-credentials', '.htpasswd', '.dockercfg',
	'credentials', 'credentials.json', 'credentials.xml', 'secrets.json', 'secrets.yaml', 'secrets.yml',
	'.boto', '.s3cfg', 'authorized_keys', 'known_hosts',
]);
const SECRET_FILE_PREFIXES = ['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const SECRET_EXTENSIONS = [
	'.pem', '.key', '.p12', '.pfx', '.p8', '.jks', '.keystore', '.crt', '.cer', '.der', '.csr',
	'.gpg', '.pgp', '.kdbx', '.ppk', '.ovpn', '.tfvars', '.tfstate', '.env',
];
// Folders whose whole content is credentials or repository internals.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git']);

/** Normalizes a relative path to forward slashes without a leading `./` or `/`. */
export function normalizeRelativePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Whether a path names a secret or key file that Lens never shares, whatever the settings say. */
export function isSecretPath(relativePath: string): boolean {
	const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean);
	if (!segments.length) {
		return false;
	}
	const name = segments[segments.length - 1].toLowerCase();
	if (segments.slice(0, -1).some(segment => SECRET_DIRS.has(segment.toLowerCase()))) {
		return true;
	}
	if (SECRET_FILE_NAMES.has(name) || SECRET_FILE_PREFIXES.some(prefix => name.startsWith(prefix))) {
		return true;
	}
	return SECRET_EXTENSIONS.some(extension => name.endsWith(extension));
}

/**
 * Converts a glob (VS Code or gitignore flavour) to a regular expression over a whole relative path:
 * `*` and `?` stay inside one path segment, `**` spans segments, `{a,b}` and `[abc]` are supported.
 * Matching is case-insensitive, so a differently cased name cannot slip past an exclusion.
 */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === '*') {
			if (glob[i + 1] === '*') {
				const atSegmentStart = i === 0 || glob[i - 1] === '/';
				i++;
				if (glob[i + 1] === '/' && atSegmentStart) {
					// `**/` matches zero or more whole folders.
					i++;
					source += '(?:[^/]*/)*';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else if (char === '[') {
			const close = glob.indexOf(']', i + 1);
			if (close === -1) {
				source += '\\[';
			} else {
				let body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
				if (body.startsWith('!')) {
					body = '^' + body.slice(1);
				}
				source += `[${body}]`;
				i = close;
			}
		} else if (char === '{') {
			braceDepth++;
			source += '(?:';
		} else if (char === '}' && braceDepth > 0) {
			braceDepth--;
			source += ')';
		} else if (char === ',' && braceDepth > 0) {
			source += '|';
		} else if (char === '\\' && i + 1 < glob.length) {
			i++;
			source += escapeRegExp(glob[i]);
		} else {
			source += escapeRegExp(char);
		}
	}
	while (braceDepth-- > 0) {
		source += ')';
	}
	return new RegExp(`^${source}$`, 'i');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The path itself and each folder above it, shortest first: `a`, `a/b`, `a/b/c.ts`. */
function pathPrefixes(relativePath: string): string[] {
	const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean);
	return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Whether a `files.exclude` / `search.exclude` style setting hides the path. A pattern that matches
 * a folder hides everything inside it. Patterns with a `when` clause count as matching, since the
 * sibling they depend on cannot be checked here and excluding is the safe side.
 */
export function matchesExcludeGlobs(relativePath: string, globs: ExcludeGlobs | undefined): boolean {
	if (!globs) {
		return false;
	}
	const prefixes = pathPrefixes(relativePath);
	for (const [pattern, value] of Object.entries(globs)) {
		if (!value) {
			continue;
		}
		const regExp = globToRegExp(normalizeRelativePath(pattern));
		if (prefixes.some(prefix => regExp.test(prefix))) {
			return true;
		}
	}
	return false;
}

interface GitignoreRule {
	readonly regExp: RegExp;
	readonly negated: boolean;
	readonly dirOnly: boolean;
}

function parseGitignore(content: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		let line = rawLine.replace(/(?<!\\)\s+$/, '');
		if (!line || line.startsWith('#')) {
			continue;
		}
		let negated = false;
		if (line.startsWith('!')) {
			negated = true;
			line = line.slice(1);
		} else if (line.startsWith('\\!') || line.startsWith('\\#')) {
			line = line.slice(1);
		}
		const dirOnly = line.endsWith('/');
		line = line.replace(/\/+$/, '');
		if (!line) {
			continue;
		}
		// A slash anywhere but the end anchors the pattern to the .gitignore's folder;
		// otherwise it matches a name at any depth below it.
		const anchored = line.includes('/');
		line = line.replace(/^\/+/, '');
		rules.push({ regExp: globToRegExp(anchored ? line : `**/${line}`), negated, dirOnly });
	}
	return rules;
}

/**
 * Whether .gitignore files ignore the path, following git's rules: the last matching pattern wins,
 * `!` re-includes, a trailing `/` only matches folders, and nothing inside an ignored folder can be
 * re-included.
 */
export function isGitignored(relativePath: string, gitignores: readonly GitignoreFile[] | undefined): boolean {
	if (!gitignores?.length) {
		return false;
	}
	const parsed = gitignores.map(file => ({ dir: normalizeRelativePath(file.dir).replace(/\/+$/, ''), rules: parseGitignore(file.content) }));
	// Deeper .gitignore files override shallower ones.
	parsed.sort((a, b) => a.dir.split('/').filter(Boolean).length - b.dir.split('/').filter(Boolean).length);
	const prefixes = pathPrefixes(relativePath);
	for (let index = 0; index < prefixes.length; index++) {
		const prefix = prefixes[index];
		const isDir = index < prefixes.length - 1;
		let ignored = false;
		for (const { dir, rules } of parsed) {
			if (dir && !prefix.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) {
				continue;
			}
			const local = dir ? prefix.slice(dir.length + 1) : prefix;
			for (const rule of rules) {
				if (rule.dirOnly && !isDir) {
					continue;
				}
				if (rule.regExp.test(local)) {
					ignored = !rule.negated;
				}
			}
		}
		if (ignored) {
			return true;
		}
	}
	return false;
}

/**
 * Why a workspace file must not be shared with the model, or undefined when it may be.
 * Secret and key files are always excluded; the settings and .gitignore add to that list.
 */
export function exclusionReason(relativePath: string, inputs: ExclusionInputs): string | undefined {
	const path = normalizeRelativePath(relativePath);
	if (!path || path.split('/').includes('..')) {
		return 'it is outside the workspace';
	}
	if (isSecretPath(path)) {
		return 'it looks like a secret or key file';
	}
	if (matchesExcludeGlobs(path, inputs.filesExclude)) {
		return 'it matches files.exclude';
	}
	if (matchesExcludeGlobs(path, inputs.searchExclude)) {
		return 'it matches search.exclude';
	}
	if (isGitignored(path, inputs.gitignores)) {
		return 'it is ignored by .gitignore';
	}
	return undefined;
}

/**
 * The 1-based line range a selection covers, or undefined for an empty selection (a bare cursor).
 * A selection that ends at the very start of a line (as selecting whole lines with Shift+Down does)
 * does not include that last line.
 */
export function selectionLineRange(start: Position, end: Position): LineRange | undefined {
	const [from, to] = start.line < end.line || (start.line === end.line && start.character <= end.character) ? [start, end] : [end, start];
	if (from.line === to.line && from.character === to.character) {
		return undefined;
	}
	const lastLine = to.character === 0 && to.line > from.line ? to.line - 1 : to.line;
	return { startLine: from.line + 1, endLine: lastLine + 1 };
}

function rangeSuffix(range: LineRange): string {
	return range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
}

/** The composer mention for a file and optional range, e.g. `@src/math.ts#L5-10`. */
export function formatMention(relativePath: string, range?: LineRange): string {
	const path = normalizeRelativePath(relativePath);
	return range ? `@${path}#L${rangeSuffix(range)}` : `@${path}`;
}

/** Builds the chip and prompt-part description for a file (and its selection, if any). */
export function editorContextInfo(relativePath: string, fileUrl: string, range?: LineRange): EditorContextInfo {
	const path = normalizeRelativePath(relativePath);
	const name = path.split('/').pop() ?? path;
	const base = fileUrl.split(/[?#]/)[0];
	if (range) {
		return { kind: 'selection', path, url: `${base}?start=${range.startLine}&end=${range.endLine}`, label: `${name}:${rangeSuffix(range)}`, range };
	}
	return { kind: 'file', path, url: base, label: name };
}
