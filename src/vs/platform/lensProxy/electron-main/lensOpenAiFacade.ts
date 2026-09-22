import type { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import { ILensLlmBackend } from '../common/lensLlmBackend.js';
import { ThoughtSignatureStore } from './thoughtSignatures.js';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
// Only dropped connections are retried here. HTTP errors (429 quota, 503 overload) go straight
// back to the engine, which retries with backoff and shows the reason in Lens Chat; retrying
// them here too multiplies requests and burns through provider rate limits.
const MAX_ATTEMPTS = 2;

export interface ILensFacadeAddress {
	readonly port: number;
	readonly token: string;
	readonly baseUrl: string;
}

/**
 * Loopback OpenAI-compatible endpoint for the Lens engine. The engine only ever sees
 * this per-launch token; the real gateway credentials are added here, in the main process.
 */
export class LensOpenAiFacade {

	private server: Server | undefined;
	private readonly token = randomBytes(32).toString('hex');
	private readonly thoughtSignatures = new ThoughtSignatureStore();

	constructor(private readonly backend: ILensLlmBackend, private readonly log: (message: string) => void) { }

	async start(): Promise<ILensFacadeAddress> {
		const { createServer } = await import('http');
		const server = createServer((req, res) => void this.handle(req, res).catch(error => this.fail(res, 502, String(error))));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		const port = (server.address() as AddressInfo).port;
		return { port, token: this.token, baseUrl: `http://127.0.0.1:${port}/v1` };
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.authorized(req.headers.authorization)) {
			return this.fail(res, 401, 'unauthorized');
		}
		const path = (req.url ?? '').split('?')[0];
		if (req.method === 'GET' && path === '/v1/models') {
			const models = await this.backend.listModels();
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data: models.map(model => ({ id: model.id, object: 'model', owned_by: this.backend.id })) }));
			return;
		}
		if (req.method === 'POST' && path === '/v1/chat/completions') {
			return this.forwardChat(req, res);
		}
		this.fail(res, 404, 'not found');
	}

	private async forwardChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse((await readBody(req)).toString('utf8'));
		} catch {
			return this.fail(res, 400, 'invalid JSON body');
		}
		let upstream;
		try {
			upstream = this.backend.chatCompletions(String(payload.model ?? ''));
		} catch (error) {
			return this.fail(res, 404, error instanceof Error ? error.message : String(error));
		}
		if (upstream.thoughtSignatures) {
			this.thoughtSignatures.apply(payload);
		}
		const body = new TextEncoder().encode(JSON.stringify({ ...payload, model: upstream.model }));
		const abort = new AbortController();
		res.on('close', () => abort.abort());

		let response: Response | undefined;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				response = await fetch(upstream.url, {
					method: 'POST',
					headers: { ...upstream.headers, 'content-type': 'application/json', accept: req.headers.accept ?? '*/*' },
					body,
					signal: abort.signal,
				});
			} catch (error) {
				if (abort.signal.aborted || attempt === MAX_ATTEMPTS) {
					throw error;
				}
				this.log(`[LensFacade] upstream error, retrying (${attempt}): ${error}`);
				await delay(attempt * 500);
				continue;
			}
			break;
		}
		if (!response) {
			return this.fail(res, 502, 'no upstream response');
		}
		if (!response.ok) {
			this.log(`[LensFacade] ${upstream.model}: upstream HTTP ${response.status}`);
		}

		res.writeHead(response.status, {
			'content-type': response.headers.get('content-type') ?? 'application/json',
			'cache-control': 'no-cache',
		});
		if (!response.body) {
			res.end();
			return;
		}
		const stream = upstream.thoughtSignatures ? response.body.pipeThrough(this.thoughtSignatures.observe()) : response.body;
		Readable.fromWeb(stream as import('stream/web').ReadableStream).pipe(res);
	}

	private authorized(header: string | undefined): boolean {
		const expected = Buffer.from(`Bearer ${this.token}`);
		const actual = Buffer.from(header ?? '');
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	private fail(res: ServerResponse, status: number, message: string): void {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { message } }));
	}
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
