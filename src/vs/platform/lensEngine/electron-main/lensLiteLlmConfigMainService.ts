/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ILensLiteLlmConfigService, ILensLiteLlmModel } from '../common/lensLiteLlmConfig.js';
import { LiteLlmBackend } from '../../lensProxy/electron-main/liteLlmBackend.js';

export class LensLiteLlmConfigMainService implements ILensLiteLlmConfigService {

	declare readonly _serviceBrand: undefined;

	private readonly keyFile: string;

	constructor(
		@IEncryptionMainService private readonly encryptionMainService: IEncryptionMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		this.keyFile = join(environmentMainService.userDataPath, 'lens-litellm-key.json');
	}

	async setApiKey(apiKey: string | undefined): Promise<void> {
		if (!apiKey) {
			await fs.rm(this.keyFile, { force: true });
			return;
		}
		const encrypted = await this.encryptionMainService.encrypt(apiKey);
		await fs.writeFile(this.keyFile, encrypted, { mode: 0o600 });
	}

	async hasApiKey(): Promise<boolean> {
		return existsSync(this.keyFile);
	}

	async listModels(baseUrl: string): Promise<ILensLiteLlmModel[]> {
		const apiKey = await this.readApiKey();
		const backend = new LiteLlmBackend(baseUrl, apiKey ?? process.env.LITELLM_API_KEY);
		const models = await backend.listModels();
		return models.map(model => ({ id: model.id, name: model.name }));
	}

	/**
	 * In-process only (not part of the IPC-exposed interface): the engine's own bootstrap
	 * reads the key directly, without a round trip through the renderer.
	 */
	async readApiKey(): Promise<string | undefined> {
		if (!existsSync(this.keyFile)) {
			return undefined;
		}
		try {
			const encrypted = await fs.readFile(this.keyFile, 'utf8');
			return await this.encryptionMainService.decrypt(encrypted);
		} catch (error) {
			this.logService.error(`[LensLiteLlmConfig] failed to read stored API key: ${error instanceof Error ? error.message : error}`);
			return undefined;
		}
	}
}
