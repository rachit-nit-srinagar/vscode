import { Transform } from 'stream';

/**
 * Gemini 3 attaches a `thought_signature` to each tool call (OpenAI-compatible API:
 * `tool_calls[].extra_content.google.thought_signature`) and rejects the next request unless
 * it is sent back. The engine's OpenAI client drops that field, so the facade remembers it
 * per tool-call id and puts it back on the assistant turns it forwards.
 */

// Google's documented placeholder for tool calls whose signature is unknown (e.g. history from before a restart).
const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
const MAX_SIGNATURES = 2000;

interface IToolCall {
	id?: string;
	index?: number;
	extra_content?: { google?: { thought_signature?: string } };
}

interface IChunk {
	choices?: { delta?: { tool_calls?: IToolCall[] }; message?: { tool_calls?: IToolCall[] } }[];
}

export class ThoughtSignatureStore {

	private readonly signatures = new Map<string, string>();

	/** Adds the remembered (or placeholder) signature to every assistant tool call that lacks one. */
	apply(payload: Record<string, unknown>): void {
		const messages = Array.isArray(payload.messages) ? payload.messages as { role?: string; tool_calls?: IToolCall[] }[] : [];
		for (const message of messages) {
			if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
				continue;
			}
			for (const call of message.tool_calls) {
				if (call.extra_content?.google?.thought_signature) {
					continue;
				}
				const signature = (call.id && this.signatures.get(call.id)) || PLACEHOLDER_SIGNATURE;
				call.extra_content = { ...call.extra_content, google: { ...call.extra_content?.google, thought_signature: signature } };
			}
		}
	}

	/** Passes a response body through unchanged while recording the signatures it carries. */
	observe(): Transform {
		const decoder = new TextDecoder();
		const idByIndex = new Map<number, string>();
		let buffer = '';
		const readLine = (line: string) => {
			const json = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
			if (!json || json === '[DONE]' || !json.startsWith('{')) {
				return;
			}
			try {
				this.record(JSON.parse(json) as IChunk, idByIndex);
			} catch {
				// Not a complete JSON line; non-streaming bodies are handled at flush.
			}
		};
		return new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				lines.forEach(readLine);
				callback(null, chunk);
			},
			flush: callback => {
				buffer += decoder.decode();
				readLine(buffer.replace(/\s+/g, ' '));
				callback();
			},
		});
	}

	private record(chunk: IChunk, idByIndex: Map<number, string>): void {
		for (const choice of chunk.choices ?? []) {
			for (const call of choice.delta?.tool_calls ?? choice.message?.tool_calls ?? []) {
				if (call.id && typeof call.index === 'number') {
					idByIndex.set(call.index, call.id);
				}
				const id = call.id ?? (typeof call.index === 'number' ? idByIndex.get(call.index) : undefined);
				const signature = call.extra_content?.google?.thought_signature;
				if (id && signature) {
					this.remember(id, signature);
				}
			}
		}
	}

	private remember(id: string, signature: string): void {
		this.signatures.delete(id);
		this.signatures.set(id, signature);
		if (this.signatures.size > MAX_SIGNATURES) {
			this.signatures.delete(this.signatures.keys().next().value!);
		}
	}
}
