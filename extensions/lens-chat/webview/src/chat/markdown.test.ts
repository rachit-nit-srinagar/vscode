import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders headings, emphasis, lists, tables, and links as HTML', () => {
		const html = renderMarkdown([
			'## Data modeling best practices',
			'',
			'Use a **layered architecture**.',
			'',
			'- Keep models stable',
			'- Separate contextual data',
			'',
			'| Layer | Purpose |',
			'| --- | --- |',
			'| Enterprise | Shared types |',
			'| Solution | Use-case views |',
			'',
			'See [Example Docs](https://docs.example.com).',
		].join('\n'));

		expect(html).toContain('<h2>');
		expect(html).toContain('Data modeling best practices');
		expect(html).toContain('<strong>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<table>');
		expect(html).toContain('Enterprise');
		expect(html).toContain('href="https://docs.example.com"');
		expect(html).toContain('target="_blank"');
		expect(html).not.toContain('## Data modeling');
		expect(html).not.toContain('| Layer |');
	});

	it('escapes raw HTML instead of executing it', () => {
		const html = renderMarkdown('Hello <script>alert(1)</script> **world**');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('<strong>world</strong>');
	});

	it('still renders documents that contain links', () => {
		const html = renderMarkdown('See [Example Docs](https://docs.example.com/guide) for **details**.');
		expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="https://docs.example.com/guide">');
		expect(html).toContain('<strong>details</strong>');
		expect(html).not.toContain('**details**');
	});

	it('renders markdown images as clickable thumbnails', () => {
		const html = renderMarkdown('![login](https://example.com/cursor-login.png)');
		expect(html).toContain('src="https://example.com/cursor-login.png"');
		expect(html).toContain('alt="login"');
		expect(html).toContain('class="lens-image-thumb"');
		expect(html).toContain('role="button"');
		expect(html).toContain('tabindex="0"');
	});
});
