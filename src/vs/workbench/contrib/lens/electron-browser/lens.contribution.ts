import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILensEngineService, ILensUserOpencodeConfig } from '../../../../platform/lensEngine/common/lensEngine.js';
import { ILensEngineRestartService } from '../../../../platform/lensEngine/common/lensEngineRestart.js';
import { ILensProviderSaveRequest, ILensProvidersService, ILensProviderSummary, LensProviderType } from '../../../../platform/lensEngine/common/lensProviders.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const LENS_CATEGORY: ILocalizedString = localize2('lens', 'Lens');

interface ILensProvidersState {
	readonly providers: ILensProviderSummary[];
	readonly running: boolean;
	readonly error?: string;
}

async function readProvidersState(lensProvidersService: ILensProvidersService, lensEngineService: ILensEngineService): Promise<ILensProvidersState> {
	const [providers, runtime] = await Promise.all([lensProvidersService.list(), lensEngineService.getRuntimeState()]);
	return { providers, running: !!runtime, error: runtime ? undefined : await lensEngineService.getLastError() };
}

class OpenAiProvidersAction extends Action2 {
	constructor() {
		super({
			id: 'lens.openAiProviders',
			category: LENS_CATEGORY,
			title: localize2('lens.openAiProviders', "Open AI Providers"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('lens.providers.focus');
	}
}

// Internal commands backing the Lens Chat extension. The `_` prefix keeps them out of the Command Palette.
class LensProvidersGetAction extends Action2 {
	constructor() {
		super({ id: '_lens.providers.get', title: localize2('lens.providers.get', "Get Lens AI Providers") });
	}

	run(accessor: ServicesAccessor): Promise<ILensProvidersState> {
		return readProvidersState(accessor.get(ILensProvidersService), accessor.get(ILensEngineService));
	}
}

class LensProvidersSaveAction extends Action2 {
	constructor() {
		super({ id: '_lens.providers.save', title: localize2('lens.providers.save', "Save Lens AI Provider") });
	}

	async run(accessor: ServicesAccessor, request?: ILensProviderSaveRequest): Promise<ILensProvidersState> {
		const lensProvidersService = accessor.get(ILensProvidersService);
		const lensEngineService = accessor.get(ILensEngineService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);
		if (!request?.config) {
			throw new Error(localize('lens.providers.missing', "Nothing to save."));
		}
		await lensProvidersService.save(request);
		await lensEngineRestartService.restart();
		return readProvidersState(lensProvidersService, lensEngineService);
	}
}

class LensProvidersRemoveAction extends Action2 {
	constructor() {
		super({ id: '_lens.providers.remove', title: localize2('lens.providers.remove', "Remove Lens AI Provider") });
	}

	async run(accessor: ServicesAccessor, type?: LensProviderType): Promise<ILensProvidersState> {
		const lensProvidersService = accessor.get(ILensProvidersService);
		const lensEngineService = accessor.get(ILensEngineService);
		const lensEngineRestartService = accessor.get(ILensEngineRestartService);
		if (type) {
			await lensProvidersService.remove(type);
			await lensEngineRestartService.restart();
		}
		return readProvidersState(lensProvidersService, lensEngineService);
	}
}

class LensProvidersFetchModelsAction extends Action2 {
	constructor() {
		super({ id: '_lens.providers.fetchModels', title: localize2('lens.providers.fetchModels', "List Lens AI Provider Models") });
	}

	run(accessor: ServicesAccessor, type?: LensProviderType) {
		if (!type) {
			throw new Error(localize('lens.providers.noType', "No provider given."));
		}
		return accessor.get(ILensProvidersService).fetchModels(type);
	}
}

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

registerAction2(OpenAiProvidersAction);
registerAction2(LensProvidersGetAction);
registerAction2(LensProvidersSaveAction);
registerAction2(LensProvidersRemoveAction);
registerAction2(LensProvidersFetchModelsAction);
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
