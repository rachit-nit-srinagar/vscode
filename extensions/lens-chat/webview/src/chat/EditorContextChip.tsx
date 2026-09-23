import { createMemo, createSignal, Show } from 'solid-js';

/** The active file or selection the extension host offers; it has already passed the exclusion rules. */
export type EditorContext = {
	kind: 'selection' | 'file';
	path: string;
	url: string;
	label: string;
	range?: { startLine: number; endLine: number };
};

export type EditorContextPart = { type: 'file'; mime: string; url: string; filename: string };

/**
 * Tracks the editor context chip. Removing the chip, or sending it once, hides it until the
 * editor offers something different (another file or another selection).
 */
export function createEditorContext() {
	const [offered, setOffered] = createSignal<EditorContext | undefined>();
	const [hiddenUrl, setHiddenUrl] = createSignal<string | undefined>();
	const current = createMemo(() => {
		const context = offered();
		return context && context.url !== hiddenUrl() ? context : undefined;
	});
	return {
		current,
		/** Handles the host's `editorContext` message. */
		update(value: unknown) {
			const next = isEditorContext(value) ? value : undefined;
			// Something different was offered in between, so coming back to the same file shows it again.
			if (next?.url !== hiddenUrl()) {
				setHiddenUrl(undefined);
			}
			setOffered(next);
		},
		dismiss() {
			setHiddenUrl(offered()?.url);
		},
		/** The prompt part for the chip, if one is shown; the chip is hidden after this. */
		take(): EditorContextPart | undefined {
			const context = current();
			if (!context) {
				return undefined;
			}
			setHiddenUrl(context.url);
			return { type: 'file', mime: 'text/plain', url: context.url, filename: context.kind === 'selection' ? `${context.path}:${context.range?.startLine}-${context.range?.endLine}` : context.path };
		},
	};
}

function isEditorContext(value: unknown): value is EditorContext {
	const context = value as Partial<EditorContext> | undefined;
	return !!context && typeof context.url === 'string' && context.url.startsWith('file:') && typeof context.path === 'string' && typeof context.label === 'string';
}

export function EditorContextChip(props: { context: EditorContext | undefined; onRemove: () => void }) {
	return (
		<Show when={props.context}>
			{context => (
				<div class="lens-editor-context">
					<span class="lens-chip lens-editor-context-chip" title={context().kind === 'selection' ? `Selection in ${context().path} is sent with your next message` : `${context().path} is sent with your next message`}>
						<span class="lens-muted">{context().kind === 'selection' ? 'Selection' : 'File'}</span>
						<span class="lens-editor-context-label">{context().label}</span>
						<button type="button" class="lens-text-btn" aria-label={`Remove ${context().label}`} title="Remove" onClick={event => {
							event.stopPropagation();
							props.onRemove();
						}}>×</button>
					</span>
				</div>
			)}
		</Show>
	);
}

/** Appends a mention to the draft with single spaces around it. */
export function appendMention(draft: string, mention: string): string {
	const base = draft.replace(/\s+$/, '');
	return `${base ? `${base} ` : ''}${mention} `;
}
