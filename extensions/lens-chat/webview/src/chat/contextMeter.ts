import type { ChatMessage } from './types';

/** The client-side `/compact` command: Lens runs it through the engine's summarize route, not as a prompt. */
export const COMPACT_COMMAND = 'compact';
export const COMPACT_DESCRIPTION = 'Summarize this chat to free up context';

type Tokens = {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
};

/** The assistant message fields the meter reads; the shared ChatMessage type leaves them out. */
type AssistantInfo = {
	role?: string;
	summary?: boolean;
	providerID?: string;
	modelID?: string;
	tokens?: Tokens;
	time?: { completed?: number };
	error?: { name?: string };
};

export type ContextUsage = {
	/** Tokens the conversation takes up in the model's context window. */
	tokens: number;
	/** The model's context window, when known. */
	limit?: number;
	/** 0-100, rounded down; undefined when the limit is unknown. */
	percent?: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	/** The window was measured right after a compaction; only the summary is left. */
	compacted: boolean;
};

function info(message: ChatMessage): AssistantInfo {
	return (message.info ?? {}) as AssistantInfo;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How full the context window is: the tokens of the last assistant message that produced output
 * (the same measure the engine uses for its own overflow check). After a compaction only the
 * summary remains, so its output is what the next turn starts from.
 * `limitFor` maps the message's provider and model to that model's context window.
 */
export function contextUsage(messages: ChatMessage[], limitFor: (providerID: string, modelID: string) => number | undefined): ContextUsage | undefined {
	const last = [...messages].reverse().find(message => info(message).role === 'assistant' && count(info(message).tokens?.output) > 0);
	if (!last) {
		return undefined;
	}
	const meta = info(last);
	const tokens = meta.tokens ?? {};
	const compacted = !!meta.summary;
	const usage = {
		input: compacted ? 0 : count(tokens.input),
		output: count(tokens.output),
		reasoning: compacted ? 0 : count(tokens.reasoning),
		cacheRead: compacted ? 0 : count(tokens.cache?.read),
		cacheWrite: compacted ? 0 : count(tokens.cache?.write),
	};
	const total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
	if (total <= 0) {
		return undefined;
	}
	const rawLimit = meta.providerID && meta.modelID ? limitFor(meta.providerID, meta.modelID) : undefined;
	const limit = rawLimit && rawLimit > 0 ? rawLimit : undefined;
	return {
		tokens: total,
		limit,
		percent: limit ? Math.min(100, Math.floor(total / limit * 100)) : undefined,
		...usage,
		compacted,
	};
}

/**
 * Whether a finished turn should be followed by a compaction.
 * 'wait' means the turn's last reply has not settled yet (its tokens are still coming).
 */
export function autoCompactDecision(
	messages: ChatMessage[],
	threshold: number,
	limitFor: (providerID: string, modelID: string) => number | undefined,
): 'compact' | 'skip' | 'wait' {
	if (!(threshold > 0)) {
		return 'skip';
	}
	const last = messages[messages.length - 1];
	const meta = last ? info(last) : undefined;
	// No messages yet (a tab is still loading) or the reply has not started.
	if (!meta || meta.role !== 'assistant') {
		return 'wait';
	}
	if (meta.error || meta.summary) {
		return 'skip';
	}
	if (!meta.time?.completed) {
		return 'wait';
	}
	const usage = contextUsage(messages, limitFor);
	if (!usage || usage.compacted || usage.percent === undefined) {
		return 'skip';
	}
	return usage.percent >= Math.min(threshold, 100) ? 'compact' : 'skip';
}

/** Reads `lens.chat.autoCompactThreshold`: a percentage, where 0 (or anything invalid) turns it off. */
export function normalizeThreshold(value: unknown): number {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number) || number <= 0) {
		return 0;
	}
	return Math.min(100, Math.round(number));
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${trim(value / 1_000_000)}M`;
	}
	if (value >= 1000) {
		return `${trim(value / 1000)}k`;
	}
	return String(Math.round(value));
}

function trim(value: number): string {
	return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10).toString();
}

export function meterLevel(percent: number | undefined): 'unknown' | 'ok' | 'warn' | 'critical' {
	if (percent === undefined) {
		return 'unknown';
	}
	return percent >= 90 ? 'critical' : percent >= 75 ? 'warn' : 'ok';
}

export function meterTooltip(usage: ContextUsage, threshold: number): string {
	const lines = [
		usage.limit
			? `Context: ${formatTokens(usage.tokens)} of ${formatTokens(usage.limit)} tokens (${usage.percent}%)`
			: `Context: ${formatTokens(usage.tokens)} tokens (this model's context size is unknown)`,
	];
	if (usage.compacted) {
		lines.push('The chat was just compacted; only its summary is left.');
	} else {
		const detail = [`input ${formatTokens(usage.input)}`, `output ${formatTokens(usage.output)}`];
		if (usage.reasoning) {
			detail.push(`reasoning ${formatTokens(usage.reasoning)}`);
		}
		if (usage.cacheRead || usage.cacheWrite) {
			detail.push(`cache ${formatTokens(usage.cacheRead + usage.cacheWrite)}`);
		}
		lines.push(`Last reply: ${detail.join(', ')}`);
	}
	lines.push(threshold > 0
		? `Compacts automatically after a reply once ${threshold}% full. Type /${COMPACT_COMMAND} to compact now.`
		: `Type /${COMPACT_COMMAND} to compact now; otherwise the chat compacts when the context is full.`);
	return lines.join('\n');
}
