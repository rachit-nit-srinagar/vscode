import type { ChatMessage, ChatPart } from './types';

type OpencodeEvent = {
	type?: string;
	properties?: Record<string, unknown>;
	data?: Record<string, unknown>;
};

type PartDelta = {
	sessionID?: string;
	messageID?: string;
	partID?: string;
	field?: string;
	delta?: string;
};

/**
 * Apply live opencode SSE events to the local transcript.
 *
 * Token deltas (`message.part.delta`) are not persisted until `text-end`, so
 * refetching `GET /session/:id/message` during a stream returns empty/stale
 * text and the UI dumps the full answer at the end.
 */
export function applyChatEvent(messages: ChatMessage[], payload: unknown): ChatMessage[] | undefined {
	const event = payload as OpencodeEvent;
	const type = String(event?.type ?? '');
	const props = eventProps(event);
	if (type === 'message.part.delta') {
		return applyPartDelta(messages, props as PartDelta);
	}
	if (type === 'message.part.updated') {
		const part = props.part;
		if (!part || typeof part !== 'object') {
			return undefined;
		}
		return upsertPart(messages, part as ChatPart & { messageID?: string });
	}
	if (type === 'message.updated') {
		const info = props.info;
		if (!info || typeof info !== 'object') {
			return undefined;
		}
		return upsertMessage(messages, info as NonNullable<ChatMessage['info']>);
	}
	return undefined;
}

export function eventSessionID(payload: unknown): string | undefined {
	const event = payload as OpencodeEvent;
	const props = eventProps(event);
	if (typeof props.sessionID === 'string') {
		return props.sessionID;
	}
	const part = props.part;
	if (part && typeof part === 'object' && typeof (part as { sessionID?: unknown }).sessionID === 'string') {
		return (part as { sessionID: string }).sessionID;
	}
	return undefined;
}

function eventProps(event: OpencodeEvent): Record<string, unknown> {
	if (event?.properties && typeof event.properties === 'object') {
		return event.properties;
	}
	if (event?.data && typeof event.data === 'object') {
		return event.data;
	}
	return {};
}

function applyPartDelta(messages: ChatMessage[], delta: PartDelta): ChatMessage[] {
	if (!delta.partID || typeof delta.delta !== 'string' || (delta.field && delta.field !== 'text')) {
		return messages;
	}
	const index = findMessageIndex(messages, delta.messageID);
	if (index < 0) {
		if (!delta.messageID) {
			return messages;
		}
		return [
			...messages,
			{
				info: { id: delta.messageID, role: 'assistant' },
				parts: [{ id: delta.partID, type: 'text', text: delta.delta }],
			},
		];
	}
	const message = messages[index]!;
	const parts = [...(message.parts ?? [])];
	const partIndex = parts.findIndex(part => part.id === delta.partID);
	if (partIndex < 0) {
		parts.push({ id: delta.partID, type: 'text', text: delta.delta });
	} else {
		const part = parts[partIndex]!;
		parts[partIndex] = { ...part, text: `${part.text ?? ''}${delta.delta}` };
	}
	return replaceMessage(messages, index, { ...message, parts });
}

function upsertPart(messages: ChatMessage[], part: ChatPart & { messageID?: string }): ChatMessage[] {
	const messageID = part.messageID;
	const chatPart = toChatPart(part);
	let index = findMessageIndex(messages, messageID);
	if (index < 0) {
		if (!messageID) {
			return messages;
		}
		const optimistic = findOptimisticUserMessage(messages, chatPart);
		if (optimistic < 0) {
			return [...messages, { info: { id: messageID, role: 'assistant' }, parts: [chatPart] }];
		}
		messages = replaceMessage(messages, optimistic, { ...messages[optimistic]!, info: { ...messages[optimistic]!.info, id: messageID } });
		index = optimistic;
	}
	const message = messages[index]!;
	const parts = [...(message.parts ?? [])];
	let partIndex = parts.findIndex(existing => existing.id && existing.id === chatPart.id);
	if (partIndex < 0) {
		// The server's copy of a part the chat showed optimistically replaces it instead of repeating it.
		partIndex = parts.findIndex(existing => !existing.id && samePart(existing, chatPart));
	}
	if (partIndex < 0) {
		parts.push(chatPart);
	} else {
		parts[partIndex] = mergePart(parts[partIndex]!, chatPart);
	}
	return replaceMessage(messages, index, { ...message, parts });
}

function upsertMessage(messages: ChatMessage[], info: NonNullable<ChatMessage['info']>): ChatMessage[] {
	if (!info.id) {
		return messages;
	}
	const index = findMessageIndex(messages, info.id);
	if (index < 0) {
		// The user's own prompt is already on screen (sent optimistically); adopt it rather than adding a copy.
		const optimistic = info.role === 'user' ? findOptimisticUserMessage(messages) : -1;
		if (optimistic >= 0) {
			return replaceMessage(messages, optimistic, { ...messages[optimistic]!, info: { ...messages[optimistic]!.info, ...info } });
		}
		return [...messages, { info, parts: [] }];
	}
	const message = messages[index]!;
	return replaceMessage(messages, index, { ...message, info: { ...message.info, ...info } });
}

function mergePart(existing: ChatPart, incoming: ChatPart): ChatPart {
	const incomingText = incoming.text ?? '';
	const existingText = existing.text ?? '';
	const text = !incomingText && existingText ? existingText : incomingText || existingText;
	return { ...existing, ...incoming, text };
}

function toChatPart(part: ChatPart & { messageID?: string }): ChatPart {
	const { messageID: _messageID, ...rest } = part;
	return rest;
}

/** Latest user message added locally before the server assigned it an id, optionally holding `part`. */
function findOptimisticUserMessage(messages: ChatMessage[], part?: ChatPart): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.info?.id) {
			continue;
		}
		if ((message.info?.role ?? message.role) !== 'user') {
			continue;
		}
		if (!part || (message.parts ?? []).some(existing => !existing.id && samePart(existing, part))) {
			return index;
		}
	}
	return -1;
}

function samePart(local: ChatPart, remote: ChatPart): boolean {
	if (local.type !== remote.type) {
		return false;
	}
	if (local.type === 'text') {
		return (local.text ?? '').trim() === (remote.text ?? '').trim();
	}
	return !!local.url && local.url === remote.url;
}

function findMessageIndex(messages: ChatMessage[], messageID?: string): number {
	if (!messageID) {
		return -1;
	}
	return messages.findIndex(message => message.info?.id === messageID);
}

function replaceMessage(messages: ChatMessage[], index: number, next: ChatMessage): ChatMessage[] {
	const copy = messages.slice();
	copy[index] = next;
	return copy;
}
