import { describe, expect, test } from 'vitest';
import { editorContextInfo, exclusionReason, formatMention, globToRegExp, isGitignored, isSecretPath, matchesExcludeGlobs, selectionLineRange } from './editorContext';

describe('isSecretPath', () => {
	test.each([
		'.env', '.env.local', 'config/.env.production', '.envrc', 'app.env',
		'certs/server.pem', 'server.key', 'store.p12', 'store.pfx', 'release.jks',
		'id_rsa', 'id_rsa.pub', 'keys/id_ed25519', '.npmrc', '.netrc', '.pypirc', '.git-credentials',
		'home/.ssh/config', '.aws/credentials', '.git/config', 'SERVER.PEM', '.ENV',
	])('%s is a secret', path => {
		expect(isSecretPath(path)).toBe(true);
	});

	test.each(['src/math.ts', 'README.md', 'environment.ts', 'src/keyboard.ts', 'docs/env.md', 'keys.ts'])('%s is not a secret', path => {
		expect(isSecretPath(path)).toBe(false);
	});
});

describe('globToRegExp', () => {
	test('stars stay within a segment, double stars span them', () => {
		expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
		expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
		expect(globToRegExp('**/*.ts').test('src/deep/a.ts')).toBe(true);
		expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
		expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
	});

	test('braces, character classes and question marks', () => {
		expect(globToRegExp('**/*.{js,map}').test('out/a.map')).toBe(true);
		expect(globToRegExp('**/*.{js,map}').test('out/a.ts')).toBe(false);
		expect(globToRegExp('file[0-9].txt').test('file7.txt')).toBe(true);
		expect(globToRegExp('a?c').test('abc')).toBe(true);
		expect(globToRegExp('a?c').test('a/c')).toBe(false);
	});
});

describe('matchesExcludeGlobs', () => {
	test('a folder pattern hides the files inside it', () => {
		expect(matchesExcludeGlobs('node_modules/x/index.js', { '**/node_modules': true })).toBe(true);
		expect(matchesExcludeGlobs('src/node_modules/x.js', { '**/node_modules': true })).toBe(true);
	});

	test('disabled patterns are ignored and when clauses count as excluded', () => {
		expect(matchesExcludeGlobs('src/a.ts', { '**/*.ts': false })).toBe(false);
		expect(matchesExcludeGlobs('src/a.js', { '**/*.js': { when: '$(basename).ts' } })).toBe(true);
		expect(matchesExcludeGlobs('src/a.ts', undefined)).toBe(false);
	});
});

describe('isGitignored', () => {
	const root = { dir: '', content: '# comment\nbuild/\n*.log\n!keep.log\n/secret.txt\ndocs/private\n' };

	test('names match at any depth, anchored patterns only at their folder', () => {
		expect(isGitignored('a/b/debug.log', [root])).toBe(true);
		expect(isGitignored('keep.log', [root])).toBe(false);
		expect(isGitignored('secret.txt', [root])).toBe(true);
		expect(isGitignored('src/secret.txt', [root])).toBe(false);
		expect(isGitignored('docs/private/a.md', [root])).toBe(true);
		expect(isGitignored('src/math.ts', [root])).toBe(false);
	});

	test('folder-only patterns match folders, not files, and ignored folders cannot be re-included', () => {
		expect(isGitignored('build/out.js', [root])).toBe(true);
		expect(isGitignored('build', [root])).toBe(false);
		expect(isGitignored('build/keep.log', [root])).toBe(true);
	});

	test('a nested .gitignore applies below its folder and overrides the root one', () => {
		const nested = { dir: 'pkg', content: 'generated.ts\n!important.log\n' };
		expect(isGitignored('pkg/generated.ts', [root, nested])).toBe(true);
		expect(isGitignored('generated.ts', [root, nested])).toBe(false);
		expect(isGitignored('pkg/important.log', [nested, root])).toBe(false);
	});
});

describe('exclusionReason', () => {
	test('secrets are excluded even with no settings', () => {
		expect(exclusionReason('.env', {})).toMatch(/secret/);
		expect(exclusionReason('src/math.ts', {})).toBeUndefined();
	});

	test('settings and .gitignore each exclude', () => {
		expect(exclusionReason('dist/a.js', { filesExclude: { dist: true } })).toMatch(/files\.exclude/);
		expect(exclusionReason('dist/a.js', { searchExclude: { '**/dist': true } })).toMatch(/search\.exclude/);
		expect(exclusionReason('tmp/a.ts', { gitignores: [{ dir: '', content: 'tmp/' }] })).toMatch(/gitignore/);
	});

	test('paths leaving the workspace are excluded', () => {
		expect(exclusionReason('../outside.ts', {})).toMatch(/outside/);
		expect(exclusionReason('', {})).toMatch(/outside/);
	});
});

describe('selectionLineRange', () => {
	test('an empty selection has no range', () => {
		expect(selectionLineRange({ line: 3, character: 2 }, { line: 3, character: 2 })).toBeUndefined();
	});

	test('lines are 1-based and a selection ending at column 0 stops at the line before', () => {
		expect(selectionLineRange({ line: 4, character: 0 }, { line: 10, character: 0 })).toEqual({ startLine: 5, endLine: 10 });
		expect(selectionLineRange({ line: 4, character: 0 }, { line: 9, character: 3 })).toEqual({ startLine: 5, endLine: 10 });
		expect(selectionLineRange({ line: 2, character: 1 }, { line: 2, character: 5 })).toEqual({ startLine: 3, endLine: 3 });
	});

	test('a backwards selection gives the same range', () => {
		expect(selectionLineRange({ line: 9, character: 3 }, { line: 4, character: 0 })).toEqual({ startLine: 5, endLine: 10 });
	});
});

describe('mentions and context parts', () => {
	test('formatMention', () => {
		expect(formatMention('src/math.ts', { startLine: 5, endLine: 10 })).toBe('@src/math.ts#L5-10');
		expect(formatMention('src\\math.ts', { startLine: 7, endLine: 7 })).toBe('@src/math.ts#L7');
		expect(formatMention('./src/math.ts')).toBe('@src/math.ts');
	});

	test('editorContextInfo', () => {
		expect(editorContextInfo('src/math.ts', 'file:///w/src/math.ts', { startLine: 2, endLine: 4 })).toEqual({
			kind: 'selection',
			path: 'src/math.ts',
			url: 'file:///w/src/math.ts?start=2&end=4',
			label: 'math.ts:2-4',
			range: { startLine: 2, endLine: 4 },
		});
		expect(editorContextInfo('src/math.ts', 'file:///w/src/math.ts')).toEqual({ kind: 'file', path: 'src/math.ts', url: 'file:///w/src/math.ts', label: 'math.ts' });
	});
});
