import { ILensProviderConfig, LensProviderType } from '../../lensEngine/common/lensProviders.js';
import { ILensLlmBackend, ILensUpstreamModel, ILensUpstreamRequest } from '../common/lensLlmBackend.js';
import { LiteLlmBackend } from './liteLlmBackend.js';

/** A configured provider plus its decrypted key; only ever built inside the main process. */
export interface ILensResolvedProvider {
	readonly config: ILensProviderConfig;
	readonly apiKey: string | undefined;
}

interface IProviderEndpoint {
	readonly baseUrl: string;
	readonly headers: Record<string, string>;
	/** Headers for listing models when they differ from chat (Anthropic's models API). */
	readonly listHeaders?: Record<string, string>;
	/** Providers whose models must be typed in (deployments, gateway routes). */
	readonly manualModels?: boolean;
}

// Speech, audio, embedding and safety-classifier models show up in /models but cannot chat.
const NON_CHAT_MODEL = /whisper|tts|orpheus|transcribe|speech|audio|embed|moderation|prompt-guard|guard-|dall-e|image-gen|imagen|veo/i;
const VISION_HINT = /gpt-4o|gpt-4\.1|gpt-5|\bo[134]\b|o[34]-|claude|gemini|grok-(2-vision|4)|llama-4|vision|pixtral|llava|qwen.*vl|gemma-3/i;

export function providerEndpoint(config: ILensProviderConfig, apiKey: string | undefined): IProviderEndpoint {
	const bearer: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
	switch (config.type) {
		case 'openai':
			return { baseUrl: 'https://api.openai.com/v1', headers: bearer };
		case 'anthropic':
			return {
				baseUrl: 'https://api.anthropic.com/v1',
				headers: bearer,
				listHeaders: apiKey ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {},
			};
		case 'gemini':
			return { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', headers: bearer };
		case 'azure-openai':
			return {
				baseUrl: `https://${requireHostLabel(config.resourceName, 'Azure resource name')}.openai.azure.com/openai/v1`,
				headers: apiKey ? { 'api-key': apiKey } : {},
				manualModels: true,
			};
		case 'openrouter':
			return { baseUrl: 'https://openrouter.ai/api/v1', headers: bearer };
		case 'cloudflare':
			return {
				baseUrl: `https://gateway.ai.cloudflare.com/v1/${requirePathSegment(config.accountId, 'Cloudflare account id')}/${requirePathSegment(config.gatewayId, 'Cloudflare gateway id')}/compat`,
				headers: apiKey ? { 'cf-aig-authorization': `Bearer ${apiKey}` } : {},
				manualModels: true,
			};
		case 'xai':
			return { baseUrl: 'https://api.x.ai/v1', headers: bearer };
		case 'groq':
			return { baseUrl: 'https://api.groq.com/openai/v1', headers: bearer };
		case 'openai-compatible': {
			const header = config.headerName?.trim() || 'Authorization';
			if (!/^[A-Za-z0-9-]+$/.test(header)) {
				throw new Error('Enter a valid header name');
			}
			const value = apiKey && header.toLowerCase() === 'authorization' && !/^bearer /i.test(apiKey) ? `Bearer ${apiKey}` : apiKey;
			return { baseUrl: requireUrl(config.baseUrl), headers: value ? { [header]: value } : {} };
		}
		case 'litellm':
			return { baseUrl: `${requireUrl(config.baseUrl).replace(/\/v1$/, '')}/v1`, headers: bearer };
		case 'ollama':
			return { baseUrl: `${(config.baseUrl?.trim() ? requireUrl(config.baseUrl) : 'http://localhost:11434').replace(/\/v1$/, '')}/v1`, headers: {} };
	}
}

/** Lists what a provider offers, without applying the user's model selection. */
export async function fetchProviderModels(provider: ILensResolvedProvider): Promise<ILensUpstreamModel[]> {
	const { config, apiKey } = provider;
	if (config.type === 'litellm') {
		return new LiteLlmBackend(requireUrl(config.baseUrl), apiKey).listModels();
	}
	const endpoint = providerEndpoint(config, apiKey);
	if (endpoint.manualModels) {
		return config.models.map(id => ({ id, name: id, vision: VISION_HINT.test(id) }));
	}
	const response = await fetch(`${endpoint.baseUrl}/models`, { headers: endpoint.listHeaders ?? endpoint.headers, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		throw new Error(`${config.type}: listing models failed (HTTP ${response.status})`);
	}
	const body = await response.json() as { data?: IProviderModelEntry[] };
	return (body.data ?? []).flatMap(model => {
		const id = model.id?.replace(/^models\//, '');
		if (!id || NON_CHAT_MODEL.test(id)) {
			return [];
		}
		const vision = model.architecture?.input_modalities ? model.architecture.input_modalities.includes('image') : VISION_HINT.test(id);
		// Providers reject requests whose max_tokens exceed their limit, so pass on whatever limits they publish.
		const contextWindow = positive(model.context_window) ?? positive(model.context_length) ?? positive(model.max_input_tokens);
		const maxOutputTokens = positive(model.max_completion_tokens) ?? positive(model.max_output_tokens) ?? positive(model.top_provider?.max_completion_tokens);
		const created = positive(model.created) ?? (model.created_at ? positive(Date.parse(model.created_at) / 1000) : undefined);
		return [{ id, name: model.display_name ?? model.name ?? id, vision, contextWindow, maxOutputTokens, created }];
	});
}

/**
 * Routes `<provider>/<model>` ids to each provider's OpenAI-compatible endpoint.
 * Keys live here, in the main process; the engine only sees the facade's token.
 */
export class ProviderRouterBackend implements ILensLlmBackend {

	readonly id = 'lens';

	constructor(private readonly providers: readonly ILensResolvedProvider[], private readonly log: (message: string) => void) { }

	async listModels(): Promise<ILensUpstreamModel[]> {
		const lists = await Promise.all(this.providers.map(async provider => {
			try {
				const models = await fetchProviderModels(provider);
				const enabled = new Set(provider.config.models);
				return models
					.filter(model => enabled.size === 0 || enabled.has(model.id))
					.map(model => ({ ...model, id: `${provider.config.type}/${model.id}`, name: model.name }));
			} catch (error) {
				this.log(`[LensProviders] ${provider.config.type}: ${error instanceof Error ? error.message : error}`);
				return [];
			}
		}));
		return lists.flat();
	}

	chatCompletions(model: string): ILensUpstreamRequest {
		const slash = model.indexOf('/');
		const type = slash > 0 ? model.slice(0, slash) as LensProviderType : undefined;
		const provider = this.providers.find(item => item.config.type === type);
		if (!provider) {
			throw new Error(`No configured provider for model ${model}`);
		}
		const endpoint = providerEndpoint(provider.config, provider.apiKey);
		return { url: `${endpoint.baseUrl}/chat/completions`, headers: endpoint.headers, model: model.slice(slash + 1), thoughtSignatures: provider.config.type === 'gemini' };
	}
}

interface IProviderModelEntry {
	readonly id?: string;
	readonly name?: string;
	readonly display_name?: string;
	readonly architecture?: { readonly input_modalities?: string[] };
	readonly context_window?: number;
	readonly context_length?: number;
	readonly max_input_tokens?: number;
	readonly max_completion_tokens?: number;
	readonly max_output_tokens?: number;
	readonly top_provider?: { readonly max_completion_tokens?: number };
	readonly created?: number;
	readonly created_at?: string;
}

function positive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function requireUrl(value: string | undefined): string {
	const url = value?.trim().replace(/\/+$/, '');
	if (!url || !/^https?:\/\/[^\s/]+/i.test(url)) {
		throw new Error('Enter a base URL that starts with http:// or https://');
	}
	return url;
}

function requireHostLabel(value: string | undefined, label: string): string {
	const text = value?.trim().toLowerCase();
	if (!text || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(text)) {
		throw new Error(`Enter a valid ${label}`);
	}
	return text;
}

function requirePathSegment(value: string | undefined, label: string): string {
	const text = value?.trim();
	if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) {
		throw new Error(`Enter a valid ${label}`);
	}
	return text;
}
