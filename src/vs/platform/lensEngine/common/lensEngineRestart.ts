import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILensEngineRestartService = createDecorator<ILensEngineRestartService>('lensEngineRestartService');

/**
 * Renderer-facing handle to restart the Lens engine after a LiteLLM connection or model
 * setting changes. Deliberately narrower than `ILensEngineMainService`: start/stop stay
 * lifecycle-owned in the main process and are not renderer-triggerable.
 */
export interface ILensEngineRestartService {
	readonly _serviceBrand: undefined;
	restart(): Promise<void>;
}
