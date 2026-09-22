/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILensLiteLlmConfigService = createDecorator<ILensLiteLlmConfigService>('lensLiteLlmConfigService');

/**
 * Holds the LiteLLM API key, encrypted at rest via the platform keychain (safeStorage).
 * Base URL and the enabled-model list are ordinary settings (`lens.liteLlm.*`); only the
 * key needs a dedicated, main-process-only store.
 */
export interface ILensLiteLlmModel {
	readonly id: string;
	readonly name: string;
}

export interface ILensLiteLlmConfigService {
	readonly _serviceBrand: undefined;
	setApiKey(apiKey: string | undefined): Promise<void>;
	hasApiKey(): Promise<boolean>;
	/** Lists models from the given LiteLLM base URL using the stored API key, if any. */
	listModels(baseUrl: string): Promise<ILensLiteLlmModel[]>;
}
