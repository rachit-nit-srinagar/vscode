/*---------------------------------------------------------------------------------------------
 *  Lens. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ILensLlmBackend, ILensUpstreamModel, ILensUpstreamRequest } from '../common/lensLlmBackend.js';

interface ILiteLlmModelInfo {
	readonly model_name?: string;
	readonly model_info?: {
		readonly supports_vision?: boolean;
		readonly max_input_tokens?: number;
		readonly max_output_tokens?: number;
	};
}

export class LiteLlmBackend implements ILensLlmBackend {

	readonly id = 'litellm';
	private readonly baseUrl: string;

	constructor(baseUrl: string, private readonly apiKey: string | undefined) {
		this.baseUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
	}

	async listModels(): Promise<ILensUpstreamModel[]> {
		// /model/info carries vision and token limits; plain /v1/models is the fallback for older proxies.
		const info = await this.getJson<{ data?: ILiteLlmModelInfo[] }>('/model/info').catch(() => undefined);
		if (info?.data?.length) {
			const models = new Map<string, ILensUpstreamModel>();
			for (const entry of info.data) {
				if (!entry.model_name || models.has(entry.model_name)) {
					continue;
				}
				models.set(entry.model_name, {
					id: entry.model_name,
					name: entry.model_name,
					vision: entry.model_info?.supports_vision === true,
					contextWindow: entry.model_info?.max_input_tokens,
					maxOutputTokens: entry.model_info?.max_output_tokens,
				});
			}
			return [...models.values()];
		}
		const list = await this.getJson<{ data?: { id?: string }[] }>('/v1/models');
		return (list.data ?? [])
			.flatMap(model => model.id ? [{ id: model.id, name: model.id, vision: false }] : []);
	}

	chatCompletions(): ILensUpstreamRequest {
		return { url: `${this.baseUrl}/v1/chat/completions`, headers: this.authHeaders() };
	}

	private authHeaders(): Record<string, string> {
		return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
	}

	private async getJson<T>(path: string): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, { headers: this.authHeaders(), signal: AbortSignal.timeout(10_000) });
		if (!response.ok) {
			throw new Error(`LiteLLM ${path} failed: HTTP ${response.status}`);
		}
		return await response.json() as T;
	}
}
