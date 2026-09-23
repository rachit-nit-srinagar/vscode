import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from 'solid-js';
import { vscode } from '../vscode';
import { CHECKPOINT_ACTIONS, isCheckpointResult, restoredFilesLabel, revertFromSessionInfo, rewoundIndex, userMessageText, type CheckpointAction, type RevertState } from './checkpoints';
import type { ChatMessage } from './types';

type CheckpointOptions = {
	active: Accessor<string | undefined>;
	messages: Accessor<ChatMessage[]>;
	/** Opens (or switches to) a chat tab. */
	openSession: (id: string, title: string) => void;
	setError: (message: string) => void;
	/** Puts the rewound message's text back in the composer, unless the user is already typing. */
	restoreDraft: (text: string) => void;
};

/**
 * Checkpoint state for Lens Chat: which session is rewound, the pending request, and how the
 * host's replies change the tabs, messages and composer.
 */
export function createCheckpoints(options: CheckpointOptions) {
	const [reverts, setReverts] = createSignal<Record<string, RevertState | undefined>>({});
	const [pending, setPending] = createSignal<string | undefined>();
	let draftAfterReply = '';

	const revert = () => {
		const id = options.active();
		return id ? reverts()[id] : undefined;
	};
	const firstRewound = () => rewoundIndex(options.messages(), revert());

	createEffect(() => {
		const id = options.active();
		if (id) {
			vscode.postMessage({ type: 'checkpoint.state', sessionID: id });
		}
	});

	function setRevert(sessionID: string, value: RevertState | undefined) {
		setReverts(current => ({ ...current, [sessionID]: value }));
	}

	function refresh(sessionID: string) {
		if (sessionID === options.active()) {
			vscode.postMessage({ type: 'session.messages', sessionID });
			vscode.postMessage({ type: 'session.diff', sessionID });
		}
	}

	function run(action: CheckpointAction, message: ChatMessage) {
		const sessionID = options.active();
		const messageID = message.info?.id;
		if (!sessionID || !messageID || pending()) {
			return;
		}
		draftAfterReply = userMessageText(message);
		setPending(action);
		options.setError('');
		vscode.postMessage({ type: action, sessionID, messageID });
	}

	function undo() {
		const sessionID = options.active();
		if (!sessionID || pending()) {
			return;
		}
		setPending('checkpoint.undo');
		options.setError('');
		vscode.postMessage({ type: 'checkpoint.undo', sessionID });
	}

	/** Returns true when the result was a checkpoint reply. */
	function handleResult(requestType: string, data: unknown): boolean {
		if (!requestType.startsWith('checkpoint.')) {
			return false;
		}
		if (requestType !== 'checkpoint.state') {
			setPending(undefined);
		}
		if (!isCheckpointResult(requestType, data)) {
			options.setError('Lens got an unreadable reply to a checkpoint request.');
			return true;
		}
		if (!data.ok) {
			// A failed background state read is not worth a card; every user action's failure is.
			if (requestType !== 'checkpoint.state') {
				options.setError(data.error);
			}
			return true;
		}
		if (requestType === 'checkpoint.state' || requestType === 'checkpoint.undo') {
			setRevert(data.sessionID, data.revert);
			refresh(data.sessionID);
			return true;
		}
		const text = draftAfterReply;
		draftAfterReply = '';
		if (requestType === 'checkpoint.rewind') {
			setRevert(data.sessionID, data.revert);
			refresh(data.sessionID);
		} else if (data.session) {
			setRevert(data.session.id, data.revert);
			options.openSession(data.session.id, data.session.title || 'Forked chat');
		}
		if (text) {
			options.restoreDraft(text);
		}
		return true;
	}

	function handleEvent(payload: unknown) {
		const event = payload as { type?: string; properties?: { info?: { id?: unknown } } };
		const info = event?.properties?.info;
		if (event?.type === 'session.updated' && typeof info?.id === 'string') {
			setRevert(info.id, revertFromSessionInfo(info));
		}
	}

	return { revert, firstRewound, pending, run, undo, handleResult, handleEvent };
}

export type Checkpoints = ReturnType<typeof createCheckpoints>;

/** The hover menu on a user message: Rewind code, Fork chat, Both. */
export function RewindMenu(props: { disabled?: boolean; onPick: (action: CheckpointAction) => void }) {
	const [open, setOpen] = createSignal(false);
	let root: HTMLDivElement | undefined;
	const onPointerDown = (event: PointerEvent) => {
		if (root && !root.contains(event.target as Node)) {
			setOpen(false);
		}
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			setOpen(false);
		}
	};
	document.addEventListener('pointerdown', onPointerDown);
	document.addEventListener('keydown', onKeyDown);
	onCleanup(() => {
		document.removeEventListener('pointerdown', onPointerDown);
		document.removeEventListener('keydown', onKeyDown);
	});
	return (
		<div class={`lens-rewind ${open() ? 'open' : ''}`} ref={root}>
			<button
				type="button"
				class="lens-rewind-trigger"
				title="Rewind or fork from this message"
				aria-label="Rewind or fork from this message"
				aria-haspopup="menu"
				aria-expanded={open()}
				disabled={props.disabled}
				onClick={() => setOpen(value => !value)}
			>
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.5 2.75a.75.75 0 0 1 1.5 0v1.6A6 6 0 1 1 2.05 9.2a.75.75 0 1 1 1.47-.3A4.5 4.5 0 1 0 5.1 5.5h1.65a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75v-3.5Z" /></svg>
			</button>
			<Show when={open()}>
				<div class="lens-rewind-menu" role="menu">
					<For each={CHECKPOINT_ACTIONS}>
						{item => (
							<button
								type="button"
								role="menuitem"
								class="lens-rewind-item"
								onClick={() => {
									setOpen(false);
									props.onPick(item.action);
								}}
							>
								<span class="lens-rewind-label">{item.label}</span>
								<span class="lens-muted">{item.detail}</span>
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

/** Shown while the active chat is rewound, with the way back. */
export function RewindBanner(props: { revert: RevertState; pending?: boolean; onUndo: () => void }) {
	return (
		<div class="lens-dock lens-rewind-banner" role="status">
			<div>
				<strong>Code rewound</strong>
				<div class="lens-muted">{restoredFilesLabel(props.revert.files)} Messages from the rewound point are dimmed and are removed when you send a new message.</div>
			</div>
			<button type="button" class="lens-pill" disabled={props.pending} onClick={() => props.onUndo()}>Undo rewind</button>
		</div>
	);
}
