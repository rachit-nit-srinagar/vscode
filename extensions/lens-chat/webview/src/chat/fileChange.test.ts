import { describe, expect, it } from 'vitest';
import { fileChangesFromPart, parseUnifiedDiff, previewLines } from './fileChange';
import type { ChatPart } from './types';

// What the engine's write/edit tools send: jsdiff's createTwoFilesPatch with absolute paths.
const ABS = '/home/someone/work/project/src/notes.txt';
const ENGINE_DIFF = [
	`Index: ${ABS}`,
	'===================================================================',
	`--- ${ABS}`,
	`+++ ${ABS}`,
	'@@ -1,2 +1,3 @@',
	' first',
	'-second',
	'+second changed',
	'+third',
	'',
].join('\n');

function visibleText(diff: string): string[] {
	return previewLines(parseUnifiedDiff(diff).lines, true).shown.map(line => line.text);
}

describe('parseUnifiedDiff', () => {
	it('treats the Index / ==== / --- / +++ header as meta, so the preview starts at the hunk', () => {
		const shown = visibleText(ENGINE_DIFF);
		expect(shown[0]).toBe('@@ -1,2 +1,3 @@');
		expect(shown).toEqual(['@@ -1,2 +1,3 @@', 'first', 'second', 'second changed', 'third']);
		expect(shown.join('\n')).not.toContain('Index:');
		expect(shown.join('\n')).not.toContain('====');
		expect(shown.join('\n')).not.toContain(ABS);
	});

	it('counts additions and deletions only from the hunk body', () => {
		const parsed = parseUnifiedDiff(ENGINE_DIFF);
		expect(parsed.additions).toBe(2);
		expect(parsed.deletions).toBe(1);
		expect(parsed.addedLines).toEqual([2, 3]);
	});

	it('handles headers with tab-separated timestamps and CRLF', () => {
		const diff = `Index: ${ABS}\r\n====\r\n--- ${ABS}\told\r\n+++ ${ABS}\tnew\r\n@@ -0,0 +1 @@\r\n+hello\r\n`;
		expect(visibleText(diff)).toEqual(['@@ -0,0 +1 @@', 'hello']);
	});

	it('keeps a deleted SQL comment inside a hunk as a deletion, not a header', () => {
		const diff = ['--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,1 @@', '-- comment', '--- banner', ' select 1'].join('\n');
		const parsed = parseUnifiedDiff(diff);
		expect(parsed.deletions).toBe(2);
		expect(visibleText(diff)).toEqual(['@@ -1,2 +1,1 @@', '- comment', '-- banner', 'select 1']);
	});

	it('hides the header of every file in a multi-file patch', () => {
		const diff = [
			'Index: /abs/a.ts', '====', '--- /abs/a.ts', '+++ /abs/a.ts', '@@ -1 +1 @@', '-a', '+A',
			'Index: /abs/b.ts', '====', '--- /abs/b.ts', '+++ /abs/b.ts', '@@ -1 +1 @@', '-b', '+B',
		].join('\n');
		const shown = visibleText(diff).join('\n');
		expect(shown).not.toContain('/abs/');
		expect(shown).not.toContain('====');
		expect(parseUnifiedDiff(diff).additions).toBe(2);
	});

	it('leaves header-less synthesized diffs untouched', () => {
		expect(visibleText('@@ -0,0 +1,2 @@\n+one\n+two')).toEqual(['@@ -0,0 +1,2 @@', 'one', 'two']);
	});
});

describe('fileChangesFromPart', () => {
	it('names the file once in the header and keeps absolute paths out of the preview', () => {
		const part: ChatPart = {
			type: 'tool',
			tool: 'write',
			state: {
				status: 'completed',
				input: { filePath: ABS, content: 'first\nsecond changed\nthird\n' },
				metadata: { filepath: ABS, diff: ENGINE_DIFF, exists: true },
			},
		} as ChatPart;
		const [change] = fileChangesFromPart(part);
		expect(change.displayName).toBe('notes.txt');
		expect(change.additions).toBe(2);
		expect(change.deletions).toBe(1);
		const shown = previewLines(change.lines, false).shown.map(line => line.text).join('\n');
		expect(shown).not.toContain('Index:');
		expect(shown).not.toContain(ABS);
	});

	it('falls back to the patch header for the file name when the tool gave no path', () => {
		const part: ChatPart = {
			type: 'tool',
			tool: 'patch',
			state: { status: 'completed', input: {}, metadata: { diff: ENGINE_DIFF } },
		} as ChatPart;
		const [change] = fileChangesFromPart(part);
		expect(change.displayName).toBe('notes.txt');
	});
});
