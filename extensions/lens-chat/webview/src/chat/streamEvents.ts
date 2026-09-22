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
	const index = findMessageIndex(messages, messageID);
	if (index < 0) {
		if (!messageID) {
			return messages;
		}
		return [...messages, { info: { id: messageID, role: 'assistant' }, parts: [chatPart] }];
	}
	const message = messages[index]!;
	const parts = [...(message.parts ?? [])];
	const partIndex = parts.findIndex(existing => existing.id && existing.id === chatPart.id);
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
