import type { ChatMessage } from './types';

export type CheckpointAction = 'checkpoint.rewind' | 'checkpoint.fork' | 'checkpoint.both';

/** A session's rewound state: messages from `messageID` on are rewound and dropped by the engine on the next send. */
export type RevertState = { messageID: string; files?: number };

/** The host's reply to every checkpoint request (see extensions/lens-chat/src/checkpoints.ts). */
export type CheckpointResult =
	| { ok: true; action: string; sessionID: string; messageID?: string; revert?: RevertState; session?: { id: string; title?: string } }
	| { ok: false; action: string; sessionID: string; error: string };

export const CHECKPOINT_ACTIONS: ReadonlyArray<{ action: CheckpointAction; label: string; detail: string }> = [
	{ action: 'checkpoint.rewind', label: 'Rewind code', detail: 'Restore files to before this message' },
	{ action: 'checkpoint.fork', label: 'Fork chat', detail: 'Continue in a new chat from here; files stay as they are' },
	{ action: 'checkpoint.both', label: 'Both', detail: 'New chat from here, with files restored' },
];

/** Index of the first rewound message, or -1 when the session is not rewound (or the message is gone). */
export function rewoundIndex(messages: readonly ChatMessage[], revert: RevertState | undefined): number {
	if (!revert) {
		return -1;
	}
	return messages.findIndex(message => message.info?.id === revert.messageID);
}

/** The text a user message was sent with, to put back in the composer after a rewind or fork. */
export function userMessageText(message: ChatMessage | undefined): string {
	return (message?.parts ?? []).filter(part => part.type === 'text' && !(part as { synthetic?: boolean }).synthetic).map(part => part.text ?? '').join('\n').trim();
}

/** Reads the rewound state out of a `session.updated` event's session info. */
export function revertFromSessionInfo(info: unknown): RevertState | undefined {
	const data = info as { revert?: { messageID?: unknown }; summary?: { files?: unknown } } | undefined;
	const messageID = data?.revert?.messageID;
	if (typeof messageID !== 'string' || !messageID) {
		return undefined;
	}
	const files = data?.summary?.files;
	return { messageID, files: typeof files === 'number' ? files : undefined };
}

export function isCheckpointResult(requestType: string, data: unknown): data is CheckpointResult {
	return requestType.startsWith('checkpoint.') && !!data && typeof data === 'object' && typeof (data as { ok?: unknown }).ok === 'boolean';
}

export function restoredFilesLabel(files: number | undefined): string {
	if (files === undefined) {
		return 'Files restored.';
	}
	if (files === 0) {
		return 'No files needed restoring.';
	}
	return `${files} file${files === 1 ? '' : 's'} restored.`;
}
