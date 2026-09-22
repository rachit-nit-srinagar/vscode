import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ILensUpstreamModel } from '../../lensProxy/common/lensLlmBackend.js';
import { LensOpenAiFacade, ILensFacadeAddress } from '../../lensProxy/electron-main/lensOpenAiFacade.js';
import { LiteLlmBackend } from '../../lensProxy/electron-main/liteLlmBackend.js';
import { ILensLiteLlmConfigService } from '../common/lensLiteLlmConfig.js';
import { LensLiteLlmConfigMainService, readLensUserSettings } from './lensLiteLlmConfigMainService.js';
import { ILensEngineRuntimeState, ILensUserOpencodeConfig } from '../common/lensEngine.js';

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
	getRuntimeState(): ILensEngineRuntimeState | undefined;
	/** Why the last start attempt failed, if it did. */
	getLastError(): string | undefined;
	getUserConfig(): Promise<ILensUserOpencodeConfig>;
	/** Persists the change and restarts the engine so it takes effect. */
	patchUserConfig(partial: ILensUserOpencodeConfig): Promise<ILensUserOpencodeConfig>;
	allowEgressHost(hostname: string): Promise<void>;
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
	private lastError: string | undefined;
	private readonly userConfigFile: string;
	private readonly egressFile: string;

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
		this.userConfigFile = join(environmentMainService.userDataPath, 'lens-opencode-user.json');
		this.egressFile = join(environmentMainService.userDataPath, 'lens-egress-extra.txt');
	}

	private readonly lensLiteLlmConfigService: LensLiteLlmConfigMainService;

	start(): Promise<ILensEngineInfo | undefined> {
		this.lastError = undefined;
		this.starting ??= this.doStart().catch(error => {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.logService.error(`[LensEngine] failed to start: ${this.lastError}`);
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

	getLastError(): string | undefined {
		return this.lastError;
	}

	getRuntimeState(): ILensEngineRuntimeState | undefined {
		return this.info ? { opencodeUrl: this.info.opencodeUrl, opencodeUsername: this.info.username, opencodePassword: this.info.password } : undefined;
	}

	async getUserConfig(): Promise<ILensUserOpencodeConfig> {
		try {
			return sanitizeUserConfig(JSON.parse(await fs.readFile(this.userConfigFile, 'utf8')));
		} catch {
			return {};
		}
	}

	async patchUserConfig(partial: ILensUserOpencodeConfig): Promise<ILensUserOpencodeConfig> {
		const current = await this.getUserConfig();
		const incoming = sanitizeUserConfig(partial);
		const next = sanitizeUserConfig({ ...current, ...incoming, mcp: incoming.mcp ? { ...current.mcp, ...incoming.mcp } : current.mcp });
		await fs.writeFile(this.userConfigFile, JSON.stringify(next, null, 2), { mode: 0o600 });
		if (this.info) {
			void this.restart();
		}
		return next;
	}

	async allowEgressHost(hostname: string): Promise<void> {
		const host = hostname.trim().toLowerCase().replace(/^\.+|\.$/g, '');
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || /(^|\.)(opencode\.ai|opncd\.ai)$/.test(host)) {
			throw new Error(`Host is not allowed: ${hostname}`);
		}
		const existing = await fs.readFile(this.egressFile, 'utf8').catch(() => '');
		const hosts = new Set(existing.split(/\s+/).filter(Boolean));
		hosts.add(host);
		await fs.writeFile(this.egressFile, [...hosts].join('\n') + '\n', { mode: 0o600 });
	}

	private async doStart(): Promise<ILensEngineInfo | undefined> {
		const settings = await readLensUserSettings(this.environmentMainService.appSettingsHome.fsPath, message => this.logService.warn(`[LensEngine] ${message}`));
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
		const userConfig = await this.getUserConfig();
		this.spawnEngine(opencodeRoot, port, password, facade, models, userConfig);
		await waitForReady(info);
		this.info = info;
		this.logService.info(`[LensEngine] ready at ${info.opencodeUrl}`);
		return info;
	}

	private spawnEngine(opencodeRoot: string, port: number, password: string, facade: ILensFacadeAddress, models: ILensUpstreamModel[], userConfig: ILensUserOpencodeConfig): void {
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
			// A workspace must not be able to loosen permissions or add agents/instructions via its own opencode config.
			OPENCODE_DISABLE_PROJECT_CONFIG: '1',
			OPENCODE_LENS_EGRESS_EXTRA_FILE: this.egressFile,
			// Only the user's own Lens settings can opt into plugins or local MCP servers.
			OPENCODE_LENS_ALLOW_USER_PLUGINS: userConfig.pluginsAllowed ? '1' : '',
			OPENCODE_LENS_ALLOW_LOCAL_MCP: hasLocalMcp(userConfig) ? '1' : '',
			OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeUserConfig(engineConfig(facade, models), userConfig)),
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
					this.spawnEngine(opencodeRoot, port, password, facade, models, userConfig);
				}
			}, this.restarts * 1000);
		});
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
		// Reads are free; anything that changes the machine needs the user's approval in Lens Chat.
		permission: {
			read: 'allow',
			glob: 'allow',
			grep: 'allow',
			list: 'allow',
			websearch: 'allow',
			webfetch: 'allow',
			bash: 'ask',
			edit: 'ask',
			external_directory: 'ask',
		},
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

const USER_CONFIG_KEYS = ['mcp', 'plugin', 'skills', 'command', 'agent', 'instructions', 'pluginsAllowed', 'hooksAllowed'] as const;

/** Keeps only the user-editable keys and drops per-agent permission/tool overrides, which could bypass approvals. */
function sanitizeUserConfig(value: unknown): ILensUserOpencodeConfig {
	if (!value || typeof value !== 'object') {
		return {};
	}
	const input = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of USER_CONFIG_KEYS) {
		if (input[key] !== undefined) {
			out[key] = input[key];
		}
	}
	if (out.mcp !== undefined && (typeof out.mcp !== 'object' || out.mcp === null)) {
		delete out.mcp;
	}
	if (out.agent && typeof out.agent === 'object') {
		out.agent = Object.fromEntries(Object.entries(out.agent as Record<string, unknown>).map(([name, agent]) => {
			if (!agent || typeof agent !== 'object') {
				return [name, agent];
			}
			const { permission: _permission, tools: _tools, ...rest } = agent as Record<string, unknown>;
			return [name, rest];
		}));
	}
	out.pluginsAllowed = out.pluginsAllowed === true;
	out.hooksAllowed = out.hooksAllowed === true;
	return out as ILensUserOpencodeConfig;
}

function mergeUserConfig(managed: Record<string, unknown>, user: ILensUserOpencodeConfig): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...managed };
	for (const key of ['mcp', 'skills', 'command', 'agent', 'instructions'] as const) {
		if (user[key] !== undefined) {
			merged[key] = user[key];
		}
	}
	if (user.pluginsAllowed && user.plugin !== undefined) {
		merged.plugin = user.plugin;
	}
	return merged;
}

function hasLocalMcp(user: ILensUserOpencodeConfig): boolean {
	return Object.values(user.mcp ?? {}).some(server => !!server && typeof server === 'object' && (server as { type?: unknown }).type === 'local');
}
