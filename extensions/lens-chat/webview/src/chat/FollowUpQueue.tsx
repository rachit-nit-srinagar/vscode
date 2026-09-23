import { createSignal, For, Show } from 'solid-js';
import type { QueuedFollowUp } from './followUps';

/** Queued follow-ups for the chat on screen, shown above the composer with edit, remove and (when idle) send. */
export function FollowUpQueue(props: {
	items: QueuedFollowUp[];
	busy: boolean;
	held: boolean;
	onEdit: (id: string, text: string) => void;
	onRemove: (id: string) => void;
	onSendNow: () => void;
}) {
	const [editing, setEditing] = createSignal<string | undefined>();
	const [editText, setEditText] = createSignal('');

	function startEdit(item: QueuedFollowUp) {
		setEditing(item.id);
		setEditText(item.text);
	}

	function saveEdit(id: string) {
		props.onEdit(id, editText());
		setEditing(undefined);
	}

	return (
		<Show when={props.items.length}>
			<div class="lens-followups" aria-label="Queued follow-ups">
				<div class="lens-followups-head">
					<span class="lens-muted">
						{props.busy
							? `Queued: sent when this reply finishes${props.items.length > 1 ? ', one at a time' : ''}`
							: props.held ? 'The last reply did not finish, so queued messages are waiting' : 'Queued messages are waiting'}
					</span>
					<Show when={!props.busy}>
						<button type="button" class="lens-text-btn lens-followup-send" onClick={() => props.onSendNow()}>Send Next</button>
					</Show>
				</div>
				<For each={props.items}>
					{item => (
						<div class="lens-followup">
							<Show when={editing() === item.id} fallback={
								<>
									<span class="lens-followup-text" title={item.text}>{item.text || 'Attachment'}</span>
									<Show when={item.parts.some(part => part.type === 'file')}>
										<span class="lens-muted lens-followup-files">+{item.parts.filter(part => part.type === 'file').length} file{item.parts.filter(part => part.type === 'file').length === 1 ? '' : 's'}</span>
									</Show>
									<button type="button" class="lens-text-btn lens-followup-edit" title="Edit queued message" onClick={() => startEdit(item)}>Edit</button>
									<button type="button" class="lens-text-btn lens-followup-remove" title="Remove queued message" aria-label="Remove queued message" onClick={() => props.onRemove(item.id)}>×</button>
								</>
							}>
								<textarea
									class="lens-followup-input"
									rows={2}
									value={editText()}
									ref={element => queueMicrotask(() => element.focus())}
									onInput={event => setEditText(event.currentTarget.value)}
									on:keydown={event => {
										// Handled here so Escape cancels the edit instead of stopping the running turn.
										if (event.key === 'Escape') {
											event.preventDefault();
											event.stopPropagation();
											setEditing(undefined);
										} else if (event.key === 'Enter' && !event.shiftKey) {
											event.preventDefault();
											event.stopPropagation();
											saveEdit(item.id);
										}
									}}
								/>
								<button type="button" class="lens-text-btn lens-followup-save" onClick={() => saveEdit(item.id)}>Save</button>
								<button type="button" class="lens-text-btn" onClick={() => setEditing(undefined)}>Cancel</button>
							</Show>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}
