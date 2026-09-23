import { describe, expect, it } from 'vitest';
import { parseCheckpointRequest, runCheckpoint } from '../../../src/checkpoints';
import type { OpencodeHostClient } from '../../../src/opencodeClient';
import { isCheckpointResult, restoredFilesLabel, revertFromSessionInfo, rewoundIndex, userMessageText } from './checkpoints';

describe('checkpoint helpers (webview)', () => {
	const messages = [
		{ info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
		{ info: { id: 'msg_2', role: 'assistant' }, parts: [] },
		{ info: { id: 'msg_3', role: 'user' }, parts: [{ type: 'text', text: 'second' }, { type: 'text', text: 'hidden', synthetic: true } as never] },
	];

	it('finds where the rewound part of a chat starts', () => {
		expect([
			rewoundIndex(messages, undefined),
			rewoundIndex(messages, { messageID: 'msg_3' }),
			rewoundIndex(messages, { messageID: 'msg_gone' }),
		]).toEqual([-1, 2, -1]);
	});

	it('puts back only the text the user typed', () => {
		expect([userMessageText(messages[0]), userMessageText(messages[2]), userMessageText(undefined)]).toEqual(['first', 'second', '']);
	});

	it('reads the rewound state from session info', () => {
		expect([
			revertFromSessionInfo({ revert: { messageID: 'msg_3' }, summary: { files: 2 } }),
			revertFromSessionInfo({ revert: undefined }),
			revertFromSessionInfo({ revert: { messageID: 42 } }),
		]).toEqual([{ messageID: 'msg_3', files: 2 }, undefined, undefined]);
	});

	it('labels restored files and recognises checkpoint replies', () => {
		expect([restoredFilesLabel(undefined), restoredFilesLabel(0), restoredFilesLabel(1), restoredFilesLabel(3)])
			.toEqual(['Files restored.', 'No files needed restoring.', '1 file restored.', '3 files restored.']);
		expect([isCheckpointResult('checkpoint.rewind', { ok: true }), isCheckpointResult('session.list', { ok: true }), isCheckpointResult('checkpoint.fork', 'x')])
			.toEqual([true, false, false]);
	});
});

describe('checkpoint requests (host)', () => {
	it('rejects malformed or hostile webview input', () => {
		expect([
			parseCheckpointRequest({ type: 'checkpoint.rewind', sessionID: 'ses_1', messageID: 'msg_1' }),
			parseCheckpointRequest({ type: 'checkpoint.undo', sessionID: 'ses_1' }),
			parseCheckpointRequest({ type: 'checkpoint.rewind', sessionID: 'ses_1' }),
			parseCheckpointRequest({ type: 'checkpoint.rewind', sessionID: '../../config', messageID: 'msg_1' }),
			parseCheckpointRequest({ type: 'checkpoint.fork', sessionID: 'ses_1', messageID: { id: 'x' } }),
			parseCheckpointRequest({ type: 'checkpoint.delete', sessionID: 'ses_1' }),
			parseCheckpointRequest(null),
		]).toEqual([
			{ type: 'checkpoint.rewind', sessionID: 'ses_1', messageID: 'msg_1' },
			{ type: 'checkpoint.undo', sessionID: 'ses_1' },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	function fakeClient(routes: Record<string, unknown>, calls: string[] = []): OpencodeHostClient {
		return {
			request: async (method: string, path: string, body?: unknown) => {
				calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
				const reply = routes[`${method} ${path}`];
				if (reply instanceof Error) {
					throw reply;
				}
				return reply;
			},
		} as unknown as OpencodeHostClient;
	}

	it('rewinds at the message and reports the restored files', async () => {
		const calls: string[] = [];
		const client = fakeClient({ 'POST /session/ses_1/revert': { id: 'ses_1', revert: { messageID: 'msg_1' }, summary: { files: 1 } } }, calls);
		expect(await runCheckpoint(client, { type: 'checkpoint.rewind', sessionID: 'ses_1', messageID: 'msg_1' }))
			.toEqual({ ok: true, action: 'checkpoint.rewind', sessionID: 'ses_1', messageID: 'msg_1', revert: { messageID: 'msg_1', files: 1 } });
		expect(calls).toEqual(['POST /session/ses_1/revert {"messageID":"msg_1"}']);
	});

	it('Both forks the whole chat, then rewinds the copy at the same message', async () => {
		const calls: string[] = [];
		const client = fakeClient({
			'GET /session/ses_1/message': [{ info: { id: 'msg_1', role: 'user' } }, { info: { id: 'msg_2', role: 'assistant' } }, { info: { id: 'msg_3', role: 'user' } }],
			'POST /session/ses_1/fork': { id: 'ses_2', title: 'Copy' },
			'GET /session/ses_2/message': [{ info: { id: 'msg_a', role: 'user' } }, { info: { id: 'msg_b', role: 'assistant' } }, { info: { id: 'msg_c', role: 'user' } }],
			'POST /session/ses_2/revert': { id: 'ses_2', revert: { messageID: 'msg_c' }, summary: { files: 2 } },
		}, calls);
		expect(await runCheckpoint(client, { type: 'checkpoint.both', sessionID: 'ses_1', messageID: 'msg_3' }))
			.toEqual({ ok: true, action: 'checkpoint.both', sessionID: 'ses_2', messageID: 'msg_c', revert: { messageID: 'msg_c', files: 2 }, session: { id: 'ses_2', title: 'Copy' } });
		expect(calls.at(-1)).toBe('POST /session/ses_2/revert {"messageID":"msg_c"}');
	});

	it('turns engine failures into a readable error instead of throwing', async () => {
		const client = fakeClient({ 'POST /session/ses_1/revert': new Error('Session ses_1 is busy') });
		expect(await runCheckpoint(client, { type: 'checkpoint.rewind', sessionID: 'ses_1', messageID: 'msg_1' })).toEqual({
			ok: false,
			action: 'checkpoint.rewind',
			sessionID: 'ses_1',
			error: 'Could not rewind the code: the chat is still running. Stop it or wait for it to finish, then try again.',
		});
		expect((await runCheckpoint(client, { type: 'checkpoint.rewind', sessionID: 'bad id', messageID: 'msg_1' })).ok).toBe(false);
	});
});
