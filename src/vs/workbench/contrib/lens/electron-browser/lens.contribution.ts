import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILensEngineRestartService } from '../../../../platform/lensEngine/common/lensEngineRestart.js';
import { ILensEngineService, ILensUserOpencodeConfig } from '../../../../platform/lensEngine/common/lensEngine.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ILensLiteLlmConfigService } from '../../../../platform/lensEngine/common/lensLiteLlmConfig.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const LENS_CATEGORY: ILocalizedString = localize2('lens', 'Lens');

async function restartLensEngine(lensEngineRestartService: ILensEngineRestartService, notificationService: INotificationService): Promise<void> {
	try {
		await lensEngineRestartService.restart();
		notificationService.info(localize('lens.liteLlm.engineRestarted', "Lens engine restarted with the updated LiteLLM configuration."));
	} catch (error) {
		notificationService.error(localize('lens.liteLlm.engineRestartFailed', "Lens engine did not restart: {0}", error instanceof Error ? error.message : String(error)));
	}
}

class ConfigureLiteLlmConnectionAction extends Action2 {
	constructor() {
		super({
			id: 'lens.liteLlm.configureConnection',
			category: LENS_CATEGORY,
			title: localize2('lens.liteLlm.configureConnection', "Configure LiteLLM Connection"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);
		const notificationService = accessor.get(INotificationService);

		const baseUrl = await quickInputService.input({
			prompt: localize('lens.liteLlm.baseUrlPrompt', "LiteLLM base URL (e.g. https://litellm.example.com)"),
			value: configurationService.getValue<string>('lens.liteLlm.baseUrl') ?? '',
		});
		if (baseUrl === undefined) {
			return;
		}
		await configurationService.updateValue('lens.liteLlm.baseUrl', baseUrl.trim(), ConfigurationTarget.USER);
		await restartLensEngine(lensEngineRestartService, notificationService);
	}
}

class SetLiteLlmApiKeyAction extends Action2 {
	constructor() {
		super({
			id: 'lens.liteLlm.setApiKey',
			category: LENS_CATEGORY,
			title: localize2('lens.liteLlm.setApiKey', "Set LiteLLM API Key"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const lensLiteLlmConfigService = accessor.get(ILensLiteLlmConfigService);
		const notificationService = accessor.get(INotificationService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);

		const apiKey = await quickInputService.input({
			prompt: localize('lens.liteLlm.apiKeyPrompt', "LiteLLM API key (stored encrypted; leave empty to clear)"),
			password: true,
		});
		if (apiKey === undefined) {
			return;
		}
		await lensLiteLlmConfigService.setApiKey(apiKey.trim() || undefined);
		notificationService.notify({ severity: Severity.Info, message: localize('lens.liteLlm.apiKeySaved', "LiteLLM API key saved.") });
		await restartLensEngine(lensEngineRestartService, notificationService);
	}
}

class SelectLiteLlmModelsAction extends Action2 {
	constructor() {
		super({
			id: 'lens.liteLlm.selectModels',
			category: LENS_CATEGORY,
			title: localize2('lens.liteLlm.selectModels', "Select LiteLLM Models"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const lensLiteLlmConfigService = accessor.get(ILensLiteLlmConfigService);
		const notificationService = accessor.get(INotificationService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);

		const baseUrl = configurationService.getValue<string>('lens.liteLlm.baseUrl');
		if (!baseUrl) {
			notificationService.warn(localize('lens.liteLlm.noBaseUrl', "Configure the LiteLLM connection first (Lens: Configure LiteLLM Connection)."));
			return;
		}

		let models;
		try {
			models = await lensLiteLlmConfigService.listModels(baseUrl);
		} catch (error) {
			notificationService.error(localize('lens.liteLlm.listModelsFailed', "Could not list LiteLLM models: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		if (!models.length) {
			notificationService.warn(localize('lens.liteLlm.noModels', "LiteLLM returned no models."));
			return;
		}

		const enabled = new Set(configurationService.getValue<string[]>('lens.liteLlm.enabledModels') ?? []);
		const picks = models.map(model => ({ label: model.name, description: model.id, picked: enabled.size === 0 || enabled.has(model.id), id: model.id }));
		const result = await quickInputService.pick(picks, {
			canPickMany: true,
			placeHolder: localize('lens.liteLlm.selectModelsPlaceholder', "Select the models to expose in Lens (none selected = all models)"),
		});
		if (result === undefined) {
			return;
		}
		const selectedIds = result.map(pick => pick.id);
		await configurationService.updateValue('lens.liteLlm.enabledModels', selectedIds.length === models.length ? [] : selectedIds, ConfigurationTarget.USER);
		await restartLensEngine(lensEngineRestartService, notificationService);
	}
}

registerAction2(ConfigureLiteLlmConnectionAction);
registerAction2(SetLiteLlmApiKeyAction);
registerAction2(SelectLiteLlmModelsAction);

// Internal commands backing the Lens Chat extension. The `_` prefix keeps them out of the Command Palette.
class LensEngineGetRuntimeAction extends Action2 {
	constructor() {
		super({ id: '_lens.engine.getRuntime', title: localize2('lens.engine.getRuntime', "Get Lens Engine Runtime") });
	}

	run(accessor: ServicesAccessor) {
		return accessor.get(ILensEngineService).getRuntimeState();
	}
}

class LensEngineGetUserConfigAction extends Action2 {
	constructor() {
		super({ id: '_lens.engine.getUserConfig', title: localize2('lens.engine.getUserConfig', "Get Lens Engine User Config") });
	}

	run(accessor: ServicesAccessor) {
		return accessor.get(ILensEngineService).getUserConfig();
	}
}

class LensEnginePatchUserConfigAction extends Action2 {
	constructor() {
		super({ id: '_lens.engine.patchUserConfig', title: localize2('lens.engine.patchUserConfig', "Patch Lens Engine User Config") });
	}

	run(accessor: ServicesAccessor, partial?: ILensUserOpencodeConfig) {
		return accessor.get(ILensEngineService).patchUserConfig(partial ?? {});
	}
}

class LensEngineAllowEgressAction extends Action2 {
	constructor() {
		super({ id: '_lens.engine.allowEgress', title: localize2('lens.engine.allowEgress', "Allow Lens Egress Host") });
	}

	async run(accessor: ServicesAccessor, hostname?: string): Promise<void> {
		if (!hostname) {
			return;
		}
		const lensEngineService = accessor.get(ILensEngineService);
		const dialogService = accessor.get(IDialogService);
		// Confirm natively: webview content must not be able to widen network access on its own.
		const { confirmed } = await dialogService.confirm({
			message: localize('lens.engine.allowEgress.message', "Allow Lens to connect to {0}?", hostname),
			detail: localize('lens.engine.allowEgress.detail', "The Lens agent will be able to send requests to this host."),
			primaryButton: localize('lens.engine.allowEgress.allow', "Allow"),
		});
		if (!confirmed) {
			throw new Error(`Connection to ${hostname} was not allowed`);
		}
		await lensEngineService.allowEgressHost(hostname);
	}
}

interface ILensConnectionState {
	readonly baseUrl: string;
	readonly hasApiKey: boolean;
	readonly enabledModels: readonly string[];
	readonly running: boolean;
	readonly error?: string;
}

async function readConnectionState(configurationService: IConfigurationService, lensLiteLlmConfigService: ILensLiteLlmConfigService, lensEngineService: ILensEngineService): Promise<ILensConnectionState> {
	const running = !!await lensEngineService.getRuntimeState();
	return {
		baseUrl: configurationService.getValue<string>('lens.liteLlm.baseUrl') ?? '',
		hasApiKey: await lensLiteLlmConfigService.hasApiKey(),
		enabledModels: configurationService.getValue<string[]>('lens.liteLlm.enabledModels') ?? [],
		running,
		error: running ? undefined : await lensEngineService.getLastError(),
	};
}

class LensConnectionGetAction extends Action2 {
	constructor() {
		super({ id: '_lens.connection.get', title: localize2('lens.connection.get', "Get Lens Connection") });
	}

	run(accessor: ServicesAccessor): Promise<ILensConnectionState> {
		return readConnectionState(accessor.get(IConfigurationService), accessor.get(ILensLiteLlmConfigService), accessor.get(ILensEngineService));
	}
}

class LensConnectionSaveAction extends Action2 {
	constructor() {
		super({ id: '_lens.connection.save', title: localize2('lens.connection.save', "Save Lens Connection") });
	}

	async run(accessor: ServicesAccessor, input?: { baseUrl?: string; apiKey?: string; clearApiKey?: boolean }): Promise<ILensConnectionState> {
		const configurationService = accessor.get(IConfigurationService);
		const lensLiteLlmConfigService = accessor.get(ILensLiteLlmConfigService);
		const lensEngineService = accessor.get(ILensEngineService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);

		const baseUrl = (input?.baseUrl ?? '').trim().replace(/\/+$/, '');
		if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
			throw new Error(localize('lens.connection.invalidUrl', "Enter a URL that starts with http:// or https://"));
		}
		const previous = (configurationService.getValue<string>('lens.liteLlm.baseUrl') ?? '').trim().replace(/\/+$/, '');
		const apiKey = input?.apiKey?.trim();
		// A stored key is only ever sent to the URL it was entered for.
		if (apiKey) {
			await lensLiteLlmConfigService.setApiKey(apiKey);
		} else if (input?.clearApiKey || (previous && previous !== baseUrl)) {
			await lensLiteLlmConfigService.setApiKey(undefined);
		}
		await configurationService.updateValue('lens.liteLlm.baseUrl', baseUrl, ConfigurationTarget.USER);
		await lensEngineRestartService.restart();
		return readConnectionState(configurationService, lensLiteLlmConfigService, lensEngineService);
	}
}

class LensConnectionListModelsAction extends Action2 {
	constructor() {
		super({ id: '_lens.connection.listModels', title: localize2('lens.connection.listModels', "List Lens Connection Models") });
	}

	run(accessor: ServicesAccessor) {
		const baseUrl = accessor.get(IConfigurationService).getValue<string>('lens.liteLlm.baseUrl');
		if (!baseUrl) {
			throw new Error(localize('lens.connection.noUrl', "Save a LiteLLM URL first."));
		}
		return accessor.get(ILensLiteLlmConfigService).listModels(baseUrl);
	}
}

class LensConnectionSetModelsAction extends Action2 {
	constructor() {
		super({ id: '_lens.connection.setModels', title: localize2('lens.connection.setModels', "Set Lens Connection Models") });
	}

	async run(accessor: ServicesAccessor, ids?: string[]): Promise<ILensConnectionState> {
		const configurationService = accessor.get(IConfigurationService);
		const lensLiteLlmConfigService = accessor.get(ILensLiteLlmConfigService);
		const lensEngineService = accessor.get(ILensEngineService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);
		const clean = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.length > 0) : [];
		await configurationService.updateValue('lens.liteLlm.enabledModels', clean, ConfigurationTarget.USER);
		await lensEngineRestartService.restart();
		return readConnectionState(configurationService, lensLiteLlmConfigService, lensEngineService);
	}
}

registerAction2(LensConnectionGetAction);
registerAction2(LensConnectionSaveAction);
registerAction2(LensConnectionListModelsAction);
registerAction2(LensConnectionSetModelsAction);
registerAction2(LensEngineGetRuntimeAction);
registerAction2(LensEngineGetUserConfigAction);
registerAction2(LensEnginePatchUserConfigAction);
registerAction2(LensEngineAllowEgressAction);

// Lens Chat replaces the built-in AI chat.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		[ChatAIDisabledSettingId]: true,
	},
}]);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		id: 'lens',
		title: 'Lens',
		type: 'object',
		properties: {
			'lens.liteLlm.baseUrl': {
				type: 'string',
				// Application scope: a workspace must not be able to redirect the stored API key.
				scope: ConfigurationScope.APPLICATION,
				default: '',
				description: localize('lens.liteLlm.baseUrl.description', "Base URL of your LiteLLM proxy. Falls back to the LITELLM_BASE_URL environment variable when unset."),
			},
			'lens.liteLlm.enabledModels': {
				type: 'array',
				// Application scope: a workspace must not be able to redirect the stored API key.
				scope: ConfigurationScope.APPLICATION,
				items: { type: 'string' },
				default: [],
				description: localize('lens.liteLlm.enabledModels.description', "Model ids from LiteLLM to expose in Lens. Empty means all models LiteLLM reports are exposed. Use \"Lens: Select LiteLLM Models\" to edit this from a picker."),
			},
		},
	});
