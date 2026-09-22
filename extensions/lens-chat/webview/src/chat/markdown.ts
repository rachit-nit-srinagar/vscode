import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked, Renderer } from 'marked';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('shell', bash);

const LANG_ALIASES: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	py: 'python',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	console: 'bash',
	yml: 'yaml',
	html: 'xml',
	htm: 'xml',
	svg: 'xml',
	vue: 'xml',
	cs: 'csharp',
	md: 'markdown',
	markdown: 'markdown',
	text: 'plaintext',
	txt: 'plaintext',
};

export function resolveLang(lang?: string): string {
	const raw = (lang ?? '').trim().toLowerCase().replace(/^\./, '');
	if (!raw) {
		return 'plaintext';
	}
	const mapped = LANG_ALIASES[raw] ?? raw;
	return hljs.getLanguage(mapped) ? mapped : 'plaintext';
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function highlightCode(code: string, lang?: string): string {
	const language = resolveLang(lang);
	if (language === 'plaintext' || !hljs.getLanguage(language)) {
		return escapeHtml(code);
	}
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(code);
	}
}

export function renderFencedCode(code: string, lang?: string): string {
	const language = resolveLang(lang);
	const label = (lang ?? '').trim() || language;
	const highlighted = highlightCode(code.replace(/\n$/, ''), lang);
	return `<div class="lens-codeblock"><div class="lens-codeblock-bar"><span class="lens-codeblock-lang">${escapeHtml(label)}</span><button type="button" class="lens-codeblock-copy" data-copy-code>Copy</button></div><pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre></div>`;
}

const renderer = new Renderer();
renderer.code = ({ text, lang }) => renderFencedCode(text, lang);
renderer.html = ({ text }) => escapeHtml(text);
renderer.table = function (token) {
	return `<div class="lens-md-table-wrap">${Renderer.prototype.table.call(this, token)}</div>`;
};
renderer.link = function (token) {
	const html = String(Renderer.prototype.link.call(this, token));
	return html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
};
renderer.image = function (token) {
	const html = String(Renderer.prototype.image.call(this, token));
	if (!html.startsWith('<img ')) {
		return html;
	}
	return html.replace('<img ', '<img class="lens-image-thumb" role="button" tabindex="0" ');
};

const marked = new Marked({
	gfm: true,
	breaks: true,
	renderer,
});

export function renderMarkdown(markdown: string): string {
	if (!markdown) {
		return '';
	}
	try {
		const html = marked.parse(markdown, { async: false });
		return typeof html === 'string' ? html : '';
	} catch {
		return `<p>${escapeHtml(markdown)}</p>`;
	}
}

export function rewriteAssistantMarkdown(markdown: string, reads: Array<{ language: string; text: string }>): string {
	if (!markdown) {
		return '';
	}
	return markdown.replace(/^```([^\n]*)\n([\s\S]*?)^```/gm, (full, lang: string, body: string) => {
		const rawLang = (lang ?? '').trim().toLowerCase();
		const unlabeled = !rawLang || rawLang === 'plaintext' || rawLang === 'text' || rawLang === 'txt';
		const matched = reads.find(read => fenceMatches(body, read.text));
		if (matched) {
			return '';
		}
		if (unlabeled && reads.length === 1 && reads[0]?.language && reads[0].language !== 'plaintext') {
			return `\`\`\`${reads[0].language}\n${body}\`\`\``;
		}
		return full;
	});
}

function fenceMatches(body: string, fileText: string): boolean {
	const a = normalizeFence(body);
	const b = normalizeFence(fileText);
	if (!a || !b || a.length < 20) {
		return false;
	}
	if (a === b) {
		return true;
	}
	const shorter = a.length <= b.length ? a : b;
	const longer = a.length <= b.length ? b : a;
	return longer.includes(shorter) && shorter.length / longer.length > 0.6;
}

function normalizeFence(value: string): string {
	return value
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(line => line.replace(/^\d+: /, ''))
		.join('\n')
		.trim();
}

export function handleCodeCopyClick(event: MouseEvent): void {
	const button = (event.target as HTMLElement | null)?.closest?.('[data-copy-code]') as HTMLButtonElement | null;
	if (!button) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const block = button.closest('.lens-codeblock');
	const text = block?.querySelector('pre code')?.textContent ?? '';
	if (!text) {
		return;
	}
	void navigator.clipboard.writeText(text).then(() => {
		const previous = button.textContent;
		button.textContent = 'Copied';
		window.setTimeout(() => {
			button.textContent = previous || 'Copy';
		}, 1200);
	});
}
