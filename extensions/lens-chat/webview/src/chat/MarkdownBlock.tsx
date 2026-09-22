import { createMemo } from 'solid-js';
import { highlightCode, renderMarkdown, resolveLang, rewriteAssistantMarkdown } from './markdown';

export function MarkdownBlock(props: { markdown?: string; reads?: Array<{ language: string; text: string }> }) {
	const html = createMemo(() => renderMarkdown(rewriteAssistantMarkdown(props.markdown ?? '', props.reads ?? [])));
	return <div class="lens-md" innerHTML={html()} />;
}

export function CodeFence(props: { code: string; lang?: string; wrap?: boolean }) {
	const language = createMemo(() => resolveLang(props.lang));
	const html = createMemo(() => highlightCode(props.code.replace(/\n$/, ''), props.lang));
	const label = createMemo(() => (props.lang ?? '').trim() || language());
	return (
		<div class={`lens-codeblock${props.wrap ? ' wrap' : ''}`}>
			<div class="lens-codeblock-bar">
				<span class="lens-codeblock-lang">{label()}</span>
				<button type="button" class="lens-codeblock-copy" data-copy-code>Copy</button>
			</div>
			<pre><code class={`hljs language-${language()}`} innerHTML={html()} /></pre>
		</div>
	);
}
