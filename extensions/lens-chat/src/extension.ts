import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface LensMessage {
	readonly role?: string;
	readonly parts?: readonly { readonly type?: string; readonly text?: string }[];
}

interface LensSession {
	readonly id: string;
}

class LensChatViewProvider implements vscode.WebviewViewProvider {
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
		if (message.type !== 'send' || !message.text?.trim()) return;
		try {
			const baseUrl = await this.engineUrl();
			const token = vscode.workspace.getConfiguration().get<string>('lens.engine.token');
			if (!baseUrl) throw new Error('Lens engine is not configured. Set lens.engine.url or start the Lens engine.');
			const headers: Record<string, string> = { 'content-type': 'application/json' };
			if (token) headers.authorization = `Bearer ${token}`;
			if (!this.session) {
				const response = await fetch(`${baseUrl}/session`, {
					method: 'POST',
					headers,
					body: JSON.stringify({ title: 'Lens Chat' })
				});
				if (!response.ok) throw new Error(`Session creation failed: HTTP ${response.status}`);
				this.session = await response.json() as LensSession;
			}
			const promptResponse = await fetch(`${baseUrl}/session/${encodeURIComponent(this.session.id)}/message`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ parts: [{ type: 'text', text: message.text }] })
			});
			if (!promptResponse.ok) throw new Error(`Prompt failed: HTTP ${promptResponse.status}`);
			await this.refreshMessages(baseUrl, headers);
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async engineUrl(): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration().get<string>('lens.engine.url')?.replace(/\/+$/, '');
		if (configured) return configured;
		try {
			const discovery = JSON.parse(await fs.readFile(join(tmpdir(), `lens-engine-${process.ppid}.json`), 'utf8')) as { opencodeUrl?: string };
			return discovery.opencodeUrl?.replace(/\/+$/, '');
		} catch {
			return undefined;
		}
	}

	private async refreshMessages(baseUrl: string, headers: Record<string, string>): Promise<void> {
		if (!this.session) return;
		const response = await fetch(`${baseUrl}/session/${encodeURIComponent(this.session.id)}/message`, { headers });
		if (!response.ok) throw new Error(`Message history failed: HTTP ${response.status}`);
		this.messages = await response.json() as LensMessage[];
		this.post({ type: 'messages', messages: this.messages.map(message => ({
			role: message.role ?? 'assistant',
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
	const provider = new LensChatViewProvider();
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('lens-chat.view', provider));
	context.subscriptions.push(vscode.commands.registerCommand('lens-chat.open', () => vscode.commands.executeCommand('workbench.view.extension.lens')));
}
