import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface ILensEngineRuntimeState {
	readonly opencodeUrl: string;
	readonly opencodeUsername: string;
	readonly opencodePassword: string;
}

/** User-editable opencode settings layered on top of the locked Lens config. */
export interface ILensUserOpencodeConfig {
	readonly mcp?: Record<string, unknown>;
	readonly plugin?: unknown;
	readonly skills?: unknown;
	readonly command?: unknown;
	readonly agent?: unknown;
	readonly instructions?: unknown;
	readonly pluginsAllowed?: boolean;
	readonly hooksAllowed?: boolean;
}

export const ILensEngineService = createDecorator<ILensEngineService>('lensEngineService');

/** Renderer-facing view of the engine; served by the main process over the `lensEngine` channel. */
export interface ILensEngineService {
	readonly _serviceBrand: undefined;
	getRuntimeState(): Promise<ILensEngineRuntimeState | undefined>;
	getLastError(): Promise<string | undefined>;
	getUserConfig(): Promise<ILensUserOpencodeConfig>;
	patchUserConfig(partial: ILensUserOpencodeConfig): Promise<ILensUserOpencodeConfig>;
	allowEgressHost(hostname: string): Promise<void>;
}
