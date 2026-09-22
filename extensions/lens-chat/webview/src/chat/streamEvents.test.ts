import { describe, expect, it } from 'vitest';
import { applyChatEvent, eventSessionID } from './streamEvents';
import type { ChatMessage } from './types';

describe('applyChatEvent', () => {
	it('appends message.part.delta tokens without replacing the transcript', () => {
		const start: ChatMessage[] = [{
			info: { id: 'msg-1', role: 'assistant' },
			parts: [{ id: 'part-1', type: 'text', text: 'Hel' }],
		}];
		const next = applyChatEvent(start, {
			type: 'message.part.delta',
			properties: { sessionID: 's1', messageID: 'msg-1', partID: 'part-1', field: 'text', delta: 'lo' },
		});
		expect(next?.[0]?.parts?.[0]?.text).toBe('Hello');
		expect(start[0]?.parts?.[0]?.text).toBe('Hel');
	});

	it('creates an assistant part when the first delta arrives before part.updated', () => {
		const next = applyChatEvent([], {
			type: 'message.part.delta',
			data: { sessionID: 's1', messageID: 'msg-1', partID: 'part-1', field: 'text', delta: 'Hi' },
		});
		expect(next).toEqual([{
			info: { id: 'msg-1', role: 'assistant' },
			parts: [{ id: 'part-1', type: 'text', text: 'Hi' }],
		}]);
	});

	it('does not wipe streamed text when a later empty part.updated arrives', () => {
		const streamed = applyChatEvent([{
			info: { id: 'msg-1', role: 'assistant' },
			parts: [{ id: 'part-1', type: 'text', text: 'Hello' }],
		}], {
			type: 'message.part.updated',
			properties: {
				sessionID: 's1',
				part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: '' },
			},
		});
		expect(streamed?.[0]?.parts?.[0]?.text).toBe('Hello');
	});

	it('replaces text when part.updated carries the completed message', () => {
		const next = applyChatEvent([{
			info: { id: 'msg-1', role: 'assistant' },
			parts: [{ id: 'part-1', type: 'text', text: 'Hel' }],
		}], {
			type: 'message.part.updated',
			properties: {
				sessionID: 's1',
				part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'Hello world' },
			},
		});
		expect(next?.[0]?.parts?.[0]?.text).toBe('Hello world');
	});

	it('ignores unrelated events so the host can refetch', () => {
		expect(applyChatEvent([], { type: 'session.idle', properties: { sessionID: 's1' } })).toBeUndefined();
	});

	it('reads session id from part events', () => {
		expect(eventSessionID({ type: 'message.part.delta', properties: { sessionID: 's1' } })).toBe('s1');
		expect(eventSessionID({
			type: 'message.part.updated',
			properties: { part: { sessionID: 's2', id: 'p', type: 'text' } },
		})).toBe('s2');
	});
});
