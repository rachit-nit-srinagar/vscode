// Follow-ups typed while a turn is running wait here, per session, until that session's next turn boundary.

export type FollowUpPart = { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string };

export type QueuedFollowUp = {
	id: string;
	text: string;
	parts: FollowUpPart[];
	imageWarning?: string;
};

export type FollowUpState = {
	queued: Record<string, QueuedFollowUp[]>;
	// Sessions whose last turn failed or was stopped: their queue waits for the user instead of sending itself.
	held: Record<string, true>;
};

export const EMPTY_FOLLOW_UPS: FollowUpState = { queued: {}, held: {} };

let nextId = 0;

export function newFollowUpId(): string {
	nextId++;
	return `followup-${Date.now().toString(36)}-${nextId}`;
}

export function queuedFor(state: FollowUpState, sessionID: string | undefined): QueuedFollowUp[] {
	return sessionID ? state.queued[sessionID] ?? [] : [];
}

export function enqueueFollowUp(state: FollowUpState, sessionID: string, item: QueuedFollowUp): FollowUpState {
	return { ...state, queued: { ...state.queued, [sessionID]: [...queuedFor(state, sessionID), item] } };
}

function setQueue(state: FollowUpState, sessionID: string, items: QueuedFollowUp[]): FollowUpState {
	const queued = { ...state.queued };
	if (items.length) {
		queued[sessionID] = items;
	} else {
		delete queued[sessionID];
	}
	return { ...state, queued };
}

export function removeFollowUp(state: FollowUpState, sessionID: string, id: string): FollowUpState {
	return setQueue(state, sessionID, queuedFor(state, sessionID).filter(item => item.id !== id));
}

/** Replaces the text of a queued follow-up; one left with neither text nor attachments is removed. */
export function editFollowUp(state: FollowUpState, sessionID: string, id: string, text: string): FollowUpState {
	const trimmed = text.trim();
	const items = queuedFor(state, sessionID).flatMap(item => {
		if (item.id !== id) {
			return [item];
		}
		const attachments = item.parts.filter(part => part.type !== 'text');
		if (!trimmed && !attachments.length) {
			return [];
		}
		return [{ ...item, text: trimmed, parts: [...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []), ...attachments] }];
	});
	return setQueue(state, sessionID, items);
}

/** Takes the oldest queued follow-up of a session off its queue. */
export function takeFollowUp(state: FollowUpState, sessionID: string): { item: QueuedFollowUp | undefined; state: FollowUpState } {
	const [item, ...rest] = queuedFor(state, sessionID);
	return { item, state: item ? setQueue(state, sessionID, rest) : state };
}

export function holdFollowUps(state: FollowUpState, sessionID: string): FollowUpState {
	return state.held[sessionID] ? state : { ...state, held: { ...state.held, [sessionID]: true } };
}

export function releaseFollowUps(state: FollowUpState, sessionID: string): FollowUpState {
	if (!state.held[sessionID]) {
		return state;
	}
	const held = { ...state.held };
	delete held[sessionID];
	return { ...state, held };
}

export function dropFollowUps(state: FollowUpState, sessionID: string): FollowUpState {
	return releaseFollowUps(setQueue(state, sessionID, []), sessionID);
}

/** Classifies an engine event for a session as the start or the end of a run, or neither. */
export function runSignal(eventType: string, statusType: string | undefined): 'busy' | 'idle' | undefined {
	if (eventType === 'session.idle' || (eventType === 'session.status' && statusType === 'idle')) {
		return 'idle';
	}
	if (eventType === 'session.status' && (statusType === 'busy' || statusType === 'retry')) {
		return 'busy';
	}
	return undefined;
}

/**
 * Calls `onBoundary` once a session has stayed idle for `settleMs`. The engine reports one idle
 * transition as several events (a status change, then `session.idle`, and a failing run reports idle
 * twice), so a boundary is only taken once they settle; a new run starting in the meantime cancels it.
 */
export function createTurnBoundaryWatcher(onBoundary: (sessionID: string) => void, settleMs = 400) {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	function cancel(sessionID: string) {
		const timer = timers.get(sessionID);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(sessionID);
		}
	}
	return {
		observe(eventType: string, sessionID: string | undefined, statusType: string | undefined) {
			const signal = sessionID ? runSignal(eventType, statusType) : undefined;
			if (!sessionID || !signal) {
				return;
			}
			cancel(sessionID);
			if (signal === 'idle') {
				timers.set(sessionID, setTimeout(() => {
					timers.delete(sessionID);
					onBoundary(sessionID);
				}, settleMs));
			}
		},
		cancel,
		dispose() {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		},
	};
}

/** Reads a queue saved in webview state, dropping anything malformed. Restored queues start held. */
export function restoreFollowUps(saved: unknown): FollowUpState {
	if (!saved || typeof saved !== 'object') {
		return EMPTY_FOLLOW_UPS;
	}
	let state = EMPTY_FOLLOW_UPS;
	for (const [sessionID, items] of Object.entries(saved as Record<string, unknown>)) {
		if (!Array.isArray(items)) {
			continue;
		}
		for (const raw of items) {
			const item = raw as Partial<QueuedFollowUp> | undefined;
			if (!item || typeof item.text !== 'string' || !Array.isArray(item.parts)) {
				continue;
			}
			const parts = item.parts.filter(isFollowUpPart);
			if (!parts.length) {
				continue;
			}
			state = enqueueFollowUp(state, sessionID, {
				id: newFollowUpId(),
				text: item.text,
				parts,
				imageWarning: typeof item.imageWarning === 'string' ? item.imageWarning : undefined,
			});
		}
		if (state.queued[sessionID]) {
			state = holdFollowUps(state, sessionID);
		}
	}
	return state;
}

function isFollowUpPart(part: unknown): part is FollowUpPart {
	const value = part as Partial<FollowUpPart> | undefined;
	if (value?.type === 'text') {
		return typeof value.text === 'string';
	}
	return value?.type === 'file' && typeof value.mime === 'string' && typeof value.url === 'string';
}
