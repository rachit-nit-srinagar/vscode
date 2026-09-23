import { describe, expect, it } from 'vitest';
import { autoCompactDecision, contextUsage, formatTokens, meterLevel, meterTooltip, normalizeThreshold } from './contextMeter';
import type { ChatMessage } from './types';

const limits: Record<string, number> = { 'lens/small': 1000, 'lens/big': 128_000 };
const limitFor = (providerID: string, modelID: string) => limits[`${providerID}/${modelID}`];

function assistant(tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }, extra: Record<string, unknown> = {}): ChatMessage {
	return { info: { role: 'assistant', providerID: 'lens', modelID: 'small', tokens, time: { created: 1, completed: 2 }, ...extra } as ChatMessage['info'], parts: [] };
}

const user: ChatMessage = { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] };

describe('contextUsage', () => {
	it('is undefined before any reply reports tokens', () => {
		expect(contextUsage([], limitFor)).toBeUndefined();
		expect(contextUsage([user, assistant({ input: 0, output: 0 })], limitFor)).toBeUndefined();
	});

	it('adds every token kind of the last reply with output and measures it against the model', () => {
		const usage = contextUsage([user, assistant({ input: 10, output: 1 }), user, assistant({ input: 500, output: 100, reasoning: 50, cache: { read: 40, write: 10 } }), user, assistant({ output: 0 })], limitFor);
		expect(usage).toMatchObject({ tokens: 700, limit: 1000, percent: 70, input: 500, output: 100, reasoning: 50, cacheRead: 40, cacheWrite: 10, compacted: false });
	});

	it('leaves the percentage out when the model limit is unknown', () => {
		const usage = contextUsage([assistant({ input: 5, output: 5 }, { modelID: 'unknown' })], limitFor);
		expect(usage?.tokens).toBe(10);
		expect(usage?.percent).toBeUndefined();
	});

	it('counts only the summary after a compaction', () => {
		const usage = contextUsage([assistant({ input: 900, output: 50 }), user, assistant({ input: 900, output: 80 }, { summary: true })], limitFor);
		expect(usage).toMatchObject({ tokens: 80, percent: 8, compacted: true });
	});

	it('caps the percentage at 100', () => {
		expect(contextUsage([assistant({ input: 5000, output: 10 })], limitFor)?.percent).toBe(100);
	});
});

describe('autoCompactDecision', () => {
	it('is off at 0', () => {
		expect(autoCompactDecision([assistant({ input: 990, output: 5 })], 0, limitFor)).toBe('skip');
	});

	it('compacts a finished reply at or over the threshold only', () => {
		expect(autoCompactDecision([user, assistant({ input: 795, output: 5 })], 80, limitFor)).toBe('compact');
		expect(autoCompactDecision([user, assistant({ input: 700, output: 5 })], 80, limitFor)).toBe('skip');
	});

	it('waits while the reply is still running', () => {
		expect(autoCompactDecision([], 50, limitFor)).toBe('wait');
		expect(autoCompactDecision([user], 50, limitFor)).toBe('wait');
		expect(autoCompactDecision([user, assistant({ input: 900, output: 5 }, { time: { created: 1 } })], 50, limitFor)).toBe('wait');
	});

	it('never compacts a failed reply, a summary or an unknown limit', () => {
		expect(autoCompactDecision([assistant({ input: 900, output: 5 }, { error: { name: 'APIError' } })], 50, limitFor)).toBe('skip');
		expect(autoCompactDecision([assistant({ input: 900, output: 5 }, { summary: true })], 50, limitFor)).toBe('skip');
		expect(autoCompactDecision([assistant({ input: 900, output: 5 }, { modelID: 'unknown' })], 50, limitFor)).toBe('skip');
	});
});

describe('formatting', () => {
	it('normalizes the threshold setting', () => {
		expect([normalizeThreshold(0), normalizeThreshold(-5), normalizeThreshold('x'), normalizeThreshold(undefined), normalizeThreshold(80.4), normalizeThreshold(250)]).toEqual([0, 0, 0, 0, 80, 100]);
	});

	it('shortens token counts', () => {
		expect([formatTokens(950), formatTokens(1200), formatTokens(128_000), formatTokens(1_048_576)]).toEqual(['950', '1.2k', '128k', '1M']);
	});

	it('picks a level from the percentage', () => {
		expect([meterLevel(undefined), meterLevel(10), meterLevel(75), meterLevel(95)]).toEqual(['unknown', 'ok', 'warn', 'critical']);
	});

	it('explains the numbers and the compaction setting', () => {
		const usage = contextUsage([assistant({ input: 780, output: 20 })], limitFor)!;
		expect(meterTooltip(usage, 0)).toBe('Context: 800 of 1k tokens (80%)\nLast reply: input 780, output 20\nType /compact to compact now; otherwise the chat compacts when the context is full.');
		expect(meterTooltip(usage, 85)).toContain('Compacts automatically after a reply once 85% full.');
	});
});
