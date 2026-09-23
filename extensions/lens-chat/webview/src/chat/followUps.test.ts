import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createTurnBoundaryWatcher,
	dropFollowUps,
	editFollowUp,
	EMPTY_FOLLOW_UPS,
	enqueueFollowUp,
	holdFollowUps,
	queuedFor,
	releaseFollowUps,
	removeFollowUp,
	restoreFollowUps,
	runSignal,
	takeFollowUp,
	type QueuedFollowUp,
} from './followUps';

function item(id: string, text: string, files = 0): QueuedFollowUp {
	return {
		id,
		text,
		parts: [
			...(text ? [{ type: 'text' as const, text }] : []),
			...Array.from({ length: files }, () => ({ type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,AA' })),
		],
	};
}

describe('followUps', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps a separate queue per session and takes the oldest first', () => {
		let state = enqueueFollowUp(EMPTY_FOLLOW_UPS, 's1', item('a', 'one'));
		state = enqueueFollowUp(state, 's1', item('b', 'two'));
		state = enqueueFollowUp(state, 's2', item('c', 'other'));
		expect(queuedFor(state, 's1').map(entry => entry.text)).toEqual(['one', 'two']);
		const taken = takeFollowUp(state, 's1');
		expect(taken.item?.text).toBe('one');
		expect(queuedFor(taken.state, 's1').map(entry => entry.text)).toEqual(['two']);
		expect(queuedFor(taken.state, 's2')).toHaveLength(1);
		expect(takeFollowUp(EMPTY_FOLLOW_UPS, 's1').item).toBeUndefined();
	});

	it('edits text, keeps attachments, and removes an entry edited to nothing', () => {
		let state = enqueueFollowUp(EMPTY_FOLLOW_UPS, 's1', item('a', 'old', 1));
		state = enqueueFollowUp(state, 's1', item('b', 'gone'));
		state = editFollowUp(state, 's1', 'a', '  new  ');
		expect(queuedFor(state, 's1')[0]).toMatchObject({ text: 'new', parts: [{ type: 'text', text: 'new' }, { type: 'file' }] });
		state = editFollowUp(state, 's1', 'b', '   ');
		expect(queuedFor(state, 's1').map(entry => entry.id)).toEqual(['a']);
		state = removeFollowUp(state, 's1', 'a');
		expect(state.queued).toEqual({});
	});

	it('holds and releases a session, and dropping clears both', () => {
		let state = holdFollowUps(enqueueFollowUp(EMPTY_FOLLOW_UPS, 's1', item('a', 'x')), 's1');
		expect(state.held.s1).toBe(true);
		expect(releaseFollowUps(state, 's1').held).toEqual({});
		state = dropFollowUps(state, 's1');
		expect(state).toEqual(EMPTY_FOLLOW_UPS);
	});

	it('restores a saved queue as held and ignores malformed entries', () => {
		const state = restoreFollowUps({
			s1: [{ text: 'kept', parts: [{ type: 'text', text: 'kept' }] }, { text: 5 }, null, { text: 'bad', parts: [{ type: 'file' }] }],
			s2: 'nope',
		});
		expect(queuedFor(state, 's1').map(entry => entry.text)).toEqual(['kept']);
		expect(state.held).toEqual({ s1: true });
		expect(restoreFollowUps(undefined)).toEqual(EMPTY_FOLLOW_UPS);
	});

	it('classifies run events', () => {
		expect(runSignal('session.idle', undefined)).toBe('idle');
		expect(runSignal('session.status', 'idle')).toBe('idle');
		expect(runSignal('session.status', 'busy')).toBe('busy');
		expect(runSignal('session.status', 'retry')).toBe('busy');
		expect(runSignal('message.part.updated', undefined)).toBeUndefined();
	});

	it('takes one boundary per settled idle and cancels it when a run starts', () => {
		vi.useFakeTimers();
		const boundaries: string[] = [];
		const watcher = createTurnBoundaryWatcher(sessionID => boundaries.push(sessionID), 400);
		watcher.observe('session.status', 's1', 'idle');
		watcher.observe('session.idle', 's1', undefined);
		vi.advanceTimersByTime(399);
		expect(boundaries).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(boundaries).toEqual(['s1']);

		watcher.observe('session.idle', 's2', undefined);
		watcher.observe('session.status', 's2', 'busy');
		watcher.observe('session.idle', undefined, undefined);
		vi.advanceTimersByTime(1_000);
		expect(boundaries).toEqual(['s1']);
		watcher.dispose();
	});
});
