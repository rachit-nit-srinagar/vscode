import type { ILensEngineRuntime } from './protocol';

export class OpencodeHostClient {
	constructor(
		private readonly runtime: ILensEngineRuntime,
		private readonly directory?: string,
	) { }

	private headers(extra?: Record<string, string>): Record<string, string> {
		const token = Buffer.from(`${this.runtime.opencodeUsername}:${this.runtime.opencodePassword}`).toString('base64');
		const headers: Record<string, string> = {
			Authorization: `Basic ${token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...extra,
		};
		if (this.directory) {
			headers['x-opencode-directory'] = encodeURIComponent(this.directory);
		}
		return headers;
	}

	async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
		const url = new URL(pathname, this.runtime.opencodeUrl.endsWith('/') ? this.runtime.opencodeUrl : `${this.runtime.opencodeUrl}/`);
		const response = await fetch(url, {
			method,
			headers: this.headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(formatHttpError(method, pathname, response.status, text));
		}
		if (response.status === 204) {
			return undefined as T;
		}
		const text = await response.text();
		if (!text) {
			return undefined as T;
		}
		return JSON.parse(text) as T;
	}

	subscribeEvents(onEvent: (payload: unknown) => void, signal: AbortSignal): void {
		const url = new URL('/event', `${this.runtime.opencodeUrl}/`);
		void (async () => {
			const response = await fetch(url, {
				method: 'GET',
				headers: this.headers({ Accept: 'text/event-stream' }),
				signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(`event subscribe failed (${response.status})`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const chunks = buffer.split('\n\n');
				buffer = chunks.pop() ?? '';
				for (const chunk of chunks) {
					const dataLine = chunk.split('\n').find(line => line.startsWith('data:'));
					if (!dataLine) {
						continue;
					}
					const raw = dataLine.slice(5).trim();
					if (!raw) {
						continue;
					}
					try {
						onEvent(JSON.parse(raw));
					} catch {
						onEvent(raw);
					}
				}
			}
		})().catch(error => {
			if (signal.aborted) {
				return;
			}
			onEvent({ type: 'error', error: error instanceof Error ? error.message : String(error) });
		});
	}
}

function formatHttpError(method: string, pathname: string, status: number, body: string): string {
	if (status === 401 || status === 403) {
		return 'Not authorized to talk to the Lens engine. Restart Lens.';
	}
	let tag = '';
	let message = '';
	try {
		const parsed = JSON.parse(body) as { _tag?: string; name?: string; message?: string; data?: { message?: string } };
		tag = String(parsed._tag ?? parsed.name ?? '');
		message = String(parsed.message ?? parsed.data?.message ?? '').trim();
	} catch {
		message = body.replace(/\s+/g, ' ').trim();
	}
	if (tag === 'BadRequest' || status === 400) {
		if (method === 'POST' && pathname === '/session') {
			return 'Could not start a chat session. Pick a valid model and try again.';
		}
		if (method === 'POST' && pathname.includes('/message')) {
			return message || 'Could not send that message. The engine rejected the request.';
		}
		return message || 'The engine rejected that request.';
	}
	if (message) {
		return message;
	}
	if (tag) {
		return `Engine request failed (${status}).`;
	}
	const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 180);
	return snippet ? `Engine request failed (${status}): ${snippet}` : `Engine request failed (${status}).`;
}
