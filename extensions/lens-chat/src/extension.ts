/*---------------------------------------------------------------------------------------------
 *  Lens. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { join } from 'path';

interface LensMessage {
	readonly info?: { readonly role?: string };
	readonly parts?: readonly { readonly type?: string; readonly text?: string }[];
}

interface LensEngine {
	readonly opencodeUrl: string;
	readonly username: string;
	readonly password: string;
}

interface LensSession {
	readonly id: string;
}

class LensChatViewProvider implements vscode.WebviewViewProvider {
	constructor(private readonly discoveryFile: string) { }

	private view: vscode.WebviewView | undefined;
	private session: LensSession | undefined;
	private messages: LensMessage[] = [];

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage(message => void this.handleMessage(message));
	}

	private async handleMessage(message: { readonly type?: string; readonly text?: string }): Promise<void> {
		if (message.type !== 'send' || !message.text?.trim()) {
			return;
		}
		try {
			const engine = await this.engine();
			if (!engine) {
				throw new Error('Lens engine is not running. Set LITELLM_BASE_URL (and LITELLM_API_KEY) before starting Lens.');
			}
			const baseUrl = engine.opencodeUrl;
			const headers: Record<string, string> = {
				'content-type': 'application/json',
				authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString('base64')}`
			};
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (folder) {
				headers['x-opencode-directory'] = folder;
			}
			if (!this.session) {
				const response = await fetch(`${baseUrl}/session`, {
					method: 'POST',
					headers,
					body: JSON.stringify({ title: 'Lens Chat' })
				});
				if (!response.ok) {
					throw new Error(`Session creation failed: HTTP ${response.status}`);
				}
				this.session = await response.json() as LensSession;
			}
			const promptResponse = await fetch(`${baseUrl}/session/${encodeURIComponent(this.session.id)}/message`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ parts: [{ type: 'text', text: message.text }] })
			});
			if (!promptResponse.ok) {
				throw new Error(`Prompt failed: HTTP ${promptResponse.status}`);
			}
			await this.refreshMessages(baseUrl, headers);
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async engine(): Promise<LensEngine | undefined> {
		try {
			// Only trust a discovery file that we own and nobody else can read or write.
			const stat = await fs.stat(this.discoveryFile);
			if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
				return undefined;
			}
			if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
				return undefined;
			}
			const discovery = JSON.parse(await fs.readFile(this.discoveryFile, 'utf8')) as Partial<LensEngine>;
			if (!discovery.opencodeUrl || !discovery.username || !discovery.password) {
				return undefined;
			}
			if (new URL(discovery.opencodeUrl).hostname !== '127.0.0.1') {
				return undefined;
			}
			return { opencodeUrl: discovery.opencodeUrl.replace(/\/+$/, ''), username: discovery.username, password: discovery.password };
		} catch {
			return undefined;
		}
	}

	private async refreshMessages(baseUrl: string, headers: Record<string, string>): Promise<void> {
		if (!this.session) {
			return;
		}
		const response = await fetch(`${baseUrl}/session/${encodeURIComponent(this.session.id)}/message`, { headers });
		if (!response.ok) {
			throw new Error(`Message history failed: HTTP ${response.status}`);
		}
		this.messages = await response.json() as LensMessage[];
		this.post({ type: 'messages', messages: this.messages.map(message => ({
			role: message.info?.role ?? 'assistant',
			text: (message.parts ?? []).map(part => part.text ?? '').join('')
		})) });
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	private html(webview: vscode.Webview): string {
		const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
		return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
		body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}#messages{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}.message{white-space:pre-wrap}.user{color:var(--vscode-textLink-foreground)}.error{color:var(--vscode-errorForeground)}textarea{box-sizing:border-box;width:100%;min-height:70px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}button{margin-top:8px;width:100%;padding:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button:hover{background:var(--vscode-button-hoverBackground)}</style></head><body><div id="messages"><div>Lens Chat is ready.</div></div><textarea id="prompt" placeholder="Ask Lens to help with your workspace..."></textarea><button id="send">Send</button><script nonce="${nonce}">
		const api=acquireVsCodeApi();const messages=document.getElementById('messages');const prompt=document.getElementById('prompt');document.getElementById('send').addEventListener('click',()=>{const text=prompt.value.trim();if(!text)return;messages.insertAdjacentHTML('beforeend','<div class="message user"></div>');messages.lastElementChild.textContent=text;prompt.value='';api.postMessage({type:'send',text});});window.addEventListener('message',event=>{const data=event.data;if(data.type==='messages'){for(const child of [...messages.children].slice(1))child.remove();for(const item of data.messages){const node=document.createElement('div');node.className='message';node.textContent=(item.role||'assistant')+': '+(item.text||'');messages.appendChild(node);}}if(data.type==='error'){const node=document.createElement('div');node.className='message error';node.textContent=data.message;messages.appendChild(node);}});</script></body></html>`;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	// globalStorageUri is <userData>/User/globalStorage/<extension id>; the engine writes to <userData>.
	const provider = new LensChatViewProvider(join(context.globalStorageUri.fsPath, '..', '..', '..', 'lens-engine.json'));
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('lens-chat.view', provider));
	context.subscriptions.push(vscode.commands.registerCommand('lens-chat.open', () => vscode.commands.executeCommand('workbench.view.extension.lens')));
}
