/*---------------------------------------------------------------------------------------------
 *  Lens. Proprietary; built on MIT-licensed opencode and VS Code.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { createServer } from 'net';
import { homedir, tmpdir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { parse } from '../../../base/common/jsonc.js';
import { join } from '../../../base/common/path.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ILensUpstreamModel } from '../../lensProxy/common/lensLlmBackend.js';
import { LensOpenAiFacade, ILensFacadeAddress } from '../../lensProxy/electron-main/lensOpenAiFacade.js';
import { LiteLlmBackend } from '../../lensProxy/electron-main/liteLlmBackend.js';
import { ILensLiteLlmConfigService } from '../common/lensLiteLlmConfig.js';
import { LensLiteLlmConfigMainService } from './lensLiteLlmConfigMainService.js';

export const ILensEngineMainService = createDecorator<ILensEngineMainService>('lensEngineMainService');

export interface ILensEngineInfo {
	readonly opencodeUrl: string;
	readonly username: string;
	readonly password: string;
}

export interface ILensEngineMainService {
	readonly _serviceBrand: undefined;
	start(): Promise<ILensEngineInfo | undefined>;
	/** Stops and restarts the engine, re-reading the LiteLLM connection and model settings. */
	restart(): Promise<ILensEngineInfo | undefined>;
	stop(): void;
}

const ENGINE_USERNAME = 'opencode';
const READY_TIMEOUT_MS = 90_000;
const MAX_RESTARTS = 5;
// Env vars that must never reach the engine: the agent can read its own environment.
const SECRET_ENV = ['LITELLM_API_KEY', 'LITELLM_BASE_URL', 'LENS_DEFAULT_MODEL'];

export class LensEngineMainService extends Disposable implements ILensEngineMainService {

	declare readonly _serviceBrand: undefined;

	private facade: LensOpenAiFacade | undefined;
	private child: ChildProcess | undefined;
	private info: ILensEngineInfo | undefined;
	private starting: Promise<ILensEngineInfo | undefined> | undefined;
	private restarts = 0;
	private disposed = false;
	private readonly discoveryFile = join(tmpdir(), `lens-engine-${process.pid}.json`);

	constructor(
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILensLiteLlmConfigService lensLiteLlmConfigService: ILensLiteLlmConfigService,
	) {
		super();
		// Single main-process implementation; readApiKey() is intentionally not on the shared,
		// IPC-exposed interface so the key never travels to the renderer.
		this.lensLiteLlmConfigService = lensLiteLlmConfigService as LensLiteLlmConfigMainService;
	}

	private readonly lensLiteLlmConfigService: LensLiteLlmConfigMainService;

	start(): Promise<ILensEngineInfo | undefined> {
		this.starting ??= this.doStart().catch(error => {
			this.logService.error(`[LensEngine] failed to start: ${error instanceof Error ? error.message : error}`);
			return undefined;
		});
		return this.starting;
	}

	async restart(): Promise<ILensEngineInfo | undefined> {
		this.logService.info('[LensEngine] restarting to pick up LiteLLM connection/model changes');
		this.teardown();
		this.restarts = 0;
		this.starting = undefined;
		return this.start();
	}

	private async doStart(): Promise<ILensEngineInfo | undefined> {
		const settings = await this.readUserSettings();
		const baseUrl = (settings.baseUrl?.trim() || undefined) ?? process.env.LITELLM_BASE_URL;
		if (!baseUrl) {
			this.logService.warn('[LensEngine] no LiteLLM base URL configured (lens.liteLlm.baseUrl or LITELLM_BASE_URL); Lens engine not started.');
			return undefined;
		}
		const apiKey = (await this.lensLiteLlmConfigService.readApiKey()) ?? process.env.LITELLM_API_KEY;
		const opencodeRoot = process.env.LENS_OPENCODE_ROOT ?? join(this.environmentMainService.appRoot, '..', 'opencode');
		if (!existsSync(join(opencodeRoot, 'packages', 'opencode', 'src', 'index.ts'))) {
			throw new Error(`opencode sources not found at ${opencodeRoot} (set LENS_OPENCODE_ROOT)`);
		}

		const backend = new LiteLlmBackend(baseUrl, apiKey);
		this.facade = new LensOpenAiFacade(backend, message => this.logService.info(message));
		const facade = await this.facade.start();

		const allModels = await backend.listModels().catch(error => {
			this.logService.error(`[LensEngine] could not list LiteLLM models: ${error}`);
			return [];
		});
		const enabledIds = settings.enabledModels?.filter(id => typeof id === 'string' && id.length > 0) ?? [];
		const models = enabledIds.length ? allModels.filter(model => enabledIds.includes(model.id)) : allModels;
		if (!models.length) {
			throw new Error(enabledIds.length ? 'none of the models in lens.liteLlm.enabledModels were found on LiteLLM' : 'LiteLLM returned no models');
		}
		this.logService.info(`[LensEngine] ${models.length} models from LiteLLM${enabledIds.length ? ` (filtered from ${allModels.length})` : ''}`);

		const port = await freePort();
		const password = randomBytes(24).toString('hex');
		const info: ILensEngineInfo = { opencodeUrl: `http://127.0.0.1:${port}`, username: ENGINE_USERNAME, password };
		this.spawnEngine(opencodeRoot, port, password, facade, models);
		await waitForReady(info);
		this.info = info;
		await this.writeDiscovery(info);
		this.logService.info(`[LensEngine] ready at ${info.opencodeUrl}`);
		return info;
	}

	private spawnEngine(opencodeRoot: string, port: number, password: string, facade: ILensFacadeAddress, models: ILensUpstreamModel[]): void {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of SECRET_ENV) {
			delete env[key];
		}
		Object.assign(env, {
			OPENCODE_LENS_HARDENED: '1',
			LENS_PRODUCT_NAME: this.productService.nameLong,
			LENS_OPENCODE_PORT: String(port),
			LENS_PROXY_PORT: String(facade.port),
			OPENCODE_SERVER_USERNAME: ENGINE_USERNAME,
			OPENCODE_SERVER_PASSWORD: password,
			OPENCODE_DISABLE_MODELS_FETCH: '1',
			OPENCODE_DISABLE_AUTOUPDATE: '1',
			OPENCODE_CONFIG_CONTENT: JSON.stringify(engineConfig(facade, models)),
		});

		const child = spawn(bunPath(), ['run', 'src/index.ts', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
			cwd: join(opencodeRoot, 'packages', 'opencode'),
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;
		child.stdout?.on('data', data => this.logService.trace(`[LensEngine] ${String(data).trimEnd()}`));
		child.stderr?.on('data', data => this.logService.info(`[LensEngine] ${String(data).trimEnd()}`));
		child.on('exit', code => {
			// Ignore exits of engines we replaced or stopped on purpose; only the current one may trigger a restart.
			if (this.child !== child) {
				return;
			}
			this.child = undefined;
			if (this.disposed) {
				return;
			}
			this.logService.warn(`[LensEngine] engine exited with code ${code}`);
			if (this.restarts >= MAX_RESTARTS) {
				this.logService.error('[LensEngine] giving up after repeated crashes');
				return;
			}
			this.restarts++;
			setTimeout(() => {
				if (!this.disposed) {
					this.spawnEngine(opencodeRoot, port, password, facade, models);
				}
			}, this.restarts * 1000);
		});
	}

	private async readUserSettings(): Promise<{ baseUrl?: string; enabledModels?: string[] }> {
		const settingsFile = join(this.environmentMainService.appSettingsHome.fsPath, 'settings.json');
		try {
			if (!existsSync(settingsFile)) {
				return {};
			}
			const contents = await fs.readFile(settingsFile, 'utf8');
			const parsed = parse<{ 'lens.liteLlm.baseUrl'?: string; 'lens.liteLlm.enabledModels'?: string[] }>(contents) ?? {};
			return { baseUrl: parsed['lens.liteLlm.baseUrl'], enabledModels: parsed['lens.liteLlm.enabledModels'] };
		} catch (error) {
			this.logService.warn(`[LensEngine] could not read user settings.json: ${error instanceof Error ? error.message : error}`);
			return {};
		}
	}

	private async writeDiscovery(info: ILensEngineInfo): Promise<void> {
		const temp = `${this.discoveryFile}.${randomBytes(4).toString('hex')}`;
		await fs.writeFile(temp, JSON.stringify(info), { mode: 0o600 });
		await fs.rename(temp, this.discoveryFile);
	}

	stop(): void {
		this.disposed = true;
		this.teardown();
	}

	private teardown(): void {
		const child = this.child;
		this.child = undefined;
		child?.kill();
		this.facade?.dispose();
		if (this.info) {
			fs.rm(this.discoveryFile, { force: true }).catch(() => undefined);
		}
		this.info = undefined;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}

function engineConfig(facade: ILensFacadeAddress, models: ILensUpstreamModel[]) {
	const preferred = process.env.LENS_DEFAULT_MODEL;
	const defaultModel = models.find(model => model.id === preferred) ?? models[0];
	return {
		$schema: 'https://opencode.ai/config.json',
		enabled_providers: ['lens'],
		disabled_providers: ['opencode'],
		share: 'disabled',
		autoupdate: false,
		model: `lens/${defaultModel.id}`,
		provider: {
			lens: {
				npm: '@ai-sdk/openai-compatible',
				name: 'Lens',
				options: { baseURL: facade.baseUrl, apiKey: facade.token },
				models: Object.fromEntries(models.map(model => [model.id, {
					name: model.name,
					attachment: model.vision,
					modalities: { input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] },
					...(model.contextWindow ? { limit: { context: model.contextWindow, output: model.maxOutputTokens ?? 8192 } } : {}),
				}])),
			},
		},
	};
}

function bunPath(): string {
	if (process.env.LENS_BUN_PATH) {
		return process.env.LENS_BUN_PATH;
	}
	// GUI launches often lack ~/.bun/bin on PATH.
	const local = join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
	return existsSync(local) ? local : 'bun';
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
		});
	});
}

async function waitForReady(info: ILensEngineInfo): Promise<void> {
	const authorization = `Basic ${Buffer.from(`${info.username}:${info.password}`).toString('base64')}`;
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const ok = await fetch(`${info.opencodeUrl}/session`, { headers: { authorization }, signal: AbortSignal.timeout(2000) })
			.then(response => response.ok, () => false);
		if (ok) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`engine did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}
