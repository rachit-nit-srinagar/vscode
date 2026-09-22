import { existsSync, promises as fs } from 'fs';
import { parse } from '../../../base/common/jsonc.js';
import { join } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { IEncryptionMainService, KnownStorageProvider } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { fetchProviderModels, ILensResolvedProvider, providerEndpoint } from '../../lensProxy/electron-main/providerRouterBackend.js';
import { ILensProviderConfig, ILensProviderModel, ILensProviderSaveRequest, ILensProvidersService, ILensProviderSummary, LENS_PROVIDER_TYPES, LensProviderType } from '../common/lensProviders.js';

export const ILensProvidersMainService = createDecorator<ILensProvidersMainService>('lensProvidersMainService');

export interface ILensProvidersMainService extends ILensProvidersService {
	/** In-process only: configured providers with decrypted keys, for the engine's router. Never exposed over IPC. */
	resolveProviders(): Promise<ILensResolvedProvider[]>;
}

type KeyStore = Partial<Record<LensProviderType, string>>;

export class LensProvidersMainService implements ILensProvidersMainService {

	declare readonly _serviceBrand: undefined;

	private readonly configFile: string;
	private readonly keyFile: string;
	private readonly userDataPath: string;
	private readonly appSettingsHome: string;
	private migrated = false;

	constructor(
		@IEncryptionMainService private readonly encryptionMainService: IEncryptionMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		this.userDataPath = environmentMainService.userDataPath;
		this.appSettingsHome = environmentMainService.appSettingsHome.fsPath;
		this.configFile = join(this.userDataPath, 'lens-providers.json');
		this.keyFile = join(this.userDataPath, 'lens-provider-keys.json');
	}

	async list(): Promise<ILensProviderSummary[]> {
		const [configs, keys] = await Promise.all([this.readConfigs(), this.readKeys()]);
		return configs.map(config => ({ ...config, hasApiKey: !!keys[config.type] }));
	}

	async save(request: ILensProviderSaveRequest): Promise<ILensProviderSummary[]> {
		const config = sanitizeConfig(request.config);
		// Validates the endpoint fields (URL, resource name, gateway ids) before anything is stored.
		const endpoint = providerEndpoint(config, undefined).baseUrl;
		const configs = await this.readConfigs();
		const previous = configs.find(item => item.type === config.type);
		const keys = await this.readKeys();
		const apiKey = request.apiKey?.trim();
		if (apiKey) {
			await this.assertRealKeyStorage();
			keys[config.type] = await this.encryptionMainService.encrypt(apiKey);
		} else if (request.clearApiKey || (previous && providerEndpoint(previous, undefined).baseUrl !== endpoint)) {
			// A stored key is only ever sent to the endpoint it was entered for.
			delete keys[config.type];
		}
		await this.writeKeys(keys);
		await this.writeConfigs([...configs.filter(item => item.type !== config.type), config]);
		return this.list();
	}

	async remove(type: LensProviderType): Promise<ILensProviderSummary[]> {
		const keys = await this.readKeys();
		delete keys[type];
		await this.writeKeys(keys);
		await this.writeConfigs((await this.readConfigs()).filter(item => item.type !== type));
		return this.list();
	}

	async fetchModels(type: LensProviderType): Promise<ILensProviderModel[]> {
		const provider = (await this.resolveProviders()).find(item => item.config.type === type);
		if (!provider) {
			throw new Error('Save this provider first.');
		}
		const models = await fetchProviderModels({ config: { ...provider.config, models: provider.config.models }, apiKey: provider.apiKey });
		return models.map(model => ({ id: model.id, name: model.name }));
	}

	async resolveProviders(): Promise<ILensResolvedProvider[]> {
		const [configs, keys] = await Promise.all([this.readConfigs(), this.readKeys()]);
		const resolved: ILensResolvedProvider[] = [];
		for (const config of configs) {
			resolved.push({ config, apiKey: keys[config.type] ? await this.decrypt(keys[config.type]!, config.type) : undefined });
		}
		// Development fallback: a LiteLLM from the environment when nothing is configured in Lens.
		if (!resolved.length && process.env.LITELLM_BASE_URL) {
			resolved.push({ config: { type: 'litellm', baseUrl: process.env.LITELLM_BASE_URL, models: [] }, apiKey: process.env.LITELLM_API_KEY });
		}
		return resolved;
	}

	private async readConfigs(): Promise<ILensProviderConfig[]> {
		await this.migrateLegacyLiteLlm();
		try {
			const parsed = JSON.parse(await fs.readFile(this.configFile, 'utf8')) as unknown;
			return Array.isArray(parsed) ? parsed.flatMap(item => {
				try {
					return [sanitizeConfig(item)];
				} catch {
					return [];
				}
			}) : [];
		} catch {
			return [];
		}
	}

	private async writeConfigs(configs: ILensProviderConfig[]): Promise<void> {
		const ordered = LENS_PROVIDER_TYPES.flatMap(type => configs.filter(config => config.type === type));
		await fs.writeFile(this.configFile, JSON.stringify(ordered, null, 2), { mode: 0o600 });
	}

	private async readKeys(): Promise<KeyStore> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.keyFile, 'utf8')) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as KeyStore : {};
		} catch {
			return {};
		}
	}

	private async writeKeys(keys: KeyStore): Promise<void> {
		await fs.writeFile(this.keyFile, JSON.stringify(keys), { mode: 0o600 });
	}

	private async decrypt(value: string, type: LensProviderType): Promise<string | undefined> {
		try {
			return await this.encryptionMainService.decrypt(value);
		} catch (error) {
			this.logService.error(`[LensProviders] could not read the stored ${type} key: ${error instanceof Error ? error.message : error}`);
			return undefined;
		}
	}

	private async assertRealKeyStorage(): Promise<void> {
		if (!await this.encryptionMainService.isEncryptionAvailable()) {
			throw new Error('OS encryption is not available, so the key cannot be stored securely.');
		}
		// On Linux without a keyring, safeStorage silently falls back to a fixed built-in key.
		if (isLinux) {
			const provider = await this.encryptionMainService.getKeyStorageProvider();
			if (provider === KnownStorageProvider.basicText || provider === KnownStorageProvider.unknown) {
				throw new Error('No OS keyring (GNOME Keyring or KWallet) is available, so the key cannot be stored securely.');
			}
		}
	}

	/** Moves the earlier single-LiteLLM settings (lens.liteLlm.* and its key file) into the LiteLLM provider, once. */
	private async migrateLegacyLiteLlm(): Promise<void> {
		if (this.migrated) {
			return;
		}
		this.migrated = true;
		if (existsSync(this.configFile)) {
			return;
		}
		const legacyKeyFile = join(this.userDataPath, 'lens-litellm-key.json');
		let settings: { 'lens.liteLlm.baseUrl'?: string; 'lens.liteLlm.enabledModels'?: string[] } = {};
		try {
			settings = parse(await fs.readFile(join(this.appSettingsHome, 'settings.json'), 'utf8')) ?? {};
		} catch {
			// No user settings yet.
		}
		const baseUrl = settings['lens.liteLlm.baseUrl']?.trim();
		if (!baseUrl) {
			return;
		}
		const config: ILensProviderConfig = { type: 'litellm', baseUrl, models: settings['lens.liteLlm.enabledModels'] ?? [] };
		await fs.writeFile(this.configFile, JSON.stringify([config], null, 2), { mode: 0o600 });
		if (existsSync(legacyKeyFile)) {
			await this.writeKeys({ litellm: await fs.readFile(legacyKeyFile, 'utf8') });
			await fs.rm(legacyKeyFile, { force: true });
		}
		this.logService.info('[LensProviders] migrated the LiteLLM connection into AI Providers');
	}
}

function sanitizeConfig(value: unknown): ILensProviderConfig {
	const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const type = input.type as LensProviderType;
	if (!LENS_PROVIDER_TYPES.includes(type)) {
		throw new Error(`Unknown provider: ${String(input.type)}`);
	}
	const text = (key: string) => typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : undefined;
	const models = Array.isArray(input.models) ? [...new Set(input.models.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))] : [];
	return {
		type,
		baseUrl: text('baseUrl'),
		resourceName: text('resourceName'),
		accountId: text('accountId'),
		gatewayId: text('gatewayId'),
		headerName: text('headerName'),
		models,
	};
}
