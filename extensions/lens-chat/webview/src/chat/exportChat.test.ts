import { describe, expect, it } from 'vitest';
import { transcriptToMarkdown } from './exportChat';
import type { ChatMessage } from './types';

describe('transcriptToMarkdown', () => {
	it('renders a user/assistant exchange with a title heading', () => {
		const messages: ChatMessage[] = [
			{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello there' }] },
			{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hi, how can I help?' }] },
		];
		const markdown = transcriptToMarkdown('My chat', messages);
		expect(markdown).toBe('# My chat\n\n## You\n\nhello there\n\n## Lens\n\nhi, how can I help?\n');
	});

	it('falls back to a default title when none is given', () => {
		const markdown = transcriptToMarkdown('', [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }]);
		expect(markdown.startsWith('# Lens Chat\n')).toBe(true);
	});

	it('skips messages with no visible parts and synthetic text', () => {
		const messages: ChatMessage[] = [
			{ info: { role: 'user' }, parts: [{ type: 'text', text: 'attached file text', synthetic: true }] },
			{ info: { role: 'assistant' }, parts: [] },
			{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a reply' }] },
		];
		const markdown = transcriptToMarkdown('Chat', messages);
		expect(markdown).not.toContain('attached file text');
		expect(markdown).toBe('# Chat\n\n## Lens\n\na reply\n');
	});

	it('summarizes tool parts instead of dropping them', () => {
		const messages: ChatMessage[] = [
			{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }] },
		];
		const markdown = transcriptToMarkdown('Chat', messages);
		expect(markdown).toContain('_Ran');
	});
});
