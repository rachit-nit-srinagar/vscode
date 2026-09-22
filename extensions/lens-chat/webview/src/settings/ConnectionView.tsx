import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { vscode } from '../vscode';

type ConnectionState = {
	baseUrl: string;
	hasApiKey: boolean;
	enabledModels: string[];
	running: boolean;
	error?: string;
};

type Model = { id: string; name: string };

export function ConnectionView() {
	const [state, setState] = createSignal<ConnectionState | undefined>();
	const [baseUrl, setBaseUrl] = createSignal('');
	const [apiKey, setApiKey] = createSignal('');
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal('');
	const [models, setModels] = createSignal<Model[]>([]);
	const [selected, setSelected] = createSignal<Set<string>>(new Set());
	const [modelsDirty, setModelsDirty] = createSignal(false);

	const applyState = (next: ConnectionState) => {
		setState(next);
		setBaseUrl(next.baseUrl);
		setSelected(new Set(next.enabledModels));
		setModelsDirty(false);
		if (next.running) {
			vscode.postMessage({ type: 'connection.models' });
		}
	};

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') {
				return;
			}
			if (data.type === 'error') {
				setBusy(false);
				setError(String(data.message ?? 'Unknown error'));
				return;
			}
			if (data.type !== 'result') {
				return;
			}
			if (data.requestType === 'connection.get' || data.requestType === 'connection.save' || data.requestType === 'connection.setModels') {
				setBusy(false);
				setApiKey('');
				setError('');
				applyState(data.data as ConnectionState);
			} else if (data.requestType === 'connection.models') {
				setModels(Array.isArray(data.data) ? data.data as Model[] : []);
			}
		};
		window.addEventListener('message', onMessage);
		onCleanup(() => window.removeEventListener('message', onMessage));
		vscode.postMessage({ type: 'connection.get' });
	});

	const save = (clearApiKey = false) => {
		setBusy(true);
		setError('');
		vscode.postMessage({ type: 'connection.save', baseUrl: baseUrl(), apiKey: apiKey() || undefined, clearApiKey });
	};

	const toggleModel = (id: string) => {
		const next = new Set(selected());
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		setSelected(next);
		setModelsDirty(true);
	};

	const applyModels = () => {
		setBusy(true);
		setError('');
		// Everything checked means "all models", which also picks up models added to LiteLLM later.
		const ids = [...selected()];
		vscode.postMessage({ type: 'connection.setModels', ids: ids.length === models().length ? [] : ids });
	};

	const urlChanged = () => (state()?.baseUrl ?? '') !== baseUrl().trim().replace(/\/+$/, '');

	return (
		<div class="lens-root lens-connection">
			<section class="lens-conn-section">
				<h3 class="lens-conn-title">Model connection</h3>
				<p class="lens-conn-hint">Lens talks to your models through a LiteLLM server.</p>

				<label class="lens-conn-label" for="lens-conn-url">LiteLLM URL</label>
				<input
					id="lens-conn-url"
					class="lens-conn-input"
					placeholder="http://localhost:4000"
					value={baseUrl()}
					onInput={event => setBaseUrl(event.currentTarget.value)}
					disabled={busy()}
				/>

				<label class="lens-conn-label" for="lens-conn-key">API key</label>
				<input
					id="lens-conn-key"
					class="lens-conn-input"
					type="password"
					autocomplete="off"
					placeholder={state()?.hasApiKey && !urlChanged() ? 'Saved (leave empty to keep)' : 'Optional'}
					value={apiKey()}
					onInput={event => setApiKey(event.currentTarget.value)}
					disabled={busy()}
				/>
				<Show when={state()?.hasApiKey && urlChanged() && !apiKey()}>
					<p class="lens-conn-hint">Changing the URL removes the saved key. Enter it again if this server needs one.</p>
				</Show>

				<div class="lens-conn-actions">
					<button class="lens-conn-primary" disabled={busy() || !baseUrl().trim()} onClick={() => save()}>
						{busy() ? 'Connecting…' : 'Save & Connect'}
					</button>
					<Show when={state()?.hasApiKey}>
						<button class="lens-conn-secondary" disabled={busy()} onClick={() => save(true)}>Remove key</button>
					</Show>
				</div>

				<div class="lens-conn-status">
					<Show when={state()} fallback={<span>Loading…</span>}>
						<span class={`lens-conn-dot ${state()!.running ? 'ok' : 'off'}`} />
						<span>{state()!.running ? 'Connected' : state()!.baseUrl ? 'Not connected' : 'Not set up'}</span>
					</Show>
				</div>
				<Show when={error() || (!state()?.running && state()?.error)}>
					<p class="lens-conn-error">{error() || state()?.error}</p>
				</Show>
			</section>

			<Show when={state()?.running && models().length}>
				<section class="lens-conn-section">
					<h3 class="lens-conn-title">Models</h3>
					<p class="lens-conn-hint">Choose which models appear in Lens Chat. None checked means all.</p>
					<ul class="lens-conn-models">
						<For each={models()}>
							{model => (
								<li>
									<label class="lens-conn-model">
										<input
											type="checkbox"
											checked={selected().size === 0 || selected().has(model.id)}
											onChange={() => {
												if (selected().size === 0) {
													setSelected(new Set(models().map(item => item.id)));
												}
												toggleModel(model.id);
											}}
											disabled={busy()}
										/>
										<span>{model.name}</span>
									</label>
								</li>
							)}
						</For>
					</ul>
					<button class="lens-conn-primary" disabled={busy() || !modelsDirty()} onClick={applyModels}>Apply</button>
				</section>
			</Show>
		</div>
	);
}
