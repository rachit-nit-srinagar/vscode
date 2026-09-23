import type { ExtensionContext, TextDocumentContentProvider, TextEditorDecorationType, Webview, WebviewView, WebviewViewProvider } from 'vscode';
import { commands, EventEmitter, extensions, OverviewRulerLane, Range, TextEditorRevealType, ThemeColor, Uri, window, workspace } from 'vscode';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { basename, isAbsolute, join } from 'path';
import { OpencodeHostClient } from './opencodeClient';
import type { HostToWebview, ILensUserConfig, McpConfig, PromptPart, WebviewToHost } from './protocol';

const LENS_DIFF_SCHEME = 'lens-diff';

const FIRST_LAUNCH_KEY = 'lens.chat.openedOnce';

export function activate(context: ExtensionContext): void {
	const diffs = new LensDiffContentProvider();
	const host = new LensChatHost(context, diffs);
	context.subscriptions.push(
		workspace.registerTextDocumentContentProvider(LENS_DIFF_SCHEME, diffs),
		host.insertDecoration,
		window.registerWebviewViewProvider('lens.chat', new LensWebviewView(host, 'chat'), { webviewOptions: { retainContextWhenHidden: true } }),
		window.registerWebviewViewProvider('lens.providers', new LensWebviewView(host, 'providers'), { webviewOptions: { retainContextWhenHidden: true } }),
		window.registerWebviewViewProvider('lens.extensions', new LensWebviewView(host, 'extensions'), { webviewOptions: { retainContextWhenHidden: true } }),
		commands.registerCommand('lens.openChat', async () => {
			await commands.executeCommand('lens.chat.focus');
		}),
		commands.registerCommand('lens.chat.new', async () => {
			await commands.executeCommand('lens.chat.focus');
			host.postChat({ type: 'command', action: 'new' });
		}),
		commands.registerCommand('lens.chat.history', async () => {
			await commands.executeCommand('lens.chat.focus');
			host.postChat({ type: 'command', action: 'history' });
		}),
	);
	// The secondary sidebar is visible by default (configurationDefaults), but a fresh profile has no view
	// selected inside it, so Lens Chat stays empty until the user clicks its tab. Select it once, the first
	// time this profile ever activates, without fighting the user's own choice on every later launch.
	if (!context.globalState.get(FIRST_LAUNCH_KEY)) {
		context.globalState.update(FIRST_LAUNCH_KEY, true);
		commands.executeCommand('lens.chat.focus');
	}
}

class LensWebviewView implements WebviewViewProvider {
	private readonly resolvedWebviews = new WeakSet<Webview>();

	constructor(
		private readonly host: LensChatHost,
		private readonly view: 'chat' | 'providers' | 'extensions',
	) { }

	resolveWebviewView(webviewView: WebviewView): void {
		const webview = webviewView.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [Uri.joinPath(this.host.context.extensionUri, 'media')],
		};
		webview.html = this.host.renderHtml(webview, this.view);
		if (this.view === 'chat') {
			webviewView.title = '';
			this.host.attachChat(webview);
		}
		if (this.resolvedWebviews.has(webview)) {
			void this.host.boot(webview);
			return;
		}
		this.resolvedWebviews.add(webview);
		webview.onDidReceiveMessage(async (message: WebviewToHost) => {
			try {
				await this.host.handleMessage(webview, message);
			} catch (error) {
				this.host.post(webview, { type: 'error', message: error instanceof Error ? error.message : String(error) });
			}
		});
	}
}

class LensChatHost {
	client: OpencodeHostClient | undefined;
	private events: AbortController | undefined;
	private readonly webviews = new Set<Webview>();
	private chatWebview: Webview | undefined;
	private pendingChatCommand: Extract<HostToWebview, { type: 'command' }> | undefined;
	readonly insertDecoration: TextEditorDecorationType;

	constructor(
		readonly context: ExtensionContext,
		private readonly diffs: LensDiffContentProvider,
	) {
		this.insertDecoration = window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new ThemeColor('diffEditor.insertedLineBackground'),
			overviewRulerColor: new ThemeColor('editorGutter.addedBackground'),
			overviewRulerLane: OverviewRulerLane.Left,
		});
	}

	post(webview: Webview, message: HostToWebview): void {
		void webview.postMessage(message);
	}

	attachChat(webview: Webview): void {
		this.chatWebview = webview;
		if (this.pendingChatCommand) {
			this.post(webview, this.pendingChatCommand);
			this.pendingChatCommand = undefined;
		}
	}

	postChat(message: Extract<HostToWebview, { type: 'command' }>): void {
		if (this.chatWebview) {
			this.post(this.chatWebview, message);
			return;
		}
		this.pendingChatCommand = message;
	}

	private broadcast(message: HostToWebview): void {
		for (const webview of this.webviews) {
			this.post(webview, message);
		}
	}

	async handleMessage(webview: Webview, message: WebviewToHost): Promise<void> {
		this.webviews.add(webview);
		if (message.type === 'ready') {
			await this.boot(webview);
			return;
		}
		if (message.type === 'providers.open') {
			await commands.executeCommand('lens.providers.focus');
			return;
		}
		if (message.type === 'providers.get' || message.type === 'providers.fetchModels') {
			const data = message.type === 'providers.get'
				? await commands.executeCommand('_lens.providers.get')
				: await commands.executeCommand('_lens.providers.fetchModels', message.provider);
			this.post(webview, { type: 'result', requestType: message.type, data });
			return;
		}
		if (message.type === 'providers.save' || message.type === 'providers.remove') {
			const data = message.type === 'providers.save'
				? await commands.executeCommand('_lens.providers.save', { config: message.config, apiKey: message.apiKey, clearApiKey: message.clearApiKey })
				: await commands.executeCommand('_lens.providers.remove', message.provider);
			this.post(webview, { type: 'result', requestType: message.type, data });
			// The engine restarted; let every open Lens view reconnect.
			for (const other of this.webviews) {
				void this.boot(other);
			}
			return;
		}
		if (message.type === 'file.open') {
			await this.openFileChange(message.path, message.addedLines ?? [], !!message.isNew);
			return;
		}
		const client = this.client;
		if (!client) {
			throw new Error('Lens engine is not running. Add an AI provider under Lens → AI Providers.');
		}

		switch (message.type) {
			case 'session.create': {
				const data = await client.request('POST', '/session', sessionCreateBody(message));
				this.post(webview, { type: 'result', requestType: message.type, data: unwrapSession(data) });
				return;
			}
			case 'session.list': {
				const query = message.search ? `?search=${encodeURIComponent(message.search)}` : '';
				const data = await client.request('GET', `/session${query}`);
				this.post(webview, { type: 'result', requestType: message.type, data: unwrapList(data) });
				return;
			}
			case 'session.select': {
				const data = await client.request('GET', `/session/${encodeURIComponent(message.sessionID)}`);
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'session.close': {
				try {
					await client.request('POST', `/session/${encodeURIComponent(message.sessionID)}/abort`);
				} catch {
					// Already idle or gone; still close the tab.
				}
				this.post(webview, { type: 'result', requestType: message.type, data: { sessionID: message.sessionID } });
				return;
			}
			case 'session.delete': {
				await client.request('DELETE', `/session/${encodeURIComponent(message.sessionID)}`);
				this.post(webview, { type: 'result', requestType: message.type, data: { sessionID: message.sessionID } });
				return;
			}
			case 'session.update': {
				const body: Record<string, unknown> = {};
				if (message.title !== undefined) {
					body.title = message.title;
				}
				if (message.archived) {
					body.time = { archived: Date.now() };
				}
				const data = await client.request('PATCH', `/session/${encodeURIComponent(message.sessionID)}`, body);
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'session.prompt': {
				const parts = message.parts?.length ? message.parts : [{ type: 'text', text: message.text } satisfies PromptPart];
				const data = await client.request('POST', `/session/${encodeURIComponent(message.sessionID)}/message`, sessionPromptBody(message, parts));
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'session.abort': {
				const data = await client.request('POST', `/session/${encodeURIComponent(message.sessionID)}/abort`);
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'session.messages': {
				const data = await client.request('GET', `/session/${encodeURIComponent(message.sessionID)}/message`);
				this.post(webview, { type: 'result', requestType: message.type, data: unwrapList(data) });
				return;
			}
			case 'session.command': {
				const data = await client.request('POST', `/session/${encodeURIComponent(message.sessionID)}/command`, {
					command: message.command,
					arguments: message.arguments ?? '',
					agent: message.agent,
					variant: message.variant,
				});
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'find.files': {
				const data = await client.request('GET', `/find/file?query=${encodeURIComponent(message.query)}`);
				this.post(webview, { type: 'result', requestType: message.type, data: unwrapList(data) });
				return;
			}
			case 'find.symbols': {
				let data: unknown;
				try {
					data = unwrapList(await client.request('GET', `/find/symbol?query=${encodeURIComponent(message.query)}`));
				} catch {
					data = [];
				}
				// The hardened engine runs no language servers, so its own symbol search is
				// always empty. Fall back to the editor's own workspace symbol providers,
				// which run in-process and need no downloaded LSP.
				if (!Array.isArray(data) || data.length === 0) {
					data = await findWorkspaceSymbols(message.query);
				}
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'session.diff': {
				try {
					const data = await sessionDiff(client, message.sessionID);
					this.post(webview, { type: 'result', requestType: message.type, data });
				} catch {
					this.post(webview, { type: 'result', requestType: message.type, data: [] });
				}
				return;
			}
			case 'command.list': {
				const data = await client.request('GET', '/command');
				this.post(webview, { type: 'result', requestType: message.type, data: hideUpstreamSkills(data) });
				return;
			}
			case 'skill.list': {
				const data = await client.request('GET', '/skill');
				this.post(webview, { type: 'result', requestType: message.type, data: hideUpstreamSkills(data) });
				return;
			}
			case 'agent.list': {
				const data = await client.request('GET', '/agent');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'provider.list': {
				const data = await client.request('GET', '/provider');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'permission.list': {
				const data = await client.request('GET', '/permission');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'permission.reply': {
				const data = await client.request('POST', `/permission/${encodeURIComponent(message.requestID)}/reply`, {
					reply: message.reply,
				});
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'question.list': {
				const data = await client.request('GET', '/question');
				this.post(webview, { type: 'result', requestType: message.type, data: unwrapList(data) });
				return;
			}
			case 'question.reply': {
				const data = await client.request('POST', `/question/${encodeURIComponent(message.requestID)}/reply`, {
					answers: message.answers,
				});
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'question.reject': {
				const data = await client.request('POST', `/question/${encodeURIComponent(message.requestID)}/reject`);
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'mcp.status': {
				const data = await client.request('GET', '/mcp');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'mcp.add': {
				await this.addMcpWithConsent(message.name, message.config);
				await client.request('POST', '/mcp', { name: message.name, config: message.config });
				const data = await client.request('GET', '/mcp');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'mcp.connect': {
				await client.request('POST', `/mcp/${encodeURIComponent(message.name)}/connect`);
				const data = await client.request('GET', '/mcp');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'mcp.disconnect': {
				await client.request('POST', `/mcp/${encodeURIComponent(message.name)}/disconnect`);
				const data = await client.request('GET', '/mcp');
				this.post(webview, { type: 'result', requestType: message.type, data });
				return;
			}
			case 'config.get': {
				const data = await commands.executeCommand<ILensUserConfig>('_lens.engine.getUserConfig');
				this.post(webview, { type: 'result', requestType: message.type, data: data ?? {} });
				return;
			}
			case 'config.patch': {
				if (message.partial.pluginsAllowed || message.partial.hooksAllowed) {
					const kind = message.partial.pluginsAllowed ? 'plugins' : 'hooks';
					const approved = await this.confirm(
						`Enable user ${kind}? They run in-process and can execute shell commands. Only approve extensions you trust.`,
						`Enable ${kind}`,
					);
					if (!approved) {
						throw new Error(`${kind} were not enabled`);
					}
				}
				const data = await commands.executeCommand<ILensUserConfig>('_lens.engine.patchUserConfig', message.partial);
				this.post(webview, { type: 'result', requestType: message.type, data: data ?? {} });
				return;
			}
		}
	}

	private async addMcpWithConsent(name: string, config: McpConfig): Promise<void> {
		if (config.type === 'remote') {
			const hostname = hostnameOf(config.url);
			const approved = await this.confirm(
				`Add remote MCP "${name}" at ${config.url}?\n\nThis allows Lens to connect to ${hostname} (egress consent).`,
				'Allow host',
			);
			if (!approved) {
				throw new Error('MCP add cancelled');
			}
			if (hostname) {
				await commands.executeCommand('_lens.engine.allowEgress', hostname);
			}
		} else {
			const commandLine = config.command.join(' ');
			const approved = await this.confirm(
				`Add local MCP "${name}"?\n\nLens will spawn:\n${commandLine}\n\nOnly continue if you trust this command.`,
				'Allow spawn',
			);
			if (!approved) {
				throw new Error('MCP add cancelled');
			}
		}
		await commands.executeCommand('_lens.engine.patchUserConfig', { mcp: { [name]: config } });
	}

	private async confirm(message: string, action: string): Promise<boolean> {
		const choice = await window.showWarningMessage(message, { modal: true }, action);
		return choice === action;
	}

	private async openFileChange(filePath: string, addedLines: number[], isNew: boolean): Promise<void> {
		const uri = this.resolveFileUri(filePath);
		if (isNew) {
			try {
				await workspace.fs.stat(uri);
				const left = Uri.from({ scheme: LENS_DIFF_SCHEME, path: `/empty/${basename(uri.fsPath)}` });
				this.diffs.set(left, '');
				await commands.executeCommand('vscode.diff', left, uri, `${basename(uri.fsPath)} (new file)`);
				return;
			} catch {
				// File is not on disk yet; open it if possible and highlight additions.
			}
		}

		const document = await workspace.openTextDocument(uri);
		const editor = await window.showTextDocument(document, { preview: true, preserveFocus: false });
		const ranges = addedLines
			.map(line => Math.max(0, line - 1))
			.filter(line => line < document.lineCount)
			.slice(0, 400)
			.map(line => {
				const text = document.lineAt(line);
				return new Range(line, 0, line, text.text.length);
			});
		editor.setDecorations(this.insertDecoration, ranges);
		const first = ranges[0];
		if (first) {
			editor.revealRange(first, TextEditorRevealType.InCenter);
		}
	}

	private resolveFileUri(filePath: string): Uri {
		if (!filePath) {
			throw new Error('No file path to open');
		}
		if (isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)) {
			return Uri.file(filePath);
		}
		const folder = workspace.workspaceFolders?.[0]?.uri.fsPath;
		return Uri.file(folder ? join(folder, filePath) : filePath);
	}

	async boot(webview: Webview): Promise<void> {
		const runtime = await commands.executeCommand<import('./protocol').ILensEngineRuntime | undefined>('_lens.engine.getRuntime');
		if (!runtime) {
			this.post(webview, { type: 'boot' });
			return;
		}
		const workspaceFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.client = new OpencodeHostClient(runtime, workspaceFolder);
		this.events?.abort();
		this.events = new AbortController();
		this.client.subscribeEvents(payload => {
			this.broadcast({ type: 'event', payload });
		}, this.events.signal);
		const userConfig = await commands.executeCommand<ILensUserConfig>('_lens.engine.getUserConfig').then(value => value ?? {}, () => ({}));
		this.post(webview, { type: 'boot', runtime, workspace: workspaceFolder, userConfig });
	}

	private bundle: string | undefined;

	renderHtml(webview: Webview, view: 'chat' | 'providers' | 'extensions'): string {
		// Inlined rather than loaded with src=: the webview resource loader can serve a file twice
		// when several webviews request it at once, which breaks the script and leaves the view blank.
		this.bundle ??= readFileSync(join(this.context.extensionPath, 'media', 'webview', 'index.js'), 'utf8')
			.replace(/<(\/script|!--)/gi, '\\x3C$1');
		const nonce = randomBytes(16).toString('base64');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;height:100%;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);">
	<div id="root" data-view="${view}" data-media="${webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, 'media'))}" style="height:100%;"></div>
	<script nonce="${nonce}">${this.bundle}</script>
</body>
</html>`;
	}
}

function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

function isUsableProviderID(id: string | undefined): id is string {
	return !!id && !/^\d+$/.test(id);
}

function sessionCreateBody(message: { agent?: string; model?: { id?: string; providerID?: string; variant?: string } }): Record<string, unknown> | undefined {
	const body: Record<string, unknown> = {};
	if (message.agent?.trim()) {
		body.agent = message.agent.trim();
	}
	const providerID = message.model?.providerID?.trim();
	const id = message.model?.id?.trim();
	const variant = message.model?.variant?.trim();
	if (isUsableProviderID(providerID) && id) {
		body.model = { id, providerID, ...(variant ? { variant } : {}) };
	}
	return Object.keys(body).length ? body : undefined;
}

function sessionPromptBody(message: { agent?: string; variant?: string; model?: { providerID?: string; modelID?: string } }, parts: PromptPart[]): Record<string, unknown> {
	const body: Record<string, unknown> = { parts };
	if (message.agent?.trim()) {
		body.agent = message.agent.trim();
	}
	if (message.variant?.trim()) {
		body.variant = message.variant.trim();
	}
	const providerID = message.model?.providerID?.trim();
	const modelID = message.model?.modelID?.trim();
	if (isUsableProviderID(providerID) && modelID) {
		body.model = { providerID, modelID };
	}
	return body;
}

// The engine ships a built-in "customize-opencode" skill that names the upstream project it is
// forked from, exposed both as a skill and as a generated slash command. Lens never surfaces
// that name to the user, so it is filtered out of both lists.
const UPSTREAM_NAMES = new Set(['customize-opencode']);

function hideUpstreamSkills(data: unknown): unknown {
	const list = unwrapList(data);
	if (!Array.isArray(list)) {
		return data;
	}
	return list.filter(item => {
		const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
		return typeof name !== 'string' || !UPSTREAM_NAMES.has(name);
	});
}

interface SessionFileDiff {
	readonly file?: string;
	readonly path?: string;
	readonly additions?: number;
	readonly deletions?: number;
	readonly status?: string;
	readonly [key: string]: unknown;
}

/**
 * The engine only stores a diff per turn, keyed by the user message that started it
 * (GET /session/:id/diff?messageID=<user message id>; no messageID always returns []). Lens Chat
 * wants one "files changed" summary for the whole session, so fetch every turn's diff and merge
 * them by file path, summing additions and deletions and keeping the most recent status.
 */
async function sessionDiff(client: OpencodeHostClient, sessionID: string): Promise<SessionFileDiff[]> {
	const messages = unwrapList(await client.request('GET', `/session/${encodeURIComponent(sessionID)}/message`));
	const userMessageIDs = (Array.isArray(messages) ? messages : [])
		.map(item => (item as { info?: { role?: string; id?: string } })?.info)
		.filter(info => info?.role === 'user' && info.id)
		.map(info => info!.id!);

	const perTurn = await Promise.all(userMessageIDs.map(messageID =>
		client.request<unknown>('GET', `/session/${encodeURIComponent(sessionID)}/diff?messageID=${encodeURIComponent(messageID)}`)
			.then(data => unwrapList(data))
			.catch(() => []),
	));

	const merged = new Map<string, SessionFileDiff>();
	for (const diffs of perTurn) {
		if (!Array.isArray(diffs)) {
			continue;
		}
		for (const entry of diffs as SessionFileDiff[]) {
			const path = entry.file ?? entry.path;
			if (!path) {
				continue;
			}
			const existing = merged.get(path);
			merged.set(path, {
				...entry,
				// The engine's diff entries key the filename as `file`; the webview's review panel reads `path`.
				path,
				additions: (existing?.additions ?? 0) + (entry.additions ?? 0),
				deletions: (existing?.deletions ?? 0) + (entry.deletions ?? 0),
			});
		}
	}
	return [...merged.values()];
}

// Built-in language extensions register their workspace symbol provider only once
// activated, and they activate on opening a matching file, which never happens for
// a file the user only @-mentions in chat. Warm them once so symbol search works
// without the user having opened anything first. This activates bundled extensions
// already shipped with Lens; it does not download or install anything.
const LANGUAGE_EXTENSIONS_FOR_SYMBOLS = [
	'vscode.typescript-language-features',
	'vscode.json-language-features',
	'vscode.css-language-features',
	'vscode.html-language-features',
];
let languageExtensionsWarmed: Promise<void> | undefined;

function warmLanguageExtensions(): Promise<void> {
	if (!languageExtensionsWarmed) {
		languageExtensionsWarmed = (async () => {
			await Promise.all(LANGUAGE_EXTENSIONS_FOR_SYMBOLS.map(id => extensions.getExtension(id)?.activate().then(() => undefined, () => undefined)));
			// A language server only indexes files it has been told about. Opening every
			// source file as a background document (not shown in any editor) is what makes
			// the language extensions' own workspace symbol providers see the project,
			// without needing the user to have opened anything first.
			const files = await workspace.findFiles('**/*.{ts,tsx,js,jsx,json,css,scss,html}', '**/{node_modules,.git,dist,out,build}/**', 200);
			await Promise.all(files.map(uri => workspace.openTextDocument(uri).then(() => undefined, () => undefined)));
		})();
	}
	return languageExtensionsWarmed;
}

async function findWorkspaceSymbols(query: string): Promise<Array<{ name: string; location: { uri: string } }>> {
	try {
		await warmLanguageExtensions();
		// The very first query can race the just-opened documents' initial parse, so retry
		// briefly instead of surfacing an empty result on that first keystroke.
		let results: Array<{ name: string; location: { uri: Uri } }> | undefined;
		for (let attempt = 0; attempt < 3 && !results?.length; attempt++) {
			if (attempt > 0) {
				await new Promise(resolve => setTimeout(resolve, 300));
			}
			results = await commands.executeCommand<Array<{ name: string; location: { uri: Uri } }>>('vscode.executeWorkspaceSymbolProvider', query);
		}
		return (results ?? []).slice(0, 8).map(symbol => ({ name: symbol.name, location: { uri: symbol.location.uri.toString() } }));
	} catch {
		return [];
	}
}

function unwrapList(data: unknown): unknown {
	if (Array.isArray(data)) {
		return data;
	}
	if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
		return (data as { data: unknown[] }).data;
	}
	return data;
}

function unwrapSession(data: unknown): unknown {
	if (data && typeof data === 'object' && (data as { id?: unknown }).id) {
		return data;
	}
	if (data && typeof data === 'object' && (data as { data?: { id?: unknown } }).data?.id) {
		return (data as { data: unknown }).data;
	}
	return data;
}

class LensDiffContentProvider implements TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly emitter = new EventEmitter<Uri>();
	readonly onDidChange = this.emitter.event;

	provideTextDocumentContent(uri: Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	set(uri: Uri, text: string): void {
		this.contents.set(uri.toString(), text);
		this.emitter.fire(uri);
	}
}
