/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'fs';
import { parse } from '../../../base/common/jsonc.js';
import { join } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { IEncryptionMainService, KnownStorageProvider } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ILensLiteLlmConfigService, ILensLiteLlmModel } from '../common/lensLiteLlmConfig.js';
import { LiteLlmBackend } from '../../lensProxy/electron-main/liteLlmBackend.js';

export class LensLiteLlmConfigMainService implements ILensLiteLlmConfigService {

	declare readonly _serviceBrand: undefined;

	private readonly keyFile: string;
	private readonly appSettingsHome: string;

	constructor(
		@IEncryptionMainService private readonly encryptionMainService: IEncryptionMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		this.keyFile = join(environmentMainService.userDataPath, 'lens-litellm-key.json');
		this.appSettingsHome = environmentMainService.appSettingsHome.fsPath;
	}

	async setApiKey(apiKey: string | undefined): Promise<void> {
		if (!apiKey) {
			await fs.rm(this.keyFile, { force: true });
			return;
		}
		await this.assertRealKeyStorage();
		const encrypted = await this.encryptionMainService.encrypt(apiKey);
		await fs.writeFile(this.keyFile, encrypted, { mode: 0o600 });
	}

	async hasApiKey(): Promise<boolean> {
		return existsSync(this.keyFile);
	}

	async listModels(baseUrl: string): Promise<ILensLiteLlmModel[]> {
		// The key only ever goes to the URL the user configured, never to a caller-supplied one.
		const settings = await readLensUserSettings(this.appSettingsHome, message => this.logService.warn(`[LensLiteLlmConfig] ${message}`));
		const configured = settings.baseUrl?.trim() || process.env.LITELLM_BASE_URL;
		if (!configured || normalizeBaseUrl(configured) !== normalizeBaseUrl(baseUrl)) {
			throw new Error('LiteLLM base URL does not match the configured lens.liteLlm.baseUrl');
		}
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

	private async assertRealKeyStorage(): Promise<void> {
		if (!await this.encryptionMainService.isEncryptionAvailable()) {
			throw new Error('OS encryption is not available; set LITELLM_API_KEY in the environment instead.');
		}
		// On Linux without a keyring, safeStorage silently falls back to a fixed built-in key.
		if (isLinux) {
			const provider = await this.encryptionMainService.getKeyStorageProvider();
			if (provider === KnownStorageProvider.basicText || provider === KnownStorageProvider.unknown) {
				throw new Error('No OS keyring (GNOME Keyring or KWallet) is available, so the key cannot be stored securely; set LITELLM_API_KEY in the environment instead.');
			}
		}
	}
}

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export async function readLensUserSettings(appSettingsHome: string, warn: (message: string) => void): Promise<{ baseUrl?: string; enabledModels?: string[] }> {
	const settingsFile = join(appSettingsHome, 'settings.json');
	try {
		if (!existsSync(settingsFile)) {
			return {};
		}
		const parsed = parse<{ 'lens.liteLlm.baseUrl'?: string; 'lens.liteLlm.enabledModels'?: string[] }>(await fs.readFile(settingsFile, 'utf8')) ?? {};
		return { baseUrl: parsed['lens.liteLlm.baseUrl'], enabledModels: parsed['lens.liteLlm.enabledModels'] };
	} catch (error) {
		warn(`could not read user settings.json: ${error instanceof Error ? error.message : error}`);
		return {};
	}
}
