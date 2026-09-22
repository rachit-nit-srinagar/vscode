/*---------------------------------------------------------------------------------------------
 *  Lens. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

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
}

/**
 * An OpenAI-compatible model gateway. The local facade forwards chat completions
 * to it, so credentials stay in the main process and never reach the engine.
 */
export interface ILensLlmBackend {
	readonly id: string;
	listModels(): Promise<ILensUpstreamModel[]>;
	chatCompletions(): ILensUpstreamRequest;
}
