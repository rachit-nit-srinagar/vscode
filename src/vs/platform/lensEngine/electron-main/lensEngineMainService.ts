import { ChildProcess, execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { rgDiskPath } from '../../../base/node/ripgrep.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ILensUpstreamModel } from '../../lensProxy/common/lensLlmBackend.js';
import { LensOpenAiFacade, ILensFacadeAddress } from '../../lensProxy/electron-main/lensOpenAiFacade.js';
import { ProviderRouterBackend } from '../../lensProxy/electron-main/providerRouterBackend.js';
import { ILensProvidersMainService } from './lensProvidersMainService.js';
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
	/** Stops and restarts the engine, re-reading the AI provider settings. */
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
const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_OUTPUT_TOKENS = 8192;
// Kept in sync with Lens Chat's own EFFORTS list (extensions/lens-chat/webview/src/App.tsx).
const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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
	private defaultModel: string | undefined;
	private readonly userConfigFile: string;
	private readonly egressFile: string;
	/** The engine's own config/data/state/cache, apart from any personal opencode install. */
	private readonly runtimeRoot: string;
	private readonly pidFile: string;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILensProvidersMainService private readonly lensProvidersService: ILensProvidersMainService,
	) {
		super();
		this.userConfigFile = join(environmentMainService.userDataPath, 'lens-opencode-user.json');
		this.egressFile = join(environmentMainService.userDataPath, 'lens-egress-extra.txt');
		this.runtimeRoot = join(environmentMainService.userDataPath, 'lens-engine');
		this.pidFile = join(this.runtimeRoot, 'engine.pid');
	}

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
		this.logService.info('[LensEngine] restarting to pick up AI provider changes');
		this.teardown();
		this.restarts = 0;
		this.starting = undefined;
		return this.start();
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	getRuntimeState(): ILensEngineRuntimeState | undefined {
		return this.info ? { opencodeUrl: this.info.opencodeUrl, opencodeUsername: this.info.username, opencodePassword: this.info.password, defaultModel: this.defaultModel } : undefined;
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
		const providers = await this.lensProvidersService.resolveProviders();
		if (!providers.length) {
			throw new Error('No AI provider is set up yet. Add one under Lens → AI Providers.');
		}
		const opencodeRoot = process.env.LENS_OPENCODE_ROOT ?? join(this.environmentMainService.appRoot, '..', 'opencode');
		if (!existsSync(join(opencodeRoot, 'packages', 'opencode', 'src', 'index.ts'))) {
			throw new Error(`opencode sources not found at ${opencodeRoot} (set LENS_OPENCODE_ROOT)`);
		}

		const backend = new ProviderRouterBackend(providers, message => this.logService.warn(message));
		const models = await backend.listModels();
		if (!models.length) {
			throw new Error('None of your AI providers returned any models. Check the keys and model choices under Lens → AI Providers.');
		}
		this.logService.info(`[LensEngine] ${models.length} models from ${providers.map(provider => provider.config.type).join(', ')}`);
		this.facade = new LensOpenAiFacade(backend, message => this.logService.info(message));
		const facade = await this.facade.start();

		const port = await freePort();
		const password = randomBytes(24).toString('hex');
		const info: ILensEngineInfo = { opencodeUrl: `http://127.0.0.1:${port}`, username: ENGINE_USERNAME, password };
		const userConfig = await this.getUserConfig();
		await this.stopStaleEngine();
		await Promise.all(['config', 'data', 'state', 'cache'].map(dir => fs.mkdir(join(this.runtimeRoot, dir), { recursive: true, mode: 0o700 })));
		const ripgrep = await rgDiskPath().then(path => existsSync(path) ? path : undefined, () => undefined);
		this.defaultModel = `lens/${chooseDefaultModel(models).id}`;
		this.spawnEngine(opencodeRoot, port, password, facade, models, userConfig, ripgrep);
		await waitForReady(info);
		this.info = info;
		this.logService.info(`[LensEngine] ready at ${info.opencodeUrl}`);
		return info;
	}

	private spawnEngine(opencodeRoot: string, port: number, password: string, facade: ILensFacadeAddress, models: ILensUpstreamModel[], userConfig: ILensUserOpencodeConfig, ripgrep: string | undefined): void {
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
			// Lens is not Claude Code: never read another tool's ~/.claude/skills or ~/.claude/CLAUDE.md.
			OPENCODE_DISABLE_CLAUDE_CODE: '1',
			OPENCODE_LENS_EGRESS_EXTRA_FILE: this.egressFile,
			// Only the user's own Lens settings can opt into plugins or local MCP servers.
			OPENCODE_LENS_ALLOW_USER_PLUGINS: userConfig.pluginsAllowed ? '1' : '',
			OPENCODE_LENS_ALLOW_LOCAL_MCP: hasLocalMcp(userConfig) ? '1' : '',
			OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeUserConfig(engineConfig(facade, models), userConfig)),
			// Keep the engine's config and data inside the Lens profile: a personal ~/.config/opencode
			// config must not loosen Lens's permissions, and Lens must not touch personal sessions.
			XDG_CONFIG_HOME: join(this.runtimeRoot, 'config'),
			XDG_DATA_HOME: join(this.runtimeRoot, 'data'),
			XDG_STATE_HOME: join(this.runtimeRoot, 'state'),
			XDG_CACHE_HOME: join(this.runtimeRoot, 'cache'),
		});
		if (ripgrep) {
			// Lens blocks the engine's ripgrep download; use the binary VS Code ships.
			env.OPENCODE_RIPGREP_PATH = ripgrep;
		}

		const child = spawn(bunPath(this.environmentMainService.appRoot), ['run', 'src/index.ts', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
			cwd: join(opencodeRoot, 'packages', 'opencode'),
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;
		if (child.pid) {
			fs.writeFile(this.pidFile, `${child.pid}\n${port}\n`, { mode: 0o600 }).catch(() => undefined);
		}
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
					this.spawnEngine(opencodeRoot, port, password, facade, models, userConfig, ripgrep);
				}
			}, this.restarts * 1000);
		});
	}

	stop(): void {
		this.disposed = true;
		this.teardown();
	}

	/** Stops an engine left running by a Lens that crashed, but only if the recorded pid is still that engine. */
	private async stopStaleEngine(): Promise<void> {
		const [pidText, portText] = (await fs.readFile(this.pidFile, 'utf8').catch(() => '')).split('\n');
		const pid = Number(pidText);
		if (!Number.isInteger(pid) || pid <= 0) {
			return;
		}
		const command = await processCommandLine(pid);
		if (command?.includes('src/index.ts') && command.includes('serve') && command.includes(`--port ${portText}`)) {
			this.logService.info(`[LensEngine] stopping stale engine ${pid}`);
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				// Already gone.
			}
		}
		await fs.rm(this.pidFile, { force: true });
	}

	private teardown(): void {
		const child = this.child;
		this.child = undefined;
		child?.kill();
		if (child) {
			fs.rm(this.pidFile, { force: true }).catch(() => undefined);
		}
		this.facade?.dispose();
		this.info = undefined;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}

function engineConfig(facade: ILensFacadeAddress, models: ILensUpstreamModel[]) {
	const defaultModel = chooseDefaultModel(models);
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
		// Plan mode must never edit, whatever the global default above says: that rule is merged onto every
		// agent including plan, and since the merge happens after plan's own built-in deny, it would otherwise
		// win and turn "denied" into "ask" (one Allow tap would then let Plan mode write).
		agent: {
			plan: {
				permission: { edit: 'deny' },
			},
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
					// Without an explicit limit opencode asks for more output tokens than many providers allow.
					limit: { context: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS, output: Math.min(model.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, model.contextWindow ?? DEFAULT_CONTEXT_TOKENS) },
					// Lens Chat's effort picker (none/low/medium/high/xhigh/max) sends `variant: <id>` on every
					// request; without a matching variant here the engine has nothing to attach and the effort
					// choice never reaches the provider. The key must be the AI SDK's own camelCase
					// `reasoningEffort`, not the wire-level `reasoning_effort`: the openai-compatible package
					// validates providerOptions against its own schema and silently drops unrecognized keys,
					// so a snake_case key here is stripped before it ever reaches the request body.
					variants: Object.fromEntries(EFFORT_LEVELS.map(id => [id, { reasoningEffort: id }])),
				}])),
			},
		},
	};
}

function bunPath(appRoot: string): string {
	if (process.env.LENS_BUN_PATH) {
		return process.env.LENS_BUN_PATH;
	}
	const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
	// Packaged builds ship bun next to the app (scripts/package-lens.sh); GUI launches often lack ~/.bun/bin on PATH.
	const candidate = [join(appRoot, '..', 'bun', exe), join(homedir(), '.bun', 'bin', exe)].find(path => existsSync(path));
	return candidate ?? 'bun';
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
	for (const key of ['mcp', 'skills', 'command', 'instructions'] as const) {
		if (user[key] !== undefined) {
			merged[key] = user[key];
		}
	}
	if (user.agent !== undefined) {
		// Merge per agent name instead of replacing the whole map: a user config that only customizes
		// their own agents must not silently drop managed entries such as plan mode's edit: deny override.
		const managedAgents = (managed.agent as Record<string, unknown> | undefined) ?? {};
		const userAgents = user.agent as Record<string, unknown>;
		merged.agent = {
			...managedAgents,
			...Object.fromEntries(Object.entries(userAgents).map(([name, agent]) => [
				name,
				{ ...(managedAgents[name] as Record<string, unknown> | undefined), ...(agent as Record<string, unknown>) },
			])),
		};
	}
	if (user.pluginsAllowed && user.plugin !== undefined) {
		merged.plugin = user.plugin;
	}
	return merged;
}

function hasLocalMcp(user: ILensUserOpencodeConfig): boolean {
	return Object.values(user.mcp ?? {}).some(server => !!server && typeof server === 'object' && (server as { type?: unknown }).type === 'local');
}

/** LENS_DEFAULT_MODEL when set, otherwise the newest model: by release date, then the provider's own family, then the version in its name. */
function chooseDefaultModel(models: ILensUpstreamModel[]): ILensUpstreamModel {
	const preferred = models.find(model => model.id === process.env.LENS_DEFAULT_MODEL);
	if (preferred) {
		return preferred;
	}
	return [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || flagship(b.id) - flagship(a.id) || compareVersions(versionOf(b.id), versionOf(a.id)))[0];
}

/** Without release dates, a provider's own family (gemini-* on Gemini) beats other families it also serves (e.g. Gemma). */
function flagship(id: string): number {
	const slash = id.indexOf('/');
	return slash > 0 && id.slice(slash + 1).startsWith(`${id.slice(0, slash)}-`) ? 1 : 0;
}

function versionOf(id: string): number[] {
	// First version-like number in the model's own name, e.g. 3.1 in "gemini/gemini-3.1-flash-lite".
	// Sizes (120b) and dates (12-2025, 0514) are not versions.
	const match = /(?:^|[-_/])[a-z]*?(\d{1,2}(?:\.\d+)*)(?![\d.])(?!-\d{4}\b)(?![bm]\b)/i.exec(id.slice(id.indexOf('/') + 1));
	return match ? match[1].split('.').map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) {
			return difference;
		}
	}
	return 0;
}

/** Command line of a running process, or undefined if it is gone or cannot be inspected. */
async function processCommandLine(pid: number): Promise<string | undefined> {
	if (process.platform === 'linux') {
		return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then(text => text.split('\0').join(' '), () => undefined);
	}
	if (process.platform === 'darwin') {
		return new Promise(resolve => execFile('ps', ['-o', 'command=', '-p', String(pid)], (error, stdout) => resolve(error ? undefined : stdout.trim())));
	}
	return undefined;
}
