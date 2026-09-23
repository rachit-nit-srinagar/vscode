import type { OpencodeHostClient } from './opencodeClient';

/**
 * Checkpoints: rewind code, fork the conversation, or both, at a user message.
 *
 * Everything here comes from the webview, so it is treated as untrusted: the request type is
 * matched against a fixed list, IDs must be short strings of safe characters, and every ID is
 * still encoded before it goes into a URL path.
 */
export type CheckpointRequest =
	| { type: 'checkpoint.state'; sessionID: string }
	| { type: 'checkpoint.rewind'; sessionID: string; messageID: string }
	| { type: 'checkpoint.fork'; sessionID: string; messageID: string }
	| { type: 'checkpoint.both'; sessionID: string; messageID: string }
	| { type: 'checkpoint.undo'; sessionID: string };

export type CheckpointResult =
	| { ok: true; action: CheckpointRequest['type']; sessionID: string; messageID?: string; revert?: RevertState; session?: { id: string; title?: string } }
	| { ok: false; action: CheckpointRequest['type']; sessionID: string; error: string };

/** What the engine keeps on a session while it is rewound (`Session.Info.revert`), plus how many files were restored. */
export interface RevertState {
	readonly messageID: string;
	readonly files?: number;
}

const CHECKPOINT_TYPES = new Set<string>(['checkpoint.state', 'checkpoint.rewind', 'checkpoint.fork', 'checkpoint.both', 'checkpoint.undo']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isCheckpointRequest(message: { type?: unknown }): boolean {
	return typeof message?.type === 'string' && CHECKPOINT_TYPES.has(message.type);
}

/** Validates an untrusted webview message. Returns undefined when it is malformed. */
export function parseCheckpointRequest(message: unknown): CheckpointRequest | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}
	const { type, sessionID, messageID } = message as { type?: unknown; sessionID?: unknown; messageID?: unknown };
	if (typeof type !== 'string' || !CHECKPOINT_TYPES.has(type) || !isId(sessionID)) {
		return undefined;
	}
	if (type === 'checkpoint.state' || type === 'checkpoint.undo') {
		return { type, sessionID };
	}
	if (!isId(messageID)) {
		return undefined;
	}
	return { type: type as 'checkpoint.rewind' | 'checkpoint.fork' | 'checkpoint.both', sessionID, messageID };
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && ID.test(value);
}

const ACTION_LABEL: Record<CheckpointRequest['type'], string> = {
	'checkpoint.state': 'read the checkpoint state',
	'checkpoint.rewind': 'rewind the code',
	'checkpoint.fork': 'fork the chat',
	'checkpoint.both': 'fork the chat and rewind the code',
	'checkpoint.undo': 'undo the rewind',
};

/** Runs one checkpoint request. Never throws: failures come back as `{ ok: false, error }` for the webview to show. */
export async function runCheckpoint(client: OpencodeHostClient, raw: unknown): Promise<CheckpointResult> {
	const request = parseCheckpointRequest(raw);
	const fallbackType = (raw as { type?: string })?.type;
	if (!request) {
		return { ok: false, action: isCheckpointRequest({ type: fallbackType }) ? fallbackType as CheckpointRequest['type'] : 'checkpoint.state', sessionID: '', error: 'Lens ignored a malformed checkpoint request.' };
	}
	try {
		return await run(client, request);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, action: request.type, sessionID: request.sessionID, error: `Could not ${ACTION_LABEL[request.type]}: ${busyHint(reason)}` };
	}
}

async function run(client: OpencodeHostClient, request: CheckpointRequest): Promise<CheckpointResult> {
	const session = `/session/${encodeURIComponent(request.sessionID)}`;
	switch (request.type) {
		case 'checkpoint.state': {
			const info = await client.request<unknown>('GET', session);
			return { ok: true, action: request.type, sessionID: request.sessionID, revert: revertOf(info) };
		}
		case 'checkpoint.undo': {
			const info = await client.request<unknown>('POST', `${session}/unrevert`);
			return { ok: true, action: request.type, sessionID: request.sessionID, revert: revertOf(info) };
		}
		case 'checkpoint.rewind': {
			const info = await client.request<unknown>('POST', `${session}/revert`, { messageID: request.messageID });
			const revert = revertOf(info);
			if (!revert) {
				throw new Error('the engine did not find that message.');
			}
			return { ok: true, action: request.type, sessionID: request.sessionID, messageID: request.messageID, revert };
		}
		case 'checkpoint.fork': {
			// A new chat holding the conversation from before this message; files stay as they are.
			const fork = sessionOf(await client.request<unknown>('POST', `${session}/fork`, { messageID: request.messageID }));
			return { ok: true, action: request.type, sessionID: request.sessionID, messageID: request.messageID, session: fork };
		}
		case 'checkpoint.both': {
			// Copy the whole chat, then rewind the copy at the same message. The copy holds the file patches,
			// so the rewind restores the files, and "Undo rewind" works there. The original chat is left untouched.
			const index = await messageIndex(client, request.sessionID, request.messageID);
			const fork = sessionOf(await client.request<unknown>('POST', `${session}/fork`, {}));
			const forkPath = `/session/${encodeURIComponent(fork.id)}`;
			const copied = listOf(await client.request<unknown>('GET', `${forkPath}/message`));
			const target = (copied[index] as { info?: { id?: unknown; role?: unknown } } | undefined)?.info;
			if (!target || target.role !== 'user' || !isId(target.id)) {
				throw new Error('the forked chat does not line up with the original. The fork was kept; the code was not rewound.');
			}
			const revert = revertOf(await client.request<unknown>('POST', `${forkPath}/revert`, { messageID: target.id }));
			return { ok: true, action: request.type, sessionID: fork.id, messageID: target.id, revert, session: fork };
		}
	}
}

async function messageIndex(client: OpencodeHostClient, sessionID: string, messageID: string): Promise<number> {
	const messages = listOf(await client.request<unknown>('GET', `/session/${encodeURIComponent(sessionID)}/message`));
	const index = messages.findIndex(item => (item as { info?: { id?: unknown } })?.info?.id === messageID);
	if (index < 0 || (messages[index] as { info?: { role?: unknown } }).info?.role !== 'user') {
		throw new Error('that message is not a user message in this chat.');
	}
	return index;
}

function busyHint(reason: string): string {
	return /busy/i.test(reason) ? 'the chat is still running. Stop it or wait for it to finish, then try again.' : reason;
}

function revertOf(info: unknown): RevertState | undefined {
	const data = unwrap(info) as { revert?: { messageID?: unknown }; summary?: { files?: unknown } } | undefined;
	const messageID = data?.revert?.messageID;
	if (!isId(messageID)) {
		return undefined;
	}
	const files = data?.summary?.files;
	return { messageID, files: typeof files === 'number' ? files : undefined };
}

function sessionOf(data: unknown): { id: string; title?: string } {
	const info = unwrap(data) as { id?: unknown; title?: unknown } | undefined;
	if (!isId(info?.id)) {
		throw new Error('the engine did not return the new chat.');
	}
	return { id: info.id, title: typeof info.title === 'string' ? info.title : undefined };
}

function unwrap(data: unknown): unknown {
	if (data && typeof data === 'object' && 'data' in data && !('id' in data)) {
		return (data as { data: unknown }).data;
	}
	return data;
}

function listOf(data: unknown): unknown[] {
	const value = Array.isArray(data) ? data : unwrap(data);
	return Array.isArray(value) ? value : [];
}

/** Drops the turns a rewound session has undone (from its revert message on), keeping the order. */
export async function withoutRewoundTurns(client: OpencodeHostClient, sessionID: string, userMessageIDs: string[]): Promise<string[]> {
	let revert: RevertState | undefined;
	try {
		revert = revertOf(await client.request<unknown>('GET', `/session/${encodeURIComponent(sessionID)}`));
	} catch {
		return userMessageIDs;
	}
	const index = revert ? userMessageIDs.indexOf(revert.messageID) : -1;
	return index < 0 ? userMessageIDs : userMessageIDs.slice(0, index);
}
