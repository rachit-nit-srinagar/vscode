import { createMemo, For, Show } from 'solid-js';
import { parseProviderError } from './providerError';

const RETRY_PREFIX = /^Retrying \(attempt (\d+)\):\s*/;
const NEXT_TRY = /\s*Next try in (\d+)s\.\s*$/;

/** Readable view of a provider error: heading, status badge, message, retry hint and help links. */
export function ProviderErrorView(props: { text: string; title?: string }) {
	const view = createMemo(() => {
		const retry = RETRY_PREFIX.exec(props.text);
		const next = NEXT_TRY.exec(props.text);
		const body = props.text.replace(RETRY_PREFIX, '').replace(NEXT_TRY, '');
		const parsed = parseProviderError(body);
		const heading = props.title ?? (retry ? `Retrying (attempt ${retry[1]}) · ${parsed.heading}` : parsed.heading);
		return { ...parsed, heading, retryIn: next ? `${next[1]}s` : parsed.retryIn, retrying: !!retry };
	});
	const badge = () => [view().code, view().status].filter(Boolean).join(' · ');

	return (
		<div class={`lens-perr ${view().retrying ? 'retrying' : ''}`} role="alert">
			<div class="lens-perr-head">
				<svg class="lens-perr-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
				</svg>
				<span class="lens-perr-title">{view().heading}</span>
				<Show when={badge()}>
					<span class="lens-perr-badge">{badge()}</span>
				</Show>
			</div>
			<Show when={view().message}>
				<div class="lens-perr-message">{view().message}</div>
			</Show>
			<Show when={view().retryIn || view().links.length}>
				<div class="lens-perr-meta">
					<Show when={view().retryIn}>
						<span>{view().retrying ? 'Next try in' : 'Retry in'} {view().retryIn}</span>
					</Show>
					<For each={view().links}>
						{link => <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>}
					</For>
				</div>
			</Show>
		</div>
	);
}
