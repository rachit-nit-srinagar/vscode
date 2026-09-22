import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { vscode } from '../vscode';

type Tab = 'all' | 'plugins' | 'mcps' | 'skills' | 'subagents' | 'rules' | 'commands' | 'hooks';
type McpStatus = { status?: string; error?: string };
type Skill = { name?: string; description?: string; location?: string };
type Command = { name?: string; description?: string; title?: string };
type Agent = { name?: string; mode?: string; description?: string };
const TABS: Tab[] = ['all', 'plugins', 'mcps', 'skills', 'subagents', 'rules', 'commands', 'hooks'];

export function ExtensionsView() {
	const [booted, setBooted] = createSignal(false);
	const [engine, setEngine] = createSignal(false);
	const [error, setError] = createSignal('');
	const [tab, setTab] = createSignal<Tab>('all');
	const [query, setQuery] = createSignal('');
	const [mcp, setMcp] = createSignal<Record<string, McpStatus>>({});
	const [skills, setSkills] = createSignal<Skill[]>([]);
	const [commands, setCommands] = createSignal<Command[]>([]);
	const [agents, setAgents] = createSignal<Agent[]>([]);
	const [userConfig, setUserConfig] = createSignal<Record<string, unknown>>({});
	const [showAdd, setShowAdd] = createSignal(false);
	const [mcpKind, setMcpKind] = createSignal<'remote' | 'local'>('remote');
	const [mcpName, setMcpName] = createSignal('');
	const [mcpUrl, setMcpUrl] = createSignal('');
	const [mcpCommand, setMcpCommand] = createSignal('');
	const [rules, setRules] = createSignal('');
	const [pluginSpec, setPluginSpec] = createSignal('');

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') return;
			if (data.type === 'boot') {
				setBooted(true);
				setEngine(!!data.runtime);
				setUserConfig((data.userConfig as Record<string, unknown>) ?? {});
				setRules(stringify((data.userConfig as { instructions?: unknown })?.instructions));
				if (data.runtime) {
					refresh();
				}
			} else if (data.type === 'error') {
				setError(String(data.message ?? 'Unknown error'));
			} else if (data.type === 'result') {
				if (data.requestType === 'mcp.status' || data.requestType === 'mcp.add' || data.requestType === 'mcp.connect' || data.requestType === 'mcp.disconnect') {
					setMcp((data.data ?? {}) as Record<string, McpStatus>);
				} else if (data.requestType === 'skill.list') {
					setSkills(Array.isArray(data.data) ? data.data : []);
				} else if (data.requestType === 'command.list') {
					setCommands(Array.isArray(data.data) ? data.data : []);
				} else if (data.requestType === 'agent.list') {
					setAgents(Array.isArray(data.data) ? data.data : []);
				} else if (data.requestType === 'config.get' || data.requestType === 'config.patch') {
					setUserConfig((data.data ?? {}) as Record<string, unknown>);
					setRules(stringify((data.data as { instructions?: unknown })?.instructions));
				}
			}
		};
		window.addEventListener('message', onMessage);
		onCleanup(() => window.removeEventListener('message', onMessage));
	});

	function refresh() {
		vscode.postMessage({ type: 'mcp.status' });
		vscode.postMessage({ type: 'skill.list' });
		vscode.postMessage({ type: 'command.list' });
		vscode.postMessage({ type: 'agent.list' });
		vscode.postMessage({ type: 'config.get' });
	}

	function matches(text: string | undefined) {
		const q = query().trim().toLowerCase();
		return !q || (text ?? '').toLowerCase().includes(q);
	}

	const mcpEntries = createMemo(() => Object.entries(mcp()).filter(([name]) => matches(name)));
	const visibleSkills = createMemo(() => skills().filter(item => matches(item.name) || matches(item.description)));
	const visibleCommands = createMemo(() => commands().filter(item => matches(item.name) || matches(item.title) || matches(item.description)));
	const visibleAgents = createMemo(() => agents().filter(item => item.mode === 'subagent' || item.mode === 'primary').filter(item => matches(item.name)));

	function addMcp() {
		const name = mcpName().trim();
		if (!name) return;
		if (mcpKind() === 'remote') {
			vscode.postMessage({ type: 'mcp.add', name, config: { type: 'remote', url: mcpUrl().trim(), enabled: true } });
		} else {
			const command = mcpCommand().trim().split(/\s+/).filter(Boolean);
			vscode.postMessage({ type: 'mcp.add', name, config: { type: 'local', command, enabled: true } });
		}
		setShowAdd(false);
		setMcpName('');
		setMcpUrl('');
		setMcpCommand('');
	}

	function saveRules() {
		let instructions: unknown = rules();
		try {
			instructions = JSON.parse(rules());
		} catch {
			instructions = rules().split('\n').map(line => line.trim()).filter(Boolean);
		}
		vscode.postMessage({ type: 'config.patch', partial: { instructions } });
	}

	return (
		<div class="lens-root">
			<Show when={!booted()}>
				<div class="lens-loading">Loading Lens extensions…</div>
			</Show>
			<Show when={booted() && !engine()}>
				<div class="lens-empty">Lens engine is not running. Run “Lens: Configure LiteLLM Connection” from the Command Palette.</div>
			</Show>
			<Show when={booted() && engine()}>
				<div class="lens-ext-header">
					<input placeholder="Search MCP, skills, commands..." value={query()} onInput={event => setQuery(event.currentTarget.value)} />
					<button class="lens-send" onClick={() => setShowAdd(true)}>New MCP Server</button>
				</div>
				<div class="lens-ext-tabs">
					<For each={TABS}>
						{item => (
							<button class={`lens-tab ${tab() === item ? 'active' : ''}`} onClick={() => setTab(item)}>{label(item)}</button>
						)}
					</For>
				</div>
				<Show when={error()}>
					<div class="lens-error">{error()}</div>
				</Show>
				<div class="lens-timeline">
					<Show when={tab() === 'all' || tab() === 'mcps'}>
						<div class="lens-section">Connected</div>
						<For each={mcpEntries()} fallback={<div class="lens-empty">No MCP servers yet.</div>}>
							{([name, status]) => (
								<div class="lens-card">
									<span class={`lens-dot ${status.status ?? 'unknown'}`}></span>
									<div>
										<strong>{name}</strong>
										<div class="lens-muted">{status.status ?? 'unknown'}{status.error ? ` — ${status.error}` : ''}</div>
									</div>
									<button class="lens-pill" onClick={() => vscode.postMessage({
										type: status.status === 'disabled' || status.status === 'failed' ? 'mcp.connect' : 'mcp.disconnect',
										name,
									})}>{status.status === 'connected' ? 'Disable' : 'Enable'}</button>
								</div>
							)}
						</For>
					</Show>
					<Show when={tab() === 'all' || tab() === 'skills'}>
						<div class="lens-section">Skills</div>
						<For each={visibleSkills()} fallback={<div class="lens-empty">No skills discovered.</div>}>
							{skill => (
								<div class="lens-card">
									<div>
										<strong>{skill.name}</strong>
										<div class="lens-muted">{skill.description || skill.location}</div>
									</div>
								</div>
							)}
						</For>
					</Show>
					<Show when={tab() === 'all' || tab() === 'commands'}>
						<div class="lens-section">Commands</div>
						<For each={visibleCommands()} fallback={<div class="lens-empty">No commands.</div>}>
							{command => (
								<div class="lens-card">
									<div>
										<strong>{command.name}</strong>
										<div class="lens-muted">{command.description || command.title}</div>
									</div>
								</div>
							)}
						</For>
					</Show>
					<Show when={tab() === 'all' || tab() === 'subagents'}>
						<div class="lens-section">Subagents</div>
						<For each={visibleAgents()} fallback={<div class="lens-empty">No agents.</div>}>
							{agent => (
								<div class="lens-card">
									<div>
										<strong>{agent.name}</strong>
										<div class="lens-muted">{agent.mode} {agent.description ?? ''}</div>
									</div>
								</div>
							)}
						</For>
					</Show>
					<Show when={tab() === 'plugins'}>
						<div class="lens-section">Plugins (high risk)</div>
						<div class="lens-muted">Plugins execute in-process with shell access. Disabled until you explicitly approve.</div>
						<div class="lens-card">
							<div>User plugins {userConfig().pluginsAllowed ? 'approved' : 'blocked'}</div>
							<button class="lens-pill" onClick={() => vscode.postMessage({ type: 'config.patch', partial: { pluginsAllowed: true } })}>Approve plugins</button>
						</div>
						<input placeholder="plugin spec (npm or path)" value={pluginSpec()} onInput={event => setPluginSpec(event.currentTarget.value)} />
						<button class="lens-send" onClick={() => {
							if (!pluginSpec().trim()) return;
							vscode.postMessage({ type: 'config.patch', partial: { pluginsAllowed: true, plugin: [pluginSpec().trim()] } });
						}}>Add plugin</button>
					</Show>
					<Show when={tab() === 'hooks'}>
						<div class="lens-section">Hooks (high risk)</div>
						<div class="lens-muted">Hooks are arbitrary command hooks. Approve only if you trust the source.</div>
						<button class="lens-pill" onClick={() => vscode.postMessage({ type: 'config.patch', partial: { hooksAllowed: true } })}>
							{userConfig().hooksAllowed ? 'Hooks approved' : 'Approve hooks'}
						</button>
					</Show>
					<Show when={tab() === 'rules'}>
						<div class="lens-section">Rules / instructions</div>
						<textarea value={rules()} onInput={event => setRules(event.currentTarget.value)} placeholder="One instruction per line, or JSON array" />
						<button class="lens-send" onClick={saveRules}>Save rules</button>
					</Show>
				</div>
				<Show when={showAdd()}>
					<div class="lens-modal">
						<div class="lens-dialog">
							<strong>Add a custom MCP server</strong>
							<select class="lens-pill" value={mcpKind()} onChange={event => setMcpKind(event.currentTarget.value as 'remote' | 'local')}>
								<option value="remote">Remote URL</option>
								<option value="local">Local command</option>
							</select>
							<input placeholder="Name" value={mcpName()} onInput={event => setMcpName(event.currentTarget.value)} />
							<Show when={mcpKind() === 'remote'} fallback={
								<input placeholder="Command e.g. npx -y @modelcontextprotocol/server-filesystem ." value={mcpCommand()} onInput={event => setMcpCommand(event.currentTarget.value)} />
							}>
								<input placeholder="https://mcp.example.com/sse" value={mcpUrl()} onInput={event => setMcpUrl(event.currentTarget.value)} />
							</Show>
							<div class="lens-input-row">
								<button class="lens-icon" onClick={() => setShowAdd(false)}>Cancel</button>
								<button class="lens-send" onClick={addMcp}>Add with consent</button>
							</div>
						</div>
					</div>
				</Show>
			</Show>
		</div>
	);
}

function label(tab: Tab): string {
	if (tab === 'mcps') return 'MCPs';
	return tab[0]!.toUpperCase() + tab.slice(1);
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
	return JSON.stringify(value, null, 2);
}
