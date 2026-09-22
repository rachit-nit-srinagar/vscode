/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILensEngineRestartService } from '../../../../platform/lensEngine/common/lensEngineRestart.js';
import { ILensLiteLlmConfigService } from '../../../../platform/lensEngine/common/lensLiteLlmConfig.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const LENS_CATEGORY: ILocalizedString = localize2('lens', 'Lens');

async function restartLensEngine(accessor: ServicesAccessor): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	try {
		await accessor.get(ILensEngineRestartService).restart();
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

		const baseUrl = await quickInputService.input({
			prompt: localize('lens.liteLlm.baseUrlPrompt', "LiteLLM base URL (e.g. https://litellm.example.com)"),
			value: configurationService.getValue<string>('lens.liteLlm.baseUrl') ?? '',
		});
		if (baseUrl === undefined) {
			return;
		}
		await configurationService.updateValue('lens.liteLlm.baseUrl', baseUrl.trim(), ConfigurationTarget.USER);
		await restartLensEngine(accessor);
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

		const apiKey = await quickInputService.input({
			prompt: localize('lens.liteLlm.apiKeyPrompt', "LiteLLM API key (stored encrypted; leave empty to clear)"),
			password: true,
		});
		if (apiKey === undefined) {
			return;
		}
		await lensLiteLlmConfigService.setApiKey(apiKey.trim() || undefined);
		notificationService.notify({ severity: Severity.Info, message: localize('lens.liteLlm.apiKeySaved', "LiteLLM API key saved.") });
		await restartLensEngine(accessor);
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
		await restartLensEngine(accessor);
	}
}

registerAction2(ConfigureLiteLlmConnectionAction);
registerAction2(SetLiteLlmApiKeyAction);
registerAction2(SelectLiteLlmModelsAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		id: 'lens',
		title: 'Lens',
		type: 'object',
		properties: {
			'lens.liteLlm.baseUrl': {
				type: 'string',
				default: '',
				description: localize('lens.liteLlm.baseUrl.description', "Base URL of your LiteLLM proxy. Falls back to the LITELLM_BASE_URL environment variable when unset."),
			},
			'lens.liteLlm.enabledModels': {
				type: 'array',
				items: { type: 'string' },
				default: [],
				description: localize('lens.liteLlm.enabledModels.description', "Model ids from LiteLLM to expose in Lens. Empty means all models LiteLLM reports are exposed. Use \"Lens: Select LiteLLM Models\" to edit this from a picker."),
			},
		},
	});
