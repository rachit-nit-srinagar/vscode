import { createDecorator } from '../../instantiation/common/instantiation.js';

export type LensProviderType =
	| 'openai'
	| 'anthropic'
	| 'gemini'
	| 'azure-openai'
	| 'openrouter'
	| 'cloudflare'
	| 'xai'
	| 'groq'
	| 'openai-compatible'
	| 'litellm'
	| 'ollama';

export const LENS_PROVIDER_TYPES: readonly LensProviderType[] = [
	'openai', 'anthropic', 'gemini', 'azure-openai', 'openrouter', 'cloudflare', 'xai', 'groq', 'openai-compatible', 'litellm', 'ollama',
];

/** Non-secret provider settings. The API key is stored separately, encrypted, in the main process. */
export interface ILensProviderConfig {
	readonly type: LensProviderType;
	/** openai-compatible, litellm, ollama */
	readonly baseUrl?: string;
	/** azure-openai */
	readonly resourceName?: string;
	/** cloudflare */
	readonly accountId?: string;
	readonly gatewayId?: string;
	/** openai-compatible: header that carries the key; defaults to Authorization with a Bearer prefix. */
	readonly headerName?: string;
	/** Enabled model ids. Empty means every model the provider lists. */
	readonly models: readonly string[];
}

export interface ILensProviderSummary extends ILensProviderConfig {
	readonly hasApiKey: boolean;
}

export interface ILensProviderModel {
	readonly id: string;
	readonly name: string;
}

export interface ILensProviderSaveRequest {
	readonly config: ILensProviderConfig;
	/** New key; omitted keeps the stored one unless the endpoint changed. */
	readonly apiKey?: string;
	readonly clearApiKey?: boolean;
}

export const ILensProvidersService = createDecorator<ILensProvidersService>('lensProvidersService');

/** Renderer-facing provider management; served by the main process over the `lensProviders` channel. */
export interface ILensProvidersService {
	readonly _serviceBrand: undefined;
	list(): Promise<ILensProviderSummary[]>;
	save(request: ILensProviderSaveRequest): Promise<ILensProviderSummary[]>;
	remove(type: LensProviderType): Promise<ILensProviderSummary[]>;
	/** Lists the models a configured provider offers, using its stored endpoint and key. */
	fetchModels(type: LensProviderType): Promise<ILensProviderModel[]>;
}
