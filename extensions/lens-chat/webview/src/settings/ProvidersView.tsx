import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { renderMarkdown } from '../chat/markdown';
import { vscode } from '../vscode';
import { PROVIDERS, ProviderField, ProviderInfo, ProviderType } from './providerCatalog';

type ProviderSummary = {
	type: ProviderType;
	baseUrl?: string;
	resourceName?: string;
	accountId?: string;
	gatewayId?: string;
	headerName?: string;
	models: string[];
	hasApiKey: boolean;
};

type ProvidersState = { providers: ProviderSummary[]; running: boolean; error?: string };
type Model = { id: string; name: string };

const MEDIA = document.getElementById('root')?.dataset.media ?? '';

function logoUrl(info: ProviderInfo): string {
	return `${MEDIA}/providers/${info.logo}`;
}

export function ProvidersView() {
	const [state, setState] = createSignal<ProvidersState | undefined>();
	const [editing, setEditing] = createSignal<ProviderInfo | undefined>();
	const [error, setError] = createSignal('');
	const [busy, setBusy] = createSignal(false);

	const configured = (type: ProviderType) => state()?.providers.find(provider => provider.type === type);

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') {
				return;
			}
			if (data.type === 'error') {
				setBusy(false);
				setError(String(data.message ?? 'Unknown error'));
			} else if (data.type === 'result' && (data.requestType === 'providers.get' || data.requestType === 'providers.save' || data.requestType === 'providers.remove')) {
				setBusy(false);
				setState(data.data as ProvidersState);
			}
		};
		window.addEventListener('message', onMessage);
		onCleanup(() => window.removeEventListener('message', onMessage));
		vscode.postMessage({ type: 'providers.get' });
	});

	const remove = (type: ProviderType) => {
		setBusy(true);
		setError('');
		vscode.postMessage({ type: 'providers.remove', provider: type });
	};

	return (
		<div class="lens-root lens-providers">
			<Show when={editing()} fallback={
				<>
					<div class="lens-prov-status">
						<Show when={state()} fallback={<span>Loading…</span>}>
							<span class={`lens-conn-dot ${state()!.running ? 'ok' : 'off'}`} />
							<span>{state()!.running ? 'Lens is connected' : state()!.providers.length ? 'Not connected' : 'Add a provider to start chatting'}</span>
						</Show>
					</div>
					<Show when={error() || (state() && !state()!.running && state()!.providers.length && state()!.error)}>
						<p class="lens-conn-error lens-prov-pad">{error() || state()?.error}</p>
					</Show>
					<ul class="lens-prov-list">
						<For each={PROVIDERS}>
							{info => (
								<li class="lens-prov-card">
									<span class="lens-prov-logo"><img src={logoUrl(info)} alt="" /></span>
									<div class="lens-prov-text">
										<div class="lens-prov-name">{info.name}</div>
										<div class="lens-prov-sub">
											{configured(info.type) ? describe(configured(info.type)!) : 'Not set up'}
										</div>
									</div>
									<Show when={configured(info.type)} fallback={
										<button class="lens-conn-secondary" disabled={busy()} onClick={() => { setError(''); setEditing(info); }}>Enable</button>
									}>
										<div class="lens-prov-actions">
											<button class="lens-prov-icon" title="Edit" aria-label={`Edit ${info.name}`} disabled={busy()} onClick={() => { setError(''); setEditing(info); }}>✎</button>
											<button class="lens-prov-icon" title="Remove" aria-label={`Remove ${info.name}`} disabled={busy()} onClick={() => remove(info.type)}>✕</button>
										</div>
									</Show>
								</li>
							)}
						</For>
					</ul>
				</>
			}>
				<ProviderEditor
					info={editing()!}
					current={configured(editing()!.type)}
					onClose={() => setEditing(undefined)}
				/>
			</Show>
		</div>
	);
}

function describe(provider: ProviderSummary): string {
	const models = provider.models.length ? `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}` : 'all models';
	return `Enabled · ${models}`;
}

function ProviderEditor(props: { info: ProviderInfo; current: ProviderSummary | undefined; onClose: () => void }) {
	const initial = props.current;
	const [fields, setFields] = createSignal<Record<ProviderField, string>>({
		baseUrl: initial?.baseUrl ?? '',
		resourceName: initial?.resourceName ?? '',
		accountId: initial?.accountId ?? '',
		gatewayId: initial?.gatewayId ?? '',
		headerName: initial?.headerName ?? '',
	});
	const [apiKey, setApiKey] = createSignal('');
	const [manual, setManual] = createSignal((initial?.models ?? []).join('\n'));
	const [models, setModels] = createSignal<Model[]>([]);
	const [selected, setSelected] = createSignal<Set<string>>(new Set(initial?.models ?? []));
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal('');
	const [saved, setSaved] = createSignal(!!initial);
	const instructions = createMemo(() => renderMarkdown(props.info.instructions));

	const manualModels = () => manual().split('\n').map(line => line.trim()).filter(Boolean);

	const config = (modelIds: string[]) => ({ type: props.info.type, ...fields(), models: modelIds });

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== 'object') {
				return;
			}
			if (data.type === 'error') {
				setBusy(false);
				setError(String(data.message ?? 'Unknown error'));
			} else if (data.type === 'result' && data.requestType === 'providers.save') {
				setSaved(true);
				setApiKey('');
				if (!props.info.manualModels) {
					vscode.postMessage({ type: 'providers.fetchModels', provider: props.info.type });
				} else {
					setBusy(false);
				}
			} else if (data.type === 'result' && data.requestType === 'providers.fetchModels') {
				setBusy(false);
				setModels(Array.isArray(data.data) ? data.data as Model[] : []);
			}
		};
		window.addEventListener('message', onMessage);
		onCleanup(() => window.removeEventListener('message', onMessage));
		if (initial && !props.info.manualModels) {
			setBusy(true);
			vscode.postMessage({ type: 'providers.fetchModels', provider: props.info.type });
		}
	});

	const save = (modelIds: string[]) => {
		setBusy(true);
		setError('');
		vscode.postMessage({ type: 'providers.save', config: config(modelIds), apiKey: apiKey() || undefined });
	};

	const connect = () => save(props.info.manualModels ? manualModels() : [...selected()]);

	const toggle = (id: string) => {
		const next = new Set(selected().size ? selected() : models().map(model => model.id));
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		setSelected(next.size === models().length ? new Set<string>() : next);
	};

	const missingRequired = () => props.info.fields.some(field => !field.optional && !fields()[field.id].trim())
		|| (props.info.key === 'required' && !apiKey() && !initial?.hasApiKey)
		|| (!!props.info.manualModels && !manualModels().length);

	return (
		<div class="lens-prov-editor">
			<button class="lens-prov-back" onClick={props.onClose}>← All providers</button>
			<div class="lens-prov-head">
				<span class="lens-prov-logo"><img src={logoUrl(props.info)} alt="" /></span>
				<h3 class="lens-prov-title">{props.info.name}</h3>
			</div>
			<div class="lens-prov-instructions lens-markdown" innerHTML={instructions()} />

			<For each={props.info.fields}>
				{field => (
					<>
						<label class="lens-conn-label" for={`lens-prov-${field.id}`}>{field.label}{field.optional ? ' (optional)' : ''}</label>
						<input
							id={`lens-prov-${field.id}`}
							class="lens-conn-input"
							placeholder={field.placeholder}
							value={fields()[field.id]}
							onInput={event => setFields({ ...fields(), [field.id]: event.currentTarget.value })}
							disabled={busy()}
						/>
					</>
				)}
			</For>

			<Show when={props.info.key !== 'none'}>
				<label class="lens-conn-label" for="lens-prov-key">{props.info.keyLabel ?? 'API key'}{props.info.key === 'optional' ? ' (optional)' : ''}</label>
				<input
					id="lens-prov-key"
					class="lens-conn-input"
					type="password"
					autocomplete="off"
					placeholder={initial?.hasApiKey ? 'Saved (leave empty to keep)' : 'Paste your key'}
					value={apiKey()}
					onInput={event => setApiKey(event.currentTarget.value)}
					disabled={busy()}
				/>
				<Show when={initial?.hasApiKey}>
					<p class="lens-conn-hint">Changing the endpoint removes the saved key; enter it again.</p>
				</Show>
			</Show>

			<Show when={props.info.manualModels}>
				<label class="lens-conn-label" for="lens-prov-models">{props.info.manualModels!.label}</label>
				<textarea
					id="lens-prov-models"
					class="lens-conn-input lens-prov-textarea"
					placeholder={props.info.manualModels!.placeholder}
					value={manual()}
					onInput={event => setManual(event.currentTarget.value)}
					disabled={busy()}
				/>
			</Show>

			<div class="lens-conn-actions">
				<button class="lens-conn-primary" disabled={busy() || missingRequired()} onClick={connect}>
					{busy() ? 'Working…' : saved() ? 'Save' : 'Connect'}
				</button>
			</div>
			<Show when={error()}>
				<p class="lens-conn-error">{error()}</p>
			</Show>

			<Show when={!props.info.manualModels && models().length}>
				<div class="lens-prov-models-head">
					<span class="lens-conn-title">Models</span>
					<span class="lens-conn-hint">None checked means all</span>
				</div>
				<ul class="lens-conn-models">
					<For each={models()}>
						{model => (
							<li>
								<label class="lens-conn-model">
									<input type="checkbox" checked={selected().size === 0 || selected().has(model.id)} onChange={() => toggle(model.id)} disabled={busy()} />
									<span>{model.name}</span>
								</label>
							</li>
						)}
					</For>
				</ul>
				<button class="lens-conn-primary" disabled={busy()} onClick={() => save([...selected()])}>Save models</button>
			</Show>
		</div>
	);
}
