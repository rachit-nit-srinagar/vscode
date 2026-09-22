export interface ILensUpstreamModel {
	readonly id: string;
	readonly name: string;
	readonly vision: boolean;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
}

export interface ILensUpstreamRequest {
	readonly url: string;
	readonly headers: Record<string, string>;
	/** Model id to send upstream (routers strip their provider prefix). */
	readonly model: string;
}

/**
 * An OpenAI-compatible model gateway. The local facade forwards chat completions
 * to it, so credentials stay in the main process and never reach the engine.
 */
export interface ILensLlmBackend {
	readonly id: string;
	listModels(): Promise<ILensUpstreamModel[]>;
	/** Resolves where a chat completion for `model` goes. Throws for unknown models. */
	chatCompletions(model: string): ILensUpstreamRequest;
}
